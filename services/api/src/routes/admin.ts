import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuthContext } from '../auth/plugin';
import { bearerFrom } from '../auth/verify';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import type { Db, DbSession } from '../db/types';
import { parseLimit } from '../discovery/cards';
import { isoTimestamp } from '../db/sql';
import { decodeKeyset, encodeKeyset, keysetTime } from '../http/cursor';
import { isUuid, uuidParam } from '../http/params';
import type { StorageClient } from '../storage/client';

/**
 * The moderation backend — review L1 (and the queue B5 and B6 depend on).
 *
 * The ERD's M2 design (§14, §17): staff are existing auth identities with a
 * row in `admin_users` (migration 0029) and one or more roles. There is no
 * API to create staff; that is an operator action with the service role.
 *
 * EVERY admin route:
 *   1. requires a verified token (requireAuth),
 *   2. resolves the caller's own admin row (`admin.authorize`) — a member who
 *      is not staff gets 404, so the surface does not announce itself,
 *   3. requires a second factor (`aal2`) unless the row says otherwise — the
 *      default is that it is required (README §9.1),
 *   4. checks the role the action needs, and
 *   5. writes every decision WITH its `admin_action_audit` row, in one
 *      transaction. The audit is append-only for every role.
 *
 * NOT built here, and recorded rather than pretended: the admin web app (a
 * separate surface that needs hosting), PII-access logging per field
 * (ERD `pii_access_log`), cases, risk signals, and a `restrict` action whose
 * meaning the product has not defined.
 */

export interface AdminRoutesOptions {
  db: Db;
  storage: StorageClient;
}

type Role = 'moderator' | 'support' | 'admin';

interface Admin {
  id: string;
  roles: Role[];
}

const MODERATION = ['moderator', 'admin'] as const;
const SUPPORT = ['support', 'admin'] as const;

// A rejection reason is an i18n key the member's app renders (camelCase, e.g.
// `errors.photoRejected`). A report outcome is stored under the database's
// stricter lower-case shape (`reports_outcome_shape`).
const REASON_KEY = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_.]*$/)
  .max(100);
const OUTCOME_KEY = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/)
  .max(100);
const NOTE = z.string().trim().min(1).max(1000);

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reasonKey: REASON_KEY.optional(),
  note: NOTE.optional(),
});

// Review Phase 5 (L1): a rejection always carries the reason the member will
// be shown. Photos and profiles take an i18n `reasonKey` the member's app
// renders; a DOB correction is decided by support with a written `note`,
// which the member sees on their request.
const withReasonKey = decisionSchema.refine(
  (b) => b.decision === 'approve' || b.reasonKey !== undefined,
  { message: 'A rejection needs a reasonKey', path: ['reasonKey'] },
);
const withNote = decisionSchema.refine((b) => b.decision === 'approve' || b.note !== undefined, {
  message: 'A rejection needs a note',
  path: ['note'],
});

const reportDecisionSchema = z.object({
  status: z.enum(['triaged', 'actioned', 'dismissed']),
  outcomeKey: OUTCOME_KEY.optional(),
  note: NOTE.optional(),
});

const userActionSchema = z.object({
  action: z.enum(['warn', 'suspend', 'ban', 'clear']),
  // NOT NULL in the database too: an unexplained ban is unappealable.
  reason: NOTE,
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

const parseBody = <T>(schema: z.ZodType<T>, body: unknown, what: string): T => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw badRequest(
      `Invalid ${what}`,
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message])),
    );
  }
  return parsed.data;
};

async function audit(
  session: DbSession,
  admin: Admin,
  action: string,
  targetType: string,
  targetId: string,
  reason: string | undefined,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await session.query(
    `insert into public.admin_action_audit
       (admin_user_id, action, target_type, target_id, reason, metadata)
     values ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb)`,
    [admin.id, action, targetType, targetId, reason ?? null, JSON.stringify(metadata)],
  );
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (fastify, opts) => {
  const { db, storage } = opts;

  const requireAdmin = async (
    request: FastifyRequest,
    allowed: readonly Role[],
  ): Promise<Admin> => {
    const auth = requireAuthContext(request);
    const rows = await db.asService('admin.authorize', (session) =>
      session.query<{ id: string; mfa_required: boolean; roles: Role[] | null }>(
        `select a.id, a.mfa_required,
                array_agg(r.role_key) filter (
                  where r.role_key is not null
                    and (r.expires_at is null or r.expires_at > now())
                ) as roles
           from public.admin_users a
           join public.user_auth_links l on l.user_id = a.user_id
           left join public.admin_role_assignments r on r.admin_user_id = a.id
          where l.auth_user_id = $1::uuid and a.status = 'active'
          group by a.id, a.mfa_required`,
        [auth.authUserId],
      ),
    );
    const row = rows[0];
    // Not staff: the admin surface does not exist, as far as this caller knows.
    if (!row) throw notFound('Not found');
    if (row.mfa_required && auth.aal !== 'aal2') {
      throw forbidden('Two-factor authentication is required for staff');
    }
    const roles = row.roles ?? [];
    if (!roles.some((r) => r === 'admin' || allowed.includes(r))) {
      throw forbidden('Not permitted for this role');
    }
    return { id: row.id, roles };
  };

  const tokenOf = (request: FastifyRequest): string =>
    bearerFrom(request.headers.authorization) ?? '';

  // ===========================================================================
  // Photos (review B5)
  // ===========================================================================

  fastify.get('/admin/moderation/photos', { preHandler: fastify.requireAuth }, async (request) => {
    await requireAdmin(request, MODERATION);
    const limit = parseLimit((request.query as { limit?: string }).limit);
    const rows = await db.asService('admin.read_queue', (session) =>
      session.query<{
        id: string;
        user_id: string;
        storage_path: string;
        width: number | null;
        height: number | null;
        created_at: string;
      }>(
        // Finalized (server-written variants exist) and still pending:
        // oldest first, which `photos_moderation_queue_idx` serves.
        `select p.id, p.user_id, p.storage_path, p.width, p.height,
                  ${isoTimestamp('p.created_at')} as created_at
             from public.photos p
            where p.deleted_at is null
              and p.moderation_status = 'pending'
              and exists (select 1 from public.photo_variants v where v.photo_id = p.id)
            order by p.created_at, p.id
            limit $1`,
        [limit],
      ),
    );
    // Signed with the MODERATOR's own token. 0029's Storage policy lets an
    // active moderator with MFA read the photos bucket; nobody else can.
    const token = tokenOf(request);
    return {
      items: await Promise.all(
        rows.map(async (r) => ({
          photoId: r.id,
          userId: r.user_id,
          width: r.width,
          height: r.height,
          createdAt: r.created_at,
          url: await storage.createSignedUrl(token, r.storage_path),
        })),
      ),
    };
  });

  fastify.post(
    '/admin/moderation/photos/:photoId',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const admin = await requireAdmin(request, MODERATION);
      const photoId = uuidParam(request, 'photoId', 'photo id');
      const body = parseBody(withReasonKey, request.body, 'decision');
      const approve = body.decision === 'approve';

      return db.asService('admin.decide', async (session) => {
        const rows = await session.query<{ finalized: boolean }>(
          `select exists (select 1 from public.photo_variants v where v.photo_id = p.id) as finalized
             from public.photos p
            where p.id = $1::uuid and p.deleted_at is null
            for update`,
          [photoId],
        );
        if (!rows[0]) throw notFound('No such photo');
        if (!rows[0].finalized) throw conflict('This photo has not been uploaded yet');

        await session.query(
          `update public.photos
              set moderation_status = $2,
                  moderated_at = now(),
                  rejection_reason_key = $3,
                  -- A rejected photo cannot stay the main photo (B13).
                  is_primary = case when $2 = 'approved' then is_primary else false end
            where id = $1::uuid`,
          [
            photoId,
            approve ? 'approved' : 'rejected',
            approve ? null : (body.reasonKey ?? 'errors.photoRejected'),
          ],
        );
        await session.query(
          `insert into public.media_moderation_results
             (photo_id, provider, verdict, labels, reviewed_by_admin_id, reviewed_at)
           values ($1::uuid, 'human', $2, $3::jsonb, $4::uuid, now())`,
          [photoId, approve ? 'approved' : 'rejected', JSON.stringify({}), admin.id],
        );
        await audit(
          session,
          admin,
          approve ? 'photo.approve' : 'photo.reject',
          'photo',
          photoId,
          body.note,
          {
            ...(body.reasonKey ? { reasonKey: body.reasonKey } : {}),
          },
        );
        return { photoId, moderationStatus: approve ? 'approved' : 'rejected' };
      });
    },
  );

  // ===========================================================================
  // Profiles (review B6)
  // ===========================================================================

  fastify.get(
    '/admin/moderation/profiles',
    { preHandler: fastify.requireAuth },
    async (request) => {
      await requireAdmin(request, MODERATION);
      const limit = parseLimit((request.query as { limit?: string }).limit);
      const rows = await db.asService('admin.read_queue', (session) =>
        session.query<{
          user_id: string;
          display_name: string | null;
          about_me: string | null;
          looking_for: string | null;
          institution: string | null;
          family_background: string | null;
          submitted_at: string | null;
        }>(
          // The free text a moderator judges, and the name. No contact
          // details, no date of birth, no location.
          `select p.user_id, u.display_name, p.about_me, p.looking_for,
                  p.institution, p.family_background,
                  ${isoTimestamp('p.submitted_at')} as submitted_at
             from public.profiles p
             join public.users u on u.id = p.user_id
            where p.review_status = 'pending'
              and p.submitted_at is not null
              and p.deleted_at is null
              and u.deleted_at is null
            order by p.submitted_at, p.user_id
            limit $1`,
          [limit],
        ),
      );
      return {
        items: rows.map((r) => ({
          userId: r.user_id,
          displayName: r.display_name,
          aboutMe: r.about_me,
          lookingFor: r.looking_for,
          institution: r.institution,
          familyBackground: r.family_background,
          submittedAt: r.submitted_at,
        })),
      };
    },
  );

  fastify.post(
    '/admin/moderation/profiles/:userId',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const admin = await requireAdmin(request, MODERATION);
      const userId = uuidParam(request, 'userId', 'user id');
      const body = parseBody(withReasonKey, request.body, 'decision');
      const approve = body.decision === 'approve';

      return db.asService('admin.decide', async (session) => {
        const updated = await session.query<{ user_id: string }>(
          `update public.profiles
              set review_status = $2, reviewed_at = now(), rejection_reason_key = $3
            where user_id = $1::uuid and submitted_at is not null and deleted_at is null
            returning user_id`,
          [
            userId,
            approve ? 'approved' : 'rejected',
            approve ? null : (body.reasonKey ?? 'errors.profileRejected'),
          ],
        );
        if (!updated[0]) throw notFound('No submitted profile for this member');
        if (approve) {
          // The `profile_reviewed` badge reads this.
          await session.query(
            `update public.verification_status set profile_reviewed_at = coalesce(profile_reviewed_at, now())
              where user_id = $1::uuid`,
            [userId],
          );
        }
        await audit(
          session,
          admin,
          approve ? 'profile.approve' : 'profile.reject',
          'profile',
          userId,
          body.note,
          {
            ...(body.reasonKey ? { reasonKey: body.reasonKey } : {}),
          },
        );
        return { userId, reviewStatus: approve ? 'approved' : 'rejected' };
      });
    },
  );

  // ===========================================================================
  // Reports (L1: "reports are stored but nobody can read or act on them")
  // ===========================================================================

  fastify.get('/admin/reports', { preHandler: fastify.requireAuth }, async (request) => {
    await requireAdmin(request, MODERATION);
    const query = request.query as { status?: string; limit?: string };
    const status = query.status ?? 'open';
    if (!['open', 'triaged', 'actioned', 'dismissed'].includes(status)) {
      throw badRequest('Invalid status');
    }
    const limit = parseLimit(query.limit);
    const rows = await db.asService('admin.read_queue', (session) =>
      session.query<{
        id: string;
        reporter_user_id: string;
        reported_user_id: string;
        category: string;
        description: string | null;
        context_type: string | null;
        context_id: string | null;
        status: string;
        created_at: string;
      }>(
        `select r.id, r.reporter_user_id, r.reported_user_id, r.category, r.description,
                r.context_type, r.context_id, r.status, ${isoTimestamp('r.created_at')} as created_at
           from public.reports r
          where r.status = $1
          order by r.created_at, r.id
          limit $2`,
        [status, limit],
      ),
    );
    return {
      items: rows.map((r) => ({
        reportId: r.id,
        reporterUserId: r.reporter_user_id,
        reportedUserId: r.reported_user_id,
        category: r.category,
        description: r.description,
        contextType: r.context_type,
        contextId: r.context_id,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });

  fastify.post('/admin/reports/:reportId', { preHandler: fastify.requireAuth }, async (request) => {
    const admin = await requireAdmin(request, MODERATION);
    const reportId = uuidParam(request, 'reportId', 'report id');
    const body = parseBody(reportDecisionSchema, request.body, 'report decision');
    const resolved = body.status === 'actioned' || body.status === 'dismissed';

    return db.asService('admin.decide', async (session) => {
      const updated = await session.query<{ reporter_user_id: string }>(
        `update public.reports
              set status = $2, outcome_key = $3,
                  resolved_at = case when $4::boolean then now() else null end
            where id = $1::uuid
            returning reporter_user_id`,
        [reportId, body.status, body.outcomeKey ?? null, resolved],
      );
      if (!updated[0]) throw notFound('No such report');
      // The reporter is promised the outcome (ERD §14). Identifiers only.
      if (resolved) {
        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
             values ($1::uuid, 'report_update', $2::jsonb, $3)
             on conflict do nothing`,
          [
            updated[0].reporter_user_id,
            JSON.stringify({ reportId, status: body.status }),
            `report_update:${reportId}:${body.status}`,
          ],
        );
      }
      await audit(session, admin, `report.${body.status}`, 'report', reportId, body.note, {
        ...(body.outcomeKey ? { outcomeKey: body.outcomeKey } : {}),
      });
      return { reportId, status: body.status };
    });
  });

  // ===========================================================================
  // Account actions: warn, suspend, ban, clear
  // ===========================================================================

  fastify.post(
    '/admin/users/:userId/actions',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const admin = await requireAdmin(request, MODERATION);
      const userId = uuidParam(request, 'userId', 'user id');
      const body = parseBody(userActionSchema, request.body, 'action');

      const result = await db.asService('admin.decide', async (session) => {
        const exists = await session.query<{ status: string }>(
          `select status from public.users where id = $1::uuid and deleted_at is null for update`,
          [userId],
        );
        if (!exists[0]) throw notFound('No such member');

        await session.query(
          `insert into public.moderation_actions
             (subject_user_id, actor_admin_id, action, reason, expires_at)
           values ($1::uuid, $2::uuid, $3, $4, $5::timestamptz)`,
          [userId, admin.id, body.action, body.reason, body.expiresAt ?? null],
        );

        // `can_view_profile` already hides suspended and banned members, so a
        // status change is what takes effect everywhere at once. `clear`
        // restores only an account a moderator had restricted.
        let status = exists[0].status;
        if (body.action === 'suspend' || body.action === 'ban') {
          status = body.action === 'suspend' ? 'suspended' : 'banned';
          await session.query(`update public.users set status = $2 where id = $1::uuid`, [
            userId,
            status,
          ]);
        } else if (body.action === 'clear' && (status === 'suspended' || status === 'banned')) {
          status = 'active';
          await session.query(`update public.users set status = 'active' where id = $1::uuid`, [
            userId,
          ]);
        }

        await audit(session, admin, `user.${body.action}`, 'user', userId, body.reason, {
          ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        });
        return { userId, action: body.action, status };
      });
      return reply.code(201).send(result);
    },
  );

  // ===========================================================================
  // Date-of-birth corrections (review B6, company decision 4)
  // ===========================================================================

  fastify.get('/admin/dob-corrections', { preHandler: fastify.requireAuth }, async (request) => {
    await requireAdmin(request, SUPPORT);
    const limit = parseLimit((request.query as { limit?: string }).limit);
    const rows = await db.asService('admin.read_queue', (session) =>
      session.query<{
        id: string;
        user_id: string;
        current_dob: string | null;
        requested_dob: string;
        reason: string;
        created_at: string;
      }>(
        `select d.id, d.user_id, d.current_dob::text as current_dob,
                  d.requested_dob::text as requested_dob, d.reason,
                  ${isoTimestamp('d.created_at')} as created_at
             from public.dob_correction_requests d
            where d.status = 'pending'
            order by d.created_at, d.id
            limit $1`,
        [limit],
      ),
    );
    return {
      items: rows.map((r) => ({
        requestId: r.id,
        userId: r.user_id,
        currentDob: r.current_dob,
        requestedDob: r.requested_dob,
        reason: r.reason,
        createdAt: r.created_at,
      })),
    };
  });

  fastify.post(
    '/admin/dob-corrections/:requestId',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const admin = await requireAdmin(request, SUPPORT);
      const requestId = uuidParam(request, 'requestId', 'request id');
      const body = parseBody(withNote, request.body, 'decision');
      const approve = body.decision === 'approve';

      return db.asService('admin.decide', async (session) => {
        const rows = await session.query<{
          user_id: string;
          status: string;
          requested_dob: string;
        }>(
          `select user_id, status, requested_dob::text as requested_dob
             from public.dob_correction_requests where id = $1::uuid for update`,
          [requestId],
        );
        const row = rows[0];
        if (!row) throw notFound('No such request');
        if (row.status !== 'pending') throw conflict('This request has already been decided');

        if (approve) {
          // The service role may change a locked date of birth (0029); the
          // age gate (0003) still applies and refuses an under-18 result.
          await session.query(
            `update public.users set date_of_birth = $2::date where id = $1::uuid`,
            [row.user_id, row.requested_dob],
          );
        }
        await session.query(
          `update public.dob_correction_requests
              set status = $2, decided_by_admin_id = $3::uuid, decided_at = now(), decision_note = $4
            where id = $1::uuid`,
          [requestId, approve ? 'approved' : 'rejected', admin.id, body.note ?? null],
        );
        await audit(
          session,
          admin,
          approve ? 'dob.approve' : 'dob.reject',
          'user',
          row.user_id,
          body.note,
          {
            requestId,
            ...(approve ? { requestedDob: row.requested_dob } : {}),
          },
        );
        return { requestId, status: approve ? 'approved' : 'rejected' };
      });
    },
  );

  // ===========================================================================
  // Review Phase 5 (L1): what the admin screens need to know about the caller,
  // and the audit trail. Both behind the same gate as every route above.
  // ===========================================================================

  /**
   * The caller's own staff identity and roles, so the admin interface shows
   * only the areas the API will let them use. Grants nothing: every action
   * route checks the role again. A non-staff caller gets 404, an aal1 caller
   * with MFA required gets 403 — the screens use those to route to sign-in or
   * to the second-factor step.
   */
  fastify.get('/admin/session', { preHandler: fastify.requireAuth }, async (request) => {
    const admin = await requireAdmin(request, ['moderator', 'support', 'admin']);
    const rows = await db.asService('admin.authorize', (session) =>
      session.query<{ mfa_required: boolean }>(
        `select a.mfa_required from public.admin_users a where a.id = $1::uuid`,
        [admin.id],
      ),
    );
    return {
      adminUserId: admin.id,
      roles: admin.roles,
      mfaRequired: rows[0]?.mfa_required ?? true,
    };
  });

  /**
   * The append-only audit trail (ERD §17), newest first, keyset-paged.
   * Filterable by target, which is how a moderator reads one member's history
   * of decisions. Any staff role may read it; it names the acting staff
   * member and carries the reason they gave.
   */
  fastify.get('/admin/audit', { preHandler: fastify.requireAuth }, async (request) => {
    await requireAdmin(request, ['moderator', 'support', 'admin']);
    const query = request.query as {
      targetType?: string;
      targetId?: string;
      cursor?: string;
      limit?: string;
    };
    const limit = parseLimit(query.limit);
    if (query.targetType !== undefined && !/^[a-z_]{1,40}$/.test(query.targetType)) {
      throw badRequest('Invalid targetType');
    }
    if (query.targetId !== undefined && !isUuid(query.targetId)) {
      throw badRequest('Invalid targetId');
    }
    const after = decodeKeyset(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const rows = await db.asService('admin.read_queue', (session) =>
      session.query<{
        id: string;
        action: string;
        target_type: string;
        target_id: string;
        reason: string | null;
        metadata: Record<string, unknown>;
        created_at: string;
        cursor_at: string;
        admin_user_id: string;
        display_name: string | null;
      }>(
        `select a.id, a.action, a.target_type, a.target_id, a.reason, a.metadata,
                ${isoTimestamp('a.created_at')} as created_at,
                ${keysetTime('a.created_at')} as cursor_at,
                a.admin_user_id, u.display_name
           from public.admin_action_audit a
           join public.admin_users s on s.id = a.admin_user_id
           left join public.users u on u.id = s.user_id
          where ($1::text is null or a.target_type = $1)
            and ($2::uuid is null or a.target_id = $2::uuid)
            and ($3::timestamptz is null or (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
          order by a.created_at desc, a.id desc
          limit ${limit + 1}`,
        [query.targetType ?? null, query.targetId ?? null, after?.at ?? null, after?.id ?? null],
      ),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        metadata: r.metadata,
        createdAt: r.created_at,
        actor: { adminUserId: r.admin_user_id, displayName: r.display_name },
      })),
      nextCursor: hasMore && last ? encodeKeyset({ at: last.cursor_at, id: last.id }) : null,
      hasMore,
    };
  });
};
