import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_LOCALE,
  LOCALES,
  bootstrapRequestSchema,
  userSettingsUpdateSchema,
  type Locale,
  type Me,
} from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, conflict, notFound } from '../errors';
import { isoTimestamp } from '../db/sql';
import type { Db, DbSession } from '../db/types';
import { requireEntitlement } from '../entitlements/service';

/**
 * Account routes: bootstrap, read and update.
 *
 * Mirrors the Account section of docs/openapi.yaml.
 */

interface MeRow {
  id: string;
  display_name: string | null;
  status: Me['status'];
  onboarding_step: string | null;
  profile_completed_at: string | null;
  locale: string;
  timezone: string;
  show_online_status: boolean;
  send_read_receipts: boolean;
  incognito: boolean;
  discovery_paused: boolean;
  communication_policy: Me['communicationPolicy'];
  family_reviewers_count: number;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  selfie_verified_at: string | null;
  id_verified_at: string | null;
  profile_reviewed_at: string | null;
}

const ME_SELECT = `
  select u.id, u.display_name, u.status, u.onboarding_step, u.profile_completed_at,
         s.locale, s.timezone, s.show_online_status, s.send_read_receipts,
         -- EFFECTIVE incognito (review B3): on AND currently entitled. A
         -- member whose subscription lapsed is visible to discovery again,
         -- and reporting the stored flag would tell them otherwise.
         (s.incognito and app.has_entitlement_flag(u.id, 'incognito')) as incognito,
         s.discovery_paused, s.communication_policy,
         v.email_verified_at, v.phone_verified_at, v.selfie_verified_at,
         v.id_verified_at, v.profile_reviewed_at,
         -- Counted here rather than in a second round trip: the app must warn
         -- about a gate with nobody behind it AT THE MOMENT the policy is set,
         -- and a count the client has to remember to ask for is a warning that
         -- will eventually not be shown.
         (
           select count(*)::int
             from public.family_relationships r
             join public.family_permissions fp on fp.relationship_id = r.id
            where r.owner_user_id = u.id
              and r.status = 'active'
              and fp.permission = 'approve_communication'
              and fp.granted
         ) as family_reviewers_count
  from public.users u
  join public.user_settings s on s.user_id = u.id
  join public.verification_status v on v.user_id = u.id
`;

/**
 * Narrows a stored locale to one the product actually ships.
 *
 * The column is a language-tag shape rather than an enum, so it still holds
 * `ur` for anyone who chose Urdu before the app became English-only. Returning
 * it would hand the client a locale with no catalog behind it, so it reads as
 * English instead. The stored value is left alone; this is a read-time
 * narrowing, not a migration.
 */
function toLocale(stored: string): Locale {
  return (LOCALES as readonly string[]).includes(stored) ? (stored as Locale) : DEFAULT_LOCALE;
}

function toMe(row: MeRow): Me {
  return {
    userId: row.id,
    displayName: row.display_name,
    status: row.status,
    onboardingStep: row.onboarding_step,
    profileCompleted: row.profile_completed_at !== null,
    locale: toLocale(row.locale),
    timezone: row.timezone,
    showOnlineStatus: row.show_online_status,
    sendReadReceipts: row.send_read_receipts,
    incognito: row.incognito,
    discoveryPaused: row.discovery_paused,
    communicationPolicy: row.communication_policy,
    familyReviewersCount: row.family_reviewers_count,
    verification: {
      emailVerified: row.email_verified_at !== null,
      phoneVerified: row.phone_verified_at !== null,
      // Exposed as booleans only. The timestamps, and the artefacts behind
      // them, never leave the server.
      selfieVerified: row.selfie_verified_at !== null,
      idVerified: row.id_verified_at !== null,
      profileReviewed: row.profile_reviewed_at !== null,
    },
  };
}

async function loadMe(session: DbSession, userId: string): Promise<Me | null> {
  const rows = await session.query<MeRow>(`${ME_SELECT} where u.id = $1`, [userId]);
  const row = rows[0];
  return row ? toMe(row) : null;
}

export interface AccountRoutesOptions {
  db: Db;
}

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (fastify, { db }) => {
  /**
   * POST /account/bootstrap
   *
   * Idempotent. Runs as service_role because `users` has no INSERT policy by
   * design: a client able to insert its own row could choose its own status.
   * The JWT has already been verified at this point, so the subject is trusted;
   * nothing from the request body identifies the account.
   */
  fastify.post(
    '/account/bootstrap',
    { preHandler: fastify.requireIdentity },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const parsed = bootstrapRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid bootstrap request',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }
      const body = parsed.data;

      const result = await db.asService('account.bootstrap', async (session) => {
        // REVIEW B19. Two first launches at once (a double tap, two tabs)
        // both found no link, both created a user, and one then failed on the
        // unique link with a 500. A transaction-scoped advisory lock on the
        // auth identity serialises them: the second waits, then finds the
        // first one's link below and returns the same account. No orphan
        // `users` row is created, which `on conflict do nothing` on the link
        // alone would have left behind. Released at commit or rollback.
        await session.query(`select pg_advisory_xact_lock(hashtext('account.bootstrap:' || $1))`, [
          auth.authUserId,
        ]);

        const existing = await session.query<{ user_id: string }>(
          `select user_id from public.user_auth_links where auth_user_id = $1`,
          [auth.authUserId],
        );

        if (existing[0]) {
          const me = await loadMe(session, existing[0].user_id);
          if (!me) {
            // An auth link with no account behind it means a half-finished
            // bootstrap. Surfacing it is better than silently repairing it.
            throw notFound('Account record is incomplete');
          }
          return { me, created: false };
        }

        const inserted = await session.query<{ id: string }>(
          `insert into public.users (status) values ('onboarding') returning id`,
        );
        const userId = inserted[0]!.id;

        await session.query(
          `insert into public.user_auth_links (user_id, auth_user_id, provider)
           values ($1, $2, $3)`,
          [userId, auth.authUserId, auth.email ? 'email' : 'phone'],
        );

        await session.query(
          `insert into public.user_settings (user_id, locale, timezone) values ($1, $2, $3)`,
          [userId, body.locale, body.timezone],
        );

        await session.query(`insert into public.verification_status (user_id) values ($1)`, [
          userId,
        ]);

        if (body.deviceId && body.platform) {
          await session.query(
            `insert into public.user_devices (user_id, device_id, platform)
             values ($1, $2, $3)
             on conflict (user_id, device_id) do update set last_seen_at = now()`,
            [userId, body.deviceId, body.platform],
          );
        }

        const me = await loadMe(session, userId);
        if (!me) throw notFound('Account record is incomplete');
        return { me, created: true };
      });

      return reply.code(result.created ? 201 : 200).send(result.me);
    },
  );

  /**
   * GET /me
   *
   * Runs as the caller, so RLS is the thing deciding what comes back. A bug in
   * this handler cannot widen it.
   */
  fastify.get('/me', { preHandler: fastify.requireIdentity }, async (request) => {
    const auth = requireAuthContext(request);

    const me = await db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<MeRow>(ME_SELECT);
      const row = rows[0];
      return row ? toMe(row) : null;
    });

    if (!me) {
      // Valid token, no account. The client should call bootstrap.
      throw notFound('No account for this session. Call /account/bootstrap first.');
    }
    return me;
  });

  /** PATCH /me — locale, timezone and display settings. */
  fastify.patch('/me', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const parsed = userSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Invalid settings update',
        Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
        ),
      );
    }
    const patch = parsed.data;

    if (Object.keys(patch).length === 0) {
      throw badRequest('No settings supplied');
    }

    // REVIEW B3. Incognito is a paid entitlement (FREE_PLAN_ENTITLEMENTS has
    // it false), and before this it could be switched on by anyone. Checked
    // here so the client gets `entitlement_required` and can offer the
    // upgrade; migration 0026 enforces the same rule in a trigger, which is
    // what stops a member setting it through the Data API instead.
    //
    // Only switching it ON is gated. Switching it off never is, so a member
    // whose entitlement lapsed is never trapped in a setting.
    if (patch.incognito === true) {
      const userId = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<{ user_id: string | null }>(
          `select app.current_user_id() as user_id`,
        );
        return rows[0]?.user_id ?? null;
      });
      if (!userId) throw notFound('No account for this session');
      await requireEntitlement(db, auth.authUserId, userId, 'incognito');
    }

    return db.asUser(auth.authUserId, async (session) => {
      // Column names come from a fixed map, never from request keys — the
      // schema has already stripped anything unknown, but building SQL
      // identifiers from input is not a habit worth having.
      const columns: Record<keyof typeof patch, string> = {
        locale: 'locale',
        timezone: 'timezone',
        showOnlineStatus: 'show_online_status',
        sendReadReceipts: 'send_read_receipts',
        incognito: 'incognito',
        discoveryPaused: 'discovery_paused',
        communicationPolicy: 'communication_policy',
      };

      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = patch[key as keyof typeof patch];
        if (value !== undefined) {
          params.push(value);
          assignments.push(`${column} = $${params.length}`);
        }
      }

      const updated = await session.query(
        // REVIEW B22. Scoped to the caller here as well as by RLS. The policy
        // alone limited this to one row; run under any broader role it would
        // have updated every member's settings.
        `update public.user_settings set ${assignments.join(', ')}
          where user_id = app.current_user_id()
          returning user_id`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params as any[],
      );

      if (updated.length === 0) {
        throw notFound('No account for this session');
      }

      const rows = await session.query<MeRow>(ME_SELECT);
      const row = rows[0];
      if (!row) throw notFound('No account for this session');
      return toMe(row);
    });
  });

  // ===========================================================================
  // Date-of-birth corrections — review B6, company decision 4
  //
  // Once a profile is complete its date of birth is locked (0029), because an
  // age nobody reviewed is an age nobody can trust. A genuine mistake is
  // corrected by asking: support verifies it and decides
  // (POST /admin/dob-corrections/:id), and the decision is audited.
  // ===========================================================================

  const dobCorrectionSchema = z.object({
    requestedDob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      // A real calendar date, checked here: Postgres would refuse 2020-02-30
      // with an error the caller did not deserve as a 500.
      .refine((value) => {
        const d = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
      }, 'Not a real date'),
    reason: z.string().trim().min(10).max(1000),
  });

  fastify.post(
    '/me/dob-correction-requests',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const parsed = dobCorrectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid correction request',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }
      const { requestedDob, reason } = parsed.data;

      const created = await db.asUser(auth.authUserId, async (session) => {
        const me = await session.query<{ completed: boolean; dob: string | null }>(
          `select profile_completed_at is not null as completed, date_of_birth::text as dob
             from public.users where id = app.current_user_id()`,
        );
        if (!me[0]) throw notFound('No account for this session');
        if (!me[0].completed) {
          throw conflict('Your date of birth can still be changed in your profile');
        }
        if (me[0].dob === requestedDob) throw badRequest('That is already your date of birth');

        const open = await session.query<{ id: string }>(
          `select id from public.dob_correction_requests
            where user_id = app.current_user_id() and status = 'pending'`,
        );
        if (open.length > 0) throw conflict('A correction request is already open');

        // Runs as the member: RLS pins user_id to the caller and status to
        // pending, and the column grant offers nothing else to set.
        const rows = await session.query<{
          id: string;
          status: string;
          requested_dob: string;
          created_at: string;
        }>(
          `insert into public.dob_correction_requests (user_id, requested_dob, reason)
           values (app.current_user_id(), $1::date, $2)
           returning id, status, requested_dob::text as requested_dob, ${isoTimestamp('created_at')} as created_at`,
          [requestedDob, reason],
        );
        return rows[0]!;
      });

      return reply.code(201).send({
        requestId: created.id,
        status: created.status,
        requestedDob: created.requested_dob,
        createdAt: created.created_at,
      });
    },
  );

  fastify.get(
    '/me/dob-correction-requests',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const rows = await db.asUser(auth.authUserId, (session) =>
        session.query<{
          id: string;
          status: string;
          requested_dob: string;
          decision_note: string | null;
          decided_at: string | null;
          created_at: string;
        }>(
          `select d.id, d.status, d.requested_dob::text as requested_dob, d.decision_note,
                  ${isoTimestamp('d.decided_at')} as decided_at, ${isoTimestamp('d.created_at')} as created_at
             from public.dob_correction_requests d
            order by d.created_at desc`,
        ),
      );
      return {
        items: rows.map((r) => ({
          requestId: r.id,
          status: r.status,
          requestedDob: r.requested_dob,
          decisionNote: r.decision_note,
          decidedAt: r.decided_at,
          createdAt: r.created_at,
        })),
      };
    },
  );
};
