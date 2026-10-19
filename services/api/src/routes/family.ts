import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  INVITATION_TTL_DAYS,
  REVIEW_SLA_HOURS,
  createInvitationSchema,
  decideReviewSchema,
  isGrantablePermission,
  permissionsForTier,
  respondToInvitationSchema,
  revokeReviewSchema,
  updatePermissionsSchema,
  type FamilyPermission,
} from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, conflict, notFound } from '../errors';
import { decodeCursor, encodeCursor, parseLimit } from '../discovery/cards';
import type { Db, DbSession } from '../db/types';

/**
 * Family / Wali — the review layer (Phase 6b, ADR 0011, D12).
 *
 * Mirrors the Family / Wali section of docs/openapi.yaml.
 *
 * THERE IS NO DIRECTORY, and that shapes every read here. A delegate holding
 * `approve_communication` can open ONE match they have been asked about and
 * see an enumerated packet about the counterpart. They cannot search, cannot
 * browse, and cannot list people. Every packet read re-applies
 * `app.can_review_match()`, which takes one match id and returns a boolean —
 * there is no form of the question that yields a set of people, so the right
 * cannot be turned into a feed.
 *
 * THE OWNER NEVER APPROVES THEIR OWN MATCH (D12 row 2). This route refuses it
 * and so does the database (`family_reviews_decider_not_owner`), because that
 * asymmetry is the only thing that makes an approval worth anything. The
 * owner's escape hatches need nobody's agreement: change the policy, revoke
 * the delegate, or ask again after a rejection.
 *
 * NOT-FOUND, NEVER FORBIDDEN, as everywhere else. A 403 would confirm that a
 * match, a relationship or an invitation exists.
 *
 * EVERY DELEGATED READ IS LOGGED, with the permission that authorised it. The
 * log is the owner's, not the delegate's — a delegate who could see what the
 * owner has been shown would know what is safe to do unobserved.
 */

export interface FamilyRoutesOptions {
  db: Db;
}

const TOKEN_BYTES = 24;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface MemberRow {
  id: string;
  delegate_user_id: string | null;
  relationship_code: string;
  tier: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
  permissions: string[] | null;
  position: number;
}

interface ReviewRow {
  match_id: string;
  owner_user_id: string;
  decision: string;
  requested_at: string;
  position: number;
}

export const familyRoutes: FastifyPluginAsync<FamilyRoutesOptions> = async (fastify, { db }) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  /**
   * Appends to the owner's access log.
   *
   * Deliberately NOT inside the transaction that performs the action. An
   * audit write that can roll back with the thing it audits is an audit that
   * disappears exactly when something went wrong, and a failure to log must
   * never be a reason the owner's own action fails.
   */
  const recordAccess = async (entry: {
    relationshipId: string;
    delegateUserId: string;
    ownerUserId: string;
    action: string;
    permission: FamilyPermission;
    resourceType?: string;
    resourceId?: string;
  }): Promise<void> => {
    try {
      await db.asService('family.record_access', (session) =>
        session.query(
          `insert into public.family_access_log
             (relationship_id, delegate_user_id, owner_user_id, action, permission,
              resource_type, resource_id)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)`,
          [
            entry.relationshipId,
            entry.delegateUserId,
            entry.ownerUserId,
            entry.action,
            entry.permission,
            entry.resourceType ?? null,
            entry.resourceId ?? null,
          ],
        ),
      );
    } catch (error) {
      fastify.log.error({ err: error, action: entry.action }, 'family access log write failed');
    }
  };

  /**
   * Warns owners whose reviews have sat past the SLA (D12-g).
   *
   * 72 hours, NOTIFY ONLY. No decision changes and none can: there is no
   * `expired` value, because a delegate's silence must not become consent and
   * their delay must not become a veto.
   *
   * Swept on read rather than on a schedule. pg-boss was deferred (ADR 0007),
   * so there is no runner; a sweep that depends on infrastructure nobody has
   * built is a control that never fires. `sla_notified_at` makes it idempotent
   * under concurrent readers, and the whole thing is best-effort — a failure
   * here must never stop an owner seeing their own family screen.
   */
  const sweepStalledReviews = async (ownerUserId: string): Promise<void> => {
    try {
      await db.asService('family.notify_stalled', async (session) => {
        const stalled = await session.query<{ id: string; match_id: string }>(
          `update public.family_reviews
              set sla_notified_at = now()
            where owner_user_id = $1::uuid
              and decision in ('pending', 'more_info_requested')
              and sla_notified_at is null
              and requested_at < now() - make_interval(hours => $2::int)
          returning id, match_id`,
          [ownerUserId, REVIEW_SLA_HOURS],
        );

        for (const row of stalled) {
          await session.query(
            `insert into public.notifications (user_id, type, payload, dedupe_key)
             values ($1::uuid, 'family_review_stalled', $2::jsonb, $3)
             on conflict do nothing`,
            [
              ownerUserId,
              JSON.stringify({ matchId: row.match_id, slaHours: REVIEW_SLA_HOURS }),
              `family_review_stalled:${row.id}`,
            ],
          );
        }
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'review SLA sweep failed');
    }
  };

  // --- GET /family/members ---------------------------------------------------

  /**
   * My family members and exactly what each one holds.
   *
   * Permissions are listed as ROWS, never derived from the tier. The tier is a
   * label the invite UI used once; showing the owner a tier's preset instead
   * of their actual grants would tell them they had revoked something they
   * had not.
   */
  fastify.get('/family/members', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const { page, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<MemberRow>(
        `select id, delegate_user_id, relationship_code, tier, status,
                created_at, revoked_at, permissions, position
           from (
             select r.*,
                    (
                      select array_agg(p.permission order by p.permission)
                        from public.family_permissions p
                       where p.relationship_id = r.id and p.granted
                    ) as permissions,
                    (row_number() over (order by r.created_at desc, r.id))::int - 1 as position
               from public.family_relationships r
              where r.owner_user_id = app.current_user_id()
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      );
      return { page: rows, viewerUserId: await resolveViewer(session) };
    });

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    if (rows.length === 0 || !viewerUserId) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Names come from `users`, which is owner-only, so this is the same shape
    // as the block list: confined by a join FROM the caller's own rows.
    const ids = rows.map((r) => r.delegate_user_id).filter((id): id is string => id !== null);
    const names = await db.asService('family.manage_relationship', async (session) => {
      if (ids.length === 0) return new Map<string, string | null>();
      const found = await session.query<{ id: string; display_name: string | null }>(
        `select u.id, u.display_name
           from public.users u
           join public.family_relationships r on r.delegate_user_id = u.id
          where r.owner_user_id = $1::uuid and u.id = any($2::uuid[])`,
        [viewerUserId, ids],
      );
      return new Map(found.map((r) => [r.id, r.display_name]));
    });

    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.delegate_user_id,
        displayName: row.delegate_user_id ? (names.get(row.delegate_user_id) ?? null) : null,
        relationshipCode: row.relationship_code,
        tier: row.tier,
        status: row.status,
        permissions: row.permissions ?? [],
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- POST /family/invitations ----------------------------------------------

  /**
   * Invite someone, with a tier and the grants it expands to.
   *
   * The token is generated here, returned ONCE, and stored only as a sha-256
   * digest. A readable invitation table is a list of ways into other people's
   * family graphs.
   */
  fastify.post(
    '/family/invitations',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const parsed = createInvitationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid invitation',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }
      const body = parsed.data;

      const ownerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!ownerUserId) throw notFound('No account for this session');

      const token = randomBytes(TOKEN_BYTES).toString('base64url');

      const created = await db.asService('family.invite', async (session) => {
        // One live invitation per (owner, contact) — the partial unique index
        // refuses a second. Surfaced as 409 rather than letting the constraint
        // surface as a 500: re-inviting someone you already invited is a
        // reasonable mistake and deserves a reasonable answer.
        const existing = await session.query<{ id: string }>(
          `select id from public.family_invitations
          where owner_user_id = $1::uuid and invitee_contact = $2 and status = 'pending'`,
          [ownerUserId, body.inviteeContact],
        );
        if (existing.length > 0) return null;

        const rows = await session.query<{
          id: string;
          invitee_contact: string;
          relationship_code: string;
          tier: string;
          status: string;
          expires_at: string;
          created_at: string;
          responded_at: string | null;
        }>(
          `insert into public.family_invitations
           (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at)
         values ($1::uuid, $2, $3, $4, $5, now() + make_interval(days => $6::int))
         returning id, invitee_contact, relationship_code, tier, status,
                   expires_at, created_at, responded_at`,
          [
            ownerUserId,
            body.inviteeContact,
            body.relationshipCode,
            body.tier,
            hashToken(token),
            INVITATION_TTL_DAYS,
          ],
        );
        return rows[0] ?? null;
      });

      if (!created) throw conflict('An invitation to this contact is already pending');

      reply.code(201);
      return {
        id: created.id,
        inviteeContact: created.invitee_contact,
        relationshipCode: created.relationship_code,
        tier: created.tier,
        status: created.status,
        expiresAt: created.expires_at,
        createdAt: created.created_at,
        respondedAt: created.responded_at,
        // Once. It is a digest from here on.
        token,
      };
    },
  );

  // --- GET /family/invitations -----------------------------------------------

  fastify.get('/family/invitations', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    return db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<{
        id: string;
        invitee_contact: string;
        relationship_code: string;
        tier: string;
        status: string;
        expires_at: string;
        created_at: string;
        responded_at: string | null;
      }>(
        `select id, invitee_contact, relationship_code, tier, status,
                expires_at, created_at, responded_at
           from public.family_invitations
          where owner_user_id = app.current_user_id()
          order by created_at desc
          limit 100`,
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          inviteeContact: row.invitee_contact,
          relationshipCode: row.relationship_code,
          tier: row.tier,
          // Expiry is reported, not stored late: a pending row past its date
          // is expired whether or not a sweeper has been along.
          status:
            row.status === 'pending' && new Date(row.expires_at) < new Date()
              ? 'expired'
              : row.status,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          respondedAt: row.responded_at,
        })),
        nextCursor: null,
        hasMore: false,
      };
    });
  });

  // --- POST /family/invitations/:id/respond -----------------------------------

  /**
   * Accept or decline, by presenting the token.
   *
   * The token is the authorization, not the session: an invitation goes to a
   * contact address, and whoever holds the link is who was invited. The
   * session still has to exist, because a relationship needs two accounts.
   *
   * Accepting writes the relationship AND its tier-preset grants in one
   * transaction. A relationship without grants is a delegate who exists and
   * can do nothing, which looks to the owner like a right that silently
   * fails.
   */
  fastify.post(
    '/family/invitations/:id/respond',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const { id } = request.params as { id: string };
      const parsed = respondToInvitationSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid response');
      const { token, accept } = parsed.data;

      const inviteeUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!inviteeUserId) throw notFound('No account for this session');

      const outcome = await db.asService('family.invite', async (session) => {
        const rows = await session.query<{
          id: string;
          owner_user_id: string;
          relationship_code: string;
          tier: string;
          expired: boolean;
        }>(
          `select id, owner_user_id, relationship_code, tier,
                  (expires_at < now()) as expired
             from public.family_invitations
            where id = $1::uuid and token_hash = $2 and status = 'pending'
            for update`,
          [id, hashToken(token)],
        );
        const invite = rows[0];
        // A wrong token and a missing invitation are the same answer. A
        // distinguishable "wrong token" turns this into an oracle for which
        // invitation ids exist.
        if (!invite) return { kind: 'not_found' as const };

        if (invite.expired) {
          await session.query(
            `update public.family_invitations
                set status = 'expired', responded_at = now() where id = $1::uuid`,
            [invite.id],
          );
          return { kind: 'expired' as const };
        }

        // Accepting your own invitation would make you your own delegate —
        // the route refuses it and so does family_relationships_not_self.
        if (invite.owner_user_id === inviteeUserId) return { kind: 'self' as const };

        if (!accept) {
          await session.query(
            `update public.family_invitations
                set status = 'declined', responded_at = now(), invitee_user_id = $2::uuid
              where id = $1::uuid`,
            [invite.id, inviteeUserId],
          );
          return { kind: 'declined' as const };
        }

        await session.query(
          `update public.family_invitations
              set status = 'accepted', responded_at = now(), invitee_user_id = $2::uuid
            where id = $1::uuid`,
          [invite.id, inviteeUserId],
        );

        // One relationship per pair, ever. Re-accepting after a revocation
        // revives the row so the history of what was granted is not lost by
        // being re-created beside itself.
        const rel = await session.query<{ id: string }>(
          `insert into public.family_relationships
             (owner_user_id, delegate_user_id, relationship_code, tier)
           values ($1::uuid, $2::uuid, $3, $4)
           on conflict (owner_user_id, delegate_user_id) do update
             set relationship_code = excluded.relationship_code,
                 tier = excluded.tier,
                 status = 'active',
                 revoked_at = null
           returning id`,
          [invite.owner_user_id, inviteeUserId, invite.relationship_code, invite.tier],
        );
        const relationshipId = rel[0]!.id;

        for (const permission of permissionsForTier(invite.tier as 'observer' | 'reviewer')) {
          await session.query(
            `insert into public.family_permissions
               (relationship_id, permission, granted_by_user_id)
             values ($1::uuid, $2, $3::uuid)
             on conflict (relationship_id, permission)
               do update set granted = true, granted_at = now()`,
            [relationshipId, permission, invite.owner_user_id],
          );
        }

        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
           values ($1::uuid, 'family_invitation_answered', $2::jsonb, $3)
           on conflict do nothing`,
          [
            invite.owner_user_id,
            JSON.stringify({ invitationId: invite.id, accepted: true }),
            `family_invitation_answered:${invite.id}`,
          ],
        );

        return { kind: 'accepted' as const, relationshipId };
      });

      if (outcome.kind === 'not_found') throw notFound('Invitation not found');
      if (outcome.kind === 'expired') throw conflict('This invitation has expired');
      if (outcome.kind === 'self') throw badRequest('You cannot accept your own invitation');
      return { status: outcome.kind === 'accepted' ? 'accepted' : 'declined' };
    },
  );

  // --- DELETE /family/invitations/:id -----------------------------------------

  fastify.delete(
    '/family/invitations/:id',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = request.params as { id: string };

      const ownerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!ownerUserId) throw notFound('No account for this session');

      const cancelled = await db.asService('family.invite', async (session) => {
        const rows = await session.query<{ id: string }>(
          `update public.family_invitations
              set status = 'cancelled', responded_at = now()
            where id = $1::uuid and owner_user_id = $2::uuid and status = 'pending'
          returning id`,
          [id, ownerUserId],
        );
        return rows.length > 0;
      });

      if (!cancelled) throw notFound('Invitation not found');
      reply.code(204);
      return null;
    },
  );

  // --- PATCH /family/members/:id/permissions ----------------------------------

  /**
   * Replace what a delegate holds.
   *
   * THE COMPLETE SET, not a delta. A delta invites a client to send what it
   * believes is there and silently restore a permission the owner revoked
   * from another device.
   *
   * A permission whose phase has not arrived is refused with 400 (ERD §12).
   * Accepting it and doing nothing is worse: the owner believes they granted
   * something.
   */
  fastify.patch(
    '/family/members/:id/permissions',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const { id } = request.params as { id: string };
      const parsed = updatePermissionsSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid permissions');

      const requested = parsed.data.permissions;
      const notYet = requested.filter((p) => !isGrantablePermission(p));
      if (notYet.length > 0) {
        throw badRequest(
          `These permissions are not available yet: ${notYet.join(', ')}`,
          Object.fromEntries(notYet.map((p) => [p, 'Not available in this phase'])),
        );
      }

      const ownerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!ownerUserId) throw notFound('No account for this session');

      const updated = await db.asService('family.manage_relationship', async (session) => {
        const rows = await session.query<{ id: string }>(
          `select id from public.family_relationships
            where id = $1::uuid and owner_user_id = $2::uuid and status = 'active'
            for update`,
          [id, ownerUserId],
        );
        if (rows.length === 0) return null;

        // Clear everything, then set what was asked for. Expressed as two
        // statements in one transaction so the stored set is exactly the
        // requested set, with no arithmetic about what changed.
        await session.query(
          `update public.family_permissions set granted = false where relationship_id = $1::uuid`,
          [id],
        );
        for (const permission of requested) {
          await session.query(
            `insert into public.family_permissions
               (relationship_id, permission, granted_by_user_id)
             values ($1::uuid, $2, $3::uuid)
             on conflict (relationship_id, permission)
               do update set granted = true, granted_at = now()`,
            [id, permission, ownerUserId],
          );
        }
        return { id };
      });

      if (!updated) throw notFound('Family member not found');
      return { id, permissions: requested };
    },
  );

  // --- DELETE /family/members/:id ---------------------------------------------

  /**
   * Revoke a delegate. Instant, and needs nobody's agreement.
   *
   * This is an R16 control, which is why it clears the grants as well as the
   * relationship: a revoked relationship whose permission rows survived would
   * come back with its old rights if it were ever reactivated, and an owner
   * revoking someone under pressure is owed certainty, not a technicality.
   *
   * IN-FLIGHT REVIEWS ARE LEFT PENDING ON PURPOSE. Clearing them to
   * `approved` would let a revocation open a conversation nobody approved;
   * clearing them to `rejected` would let it close one. The match keeps
   * waiting, and the owner can now grant someone else or change the policy.
   */
  fastify.delete(
    '/family/members/:id',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = request.params as { id: string };

      const ownerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!ownerUserId) throw notFound('No account for this session');

      const revoked = await db.asService('family.manage_relationship', async (session) => {
        const rows = await session.query<{ id: string }>(
          `update public.family_relationships
            set status = 'revoked', revoked_at = now()
          where id = $1::uuid and owner_user_id = $2::uuid and status = 'active'
        returning id`,
          [id, ownerUserId],
        );
        if (rows.length === 0) return false;

        await session.query(
          `update public.family_permissions set granted = false where relationship_id = $1::uuid`,
          [id],
        );
        return true;
      });

      if (!revoked) throw notFound('Family member not found');
      reply.code(204);
      return null;
    },
  );

  // --- GET /family/access-log --------------------------------------------------

  /**
   * Every action taken in the owner's name, and under which right.
   *
   * The anti-coercion control, and it only works because it is a screen. The
   * delegate cannot read this: someone who could see which of their actions
   * the owner had been shown would know exactly what is safe to do unobserved.
   */
  fastify.get('/family/access-log', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const { page, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<{
        id: string;
        delegate_user_id: string;
        relationship_code: string | null;
        action: string;
        permission: string;
        resource_type: string | null;
        created_at: string;
        position: number;
      }>(
        `select id, delegate_user_id, relationship_code, action, permission,
                resource_type, created_at, position
           from (
             select l.*, r.relationship_code,
                    (row_number() over (order by l.created_at desc, l.id))::int - 1 as position
               from public.family_access_log l
               left join public.family_relationships r on r.id = l.relationship_id
              where l.owner_user_id = app.current_user_id()
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      );
      return { page: rows, viewerUserId: await resolveViewer(session) };
    });

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    if (rows.length === 0 || !viewerUserId) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const names = await db.asService('family.manage_relationship', async (session) => {
      const found = await session.query<{ id: string; display_name: string | null }>(
        `select u.id, u.display_name
           from public.users u
           join public.family_relationships r on r.delegate_user_id = u.id
          where r.owner_user_id = $1::uuid and u.id = any($2::uuid[])`,
        [viewerUserId, rows.map((r) => r.delegate_user_id)],
      );
      return new Map(found.map((r) => [r.id, r.display_name]));
    });

    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => ({
        id: row.id,
        delegateDisplayName: names.get(row.delegate_user_id) ?? null,
        relationshipCode: row.relationship_code,
        action: row.action,
        permission: row.permission,
        resourceType: row.resource_type,
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- GET /family/managed ------------------------------------------------------

  /**
   * The people this delegate holds rights over.
   *
   * NOT a directory: it lists the owners who invited THIS delegate, which is a
   * set they already know because they accepted each invitation. It never
   * reaches a counterpart, a match, or anyone who has not named them.
   */
  fastify.get('/family/managed', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const { rows, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      const found = await session.query<{
        id: string;
        owner_user_id: string;
        relationship_code: string;
        tier: string;
        permissions: string[] | null;
      }>(
        `select r.id, r.owner_user_id, r.relationship_code, r.tier,
                (
                  select array_agg(p.permission order by p.permission)
                    from public.family_permissions p
                   where p.relationship_id = r.id and p.granted
                ) as permissions
           from public.family_relationships r
          where r.delegate_user_id = app.current_user_id()
            and r.status = 'active'
          order by r.created_at desc
          limit 100`,
      );
      return { rows: found, viewerUserId: await resolveViewer(session) };
    });

    if (rows.length === 0 || !viewerUserId) return { items: [], nextCursor: null, hasMore: false };

    const names = await db.asService('family.manage_relationship', async (session) => {
      const found = await session.query<{ id: string; display_name: string | null }>(
        `select u.id, u.display_name
           from public.users u
           join public.family_relationships r on r.owner_user_id = u.id
          where r.delegate_user_id = $1::uuid and r.status = 'active'
            and u.id = any($2::uuid[])`,
        [viewerUserId, rows.map((r) => r.owner_user_id)],
      );
      return new Map(found.map((r) => [r.id, r.display_name]));
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.owner_user_id,
        displayName: names.get(row.owner_user_id) ?? null,
        relationshipCode: row.relationship_code,
        tier: row.tier,
        status: 'active',
        permissions: row.permissions ?? [],
        createdAt: null,
        revokedAt: null,
      })),
      nextCursor: null,
      hasMore: false,
    };
  });

  // --- GET /family/reviews --------------------------------------------------------

  /**
   * Matches awaiting this delegate's decision.
   *
   * The inbox carries a display name and an age and nothing else. The packet
   * is a separate, match-scoped read, so an inbox cannot be mined for profile
   * data and the delegate has to open a specific pairing to see more.
   */
  fastify.get('/family/reviews', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const { page, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      // RLS on `family_reviews` already restricts this to reviews the caller
      // may see — the owner's own, or those of an owner who granted them
      // `approve_communication`. The `owner_user_id <> current` filter removes
      // the owner's own reviews, which belong on a different screen.
      const rows = await session.query<ReviewRow>(
        `select match_id, owner_user_id, decision, requested_at, position
           from (
             select v.*,
                    (row_number() over (order by v.requested_at, v.id))::int - 1 as position
               from public.family_reviews v
              where v.decision in ('pending', 'more_info_requested')
                and v.owner_user_id <> app.current_user_id()
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      );
      return { page: rows, viewerUserId: await resolveViewer(session) };
    });

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    if (rows.length === 0 || !viewerUserId) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Names and ages need `users`, which is owner-only. Confined by
    // re-applying can_review_match() per row: a review that slipped into the
    // page without the right is dropped here rather than named.
    const details = await db.asService('family.read_review_packet', async (session) => {
      const found = await session.query<{
        match_id: string;
        owner_display_name: string | null;
        counterpart_display_name: string | null;
        counterpart_age: number | null;
      }>(
        // Joined through `family_reviews` so the OWNER comes from each row
        // rather than from the first one. A delegate may act for several
        // people (A6), and reading one owner off `rows[0]` would label every
        // review in the page with that person's name and resolve the
        // counterpart from the wrong side of the match.
        `select v.match_id,
                o.display_name as owner_display_name,
                c.display_name as counterpart_display_name,
                date_part('year', age(c.date_of_birth))::int as counterpart_age
           from public.family_reviews v
           join public.matches m on m.id = v.match_id
           join public.users o on o.id = v.owner_user_id
           join public.users c
             on c.id = case when m.user_a_id = v.owner_user_id
                            then m.user_b_id else m.user_a_id end
          where v.match_id = any($2::uuid[])
            and app.can_review_match($1::uuid, v.match_id)`,
        [viewerUserId, rows.map((r) => r.match_id)],
      );
      return new Map(found.map((r) => [r.match_id, r]));
    });

    const now = new Date();
    const last = rows[rows.length - 1];
    return {
      items: rows
        .filter((row) => details.has(row.match_id))
        .map((row) => {
          const d = details.get(row.match_id)!;
          return {
            matchId: row.match_id,
            ownerUserId: row.owner_user_id,
            ownerDisplayName: d.owner_display_name,
            counterpartDisplayName: d.counterpart_display_name,
            counterpartAge: d.counterpart_age,
            decision: row.decision,
            requestedAt: row.requested_at,
            overdue:
              (now.getTime() - new Date(row.requested_at).getTime()) / 3_600_000 >=
              REVIEW_SLA_HOURS,
          };
        }),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- GET /family/reviews/:matchId ------------------------------------------------

  /**
   * THE REVIEW PACKET — one match, enumerated.
   *
   * Every field is listed on purpose. This is not a profile read with fields
   * removed: that shape would let a new profile column reach a delegate by
   * default, and the one thing this must never become is a general view of a
   * stranger.
   *
   * Absent by construction: contact details, exact location, the
   * counterpart's other matches, and anything the owner hid through
   * `profile_field_visibility`.
   */
  fastify.get('/family/reviews/:matchId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const { matchId } = request.params as { matchId: string };

    const delegateUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!delegateUserId) throw notFound('No account for this session');

    const packet = await db.asService('family.read_review_packet', async (session) => {
      // THE GATE. Re-applied here, under this key, on every read. Everything
      // below is reachable only because this returned true for this one match.
      const allowed = await session.query<{ ok: boolean }>(
        `select app.can_review_match($1::uuid, $2::uuid) as ok`,
        [delegateUserId, matchId],
      );
      if (!allowed[0]?.ok) return null;

      const rows = await session.query<{
        relationship_id: string;
        owner_user_id: string;
        owner_display_name: string | null;
        decision: string;
        requested_at: string;
        counterpart_user_id: string;
        counterpart_display_name: string | null;
        counterpart_age: number | null;
        country_code: string | null;
        marital_status_code: string | null;
        education_level_code: string | null;
        profession_code: string | null;
        religious_practice_code: string | null;
        sect_code: string | null;
        marriage_timeline_code: string | null;
        about_me: string | null;
        verified: boolean;
        score: string | number | null;
        explanation_keys: string[] | null;
        counterpart_reported: boolean;
        block_exists: boolean;
      }>(
        `select r.id as relationship_id,
                v.owner_user_id, o.display_name as owner_display_name,
                v.decision, v.requested_at,
                c.id as counterpart_user_id,
                c.display_name as counterpart_display_name,
                date_part('year', age(c.date_of_birth))::int as counterpart_age,
                c.country_code,
                p.marital_status_code, p.education_level_code, p.profession_code,
                p.religious_practice_code, p.sect_code, p.marriage_timeline_code,
                p.about_me,
                (vs.email_verified_at is not null) as verified,
                cs.overall as score,
                (
                  select array_agg(f.explanation_key order by f.weight desc)
                    from public.compatibility_factors f
                   where f.score_id = cs.id
                ) as explanation_keys,
                exists (
                  select 1 from public.reports rp where rp.reported_user_id = c.id
                ) as counterpart_reported,
                app.is_blocked(v.owner_user_id, c.id) as block_exists
           from public.family_reviews v
           join public.matches m on m.id = v.match_id
           join public.users o on o.id = v.owner_user_id
           join public.users c
             on c.id = case when m.user_a_id = v.owner_user_id
                            then m.user_b_id else m.user_a_id end
           join public.family_relationships r
             on r.owner_user_id = v.owner_user_id
            and r.delegate_user_id = $1::uuid
            and r.status = 'active'
           left join public.profiles p on p.user_id = c.id and p.deleted_at is null
           left join public.verification_status vs on vs.user_id = c.id
           left join public.compatibility_scores cs
             on cs.viewer_user_id = v.owner_user_id and cs.candidate_user_id = c.id
          where v.match_id = $2::uuid`,
        [delegateUserId, matchId],
      );
      return rows[0] ?? null;
    });

    if (!packet) throw notFound('Review not found');

    await recordAccess({
      relationshipId: packet.relationship_id,
      delegateUserId,
      ownerUserId: packet.owner_user_id,
      action: 'review.open',
      permission: 'approve_communication',
      resourceType: 'review',
      resourceId: matchId,
    });

    const now = new Date();
    return {
      matchId,
      ownerUserId: packet.owner_user_id,
      ownerDisplayName: packet.owner_display_name,
      decision: packet.decision,
      requestedAt: packet.requested_at,
      overdue:
        (now.getTime() - new Date(packet.requested_at).getTime()) / 3_600_000 >= REVIEW_SLA_HOURS,
      counterpart: {
        displayName: packet.counterpart_display_name,
        age: packet.counterpart_age,
        // Country only. Never the city, and never coordinates.
        countryCode: packet.country_code,
        maritalStatusCode: packet.marital_status_code,
        educationLevelCode: packet.education_level_code,
        professionCode: packet.profession_code,
        religiousPracticeCode: packet.religious_practice_code,
        sectCode: packet.sect_code,
        marriageTimelineCode: packet.marriage_timeline_code,
        aboutMe: packet.about_me,
        verified: packet.verified,
      },
      compatibility:
        packet.score !== null
          ? {
              // numeric(5,2) arrives as a string from pg. The packet shows a
              // whole number, as every other surface does.
              score: Math.round(Number(packet.score)),
              explanationKeys: packet.explanation_keys ?? [],
            }
          : null,
      signals: {
        counterpartReported: packet.counterpart_reported,
        blockExists: packet.block_exists,
      },
    };
  });

  // --- POST /family/reviews/:matchId/decide ------------------------------------------

  /**
   * Approve, reject, or ask for more information.
   *
   * ONE TRANSACTION covering the review, the match's `communication_state`
   * and the `match_events` row. A decision recorded without its transition
   * would leave the gate and the review disagreeing about whether anyone may
   * speak.
   *
   * BOTH SIDES MUST CLEAR. A match where each household requires review has
   * two review rows, and the state only reaches `family_approved` when no
   * other side is still pending — D12 row 3 in its strictest reading.
   *
   * `request_more_info` does NOT leave the pending gate (ERD §12). It
   * notifies the owner and resets nothing. A third outcome that silently
   * behaved like approval would be the worst possible default.
   */
  fastify.post(
    '/family/reviews/:matchId/decide',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const { matchId } = request.params as { matchId: string };
      const parsed = decideReviewSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid decision');
      const { action, note } = parsed.data;

      const delegateUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!delegateUserId) throw notFound('No account for this session');

      const outcome = await db.asService('family.decide_review', async (session) => {
        const allowed = await session.query<{ ok: boolean }>(
          `select app.can_review_match($1::uuid, $2::uuid) as ok`,
          [delegateUserId, matchId],
        );
        if (!allowed[0]?.ok) return { kind: 'not_found' as const };

        const found = await session.query<{
          id: string;
          owner_user_id: string;
          decision: string;
          relationship_id: string;
          state: string;
        }>(
          `select v.id, v.owner_user_id, v.decision, r.id as relationship_id,
                  m.communication_state as state
             from public.family_reviews v
             join public.matches m on m.id = v.match_id
             join public.family_relationships r
               on r.owner_user_id = v.owner_user_id
              and r.delegate_user_id = $1::uuid
              and r.status = 'active'
            where v.match_id = $2::uuid
            for update of v`,
          [delegateUserId, matchId],
        );
        const review = found[0];
        if (!review) return { kind: 'not_found' as const };

        // D12 row 4: the first decision stands. A second delegate arriving
        // after one has decided is told so, rather than overwriting it.
        if (review.decision === 'approved' || review.decision === 'rejected') {
          return { kind: 'already_decided' as const };
        }

        if (action === 'request_more_info') {
          await session.query(
            `update public.family_reviews
                set decision = 'more_info_requested', note = $2
              where id = $1::uuid`,
            [review.id, note ?? null],
          );
          await session.query(
            `insert into public.notifications (user_id, type, payload, dedupe_key)
             values ($1::uuid, 'family_review_decided', $2::jsonb, $3)
             on conflict do nothing`,
            [
              review.owner_user_id,
              JSON.stringify({ matchId, decision: 'more_info_requested' }),
              `family_review_decided:${review.id}:more_info`,
            ],
          );
          return {
            kind: 'ok' as const,
            decision: 'more_info_requested',
            relationshipId: review.relationship_id,
            ownerUserId: review.owner_user_id,
            state: review.state,
          };
        }

        const decision = action === 'approve' ? 'approved' : 'rejected';
        await session.query(
          `update public.family_reviews
              set decision = $2, decided_at = now(), decided_by_user_id = $3::uuid,
                  relationship_id = $4::uuid, note = $5
            where id = $1::uuid`,
          [review.id, decision, delegateUserId, review.relationship_id, note ?? null],
        );

        // A rejection closes the gate immediately. An approval only opens it
        // when every OTHER side that required review has also approved.
        let nextState = review.state;
        if (decision === 'rejected') {
          nextState = 'family_rejected';
        } else {
          const outstanding = await session.query<{ n: number }>(
            `select count(*)::int as n from public.family_reviews
              where match_id = $1::uuid and id <> $2::uuid
                and decision in ('pending', 'more_info_requested')`,
            [matchId, review.id],
          );
          if ((outstanding[0]?.n ?? 0) === 0) nextState = 'family_approved';
        }

        if (nextState !== review.state) {
          await session.query(
            `update public.matches
                set communication_state = $2, communication_state_at = now()
              where id = $1::uuid`,
            [matchId, nextState],
          );
          await session.query(
            `insert into public.match_events
               (match_id, event, actor_user_id, acted_by_user_id, relationship_id,
                from_state, to_state)
             values ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7)`,
            [
              matchId,
              decision === 'approved' ? 'family_approved' : 'family_rejected',
              review.owner_user_id,
              delegateUserId,
              review.relationship_id,
              review.state,
              nextState,
            ],
          );
        }

        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
           values ($1::uuid, 'family_review_decided', $2::jsonb, $3)
           on conflict do nothing`,
          [
            review.owner_user_id,
            JSON.stringify({ matchId, decision }),
            `family_review_decided:${review.id}`,
          ],
        );

        return {
          kind: 'ok' as const,
          decision,
          relationshipId: review.relationship_id,
          ownerUserId: review.owner_user_id,
          state: nextState,
        };
      });

      if (outcome.kind === 'not_found') throw notFound('Review not found');
      if (outcome.kind === 'already_decided')
        throw conflict('This review has already been decided');

      await recordAccess({
        relationshipId: outcome.relationshipId,
        delegateUserId,
        ownerUserId: outcome.ownerUserId,
        action: `review.${outcome.decision}`,
        permission: 'approve_communication',
        resourceType: 'review',
        resourceId: matchId,
      });

      return { matchId, decision: outcome.decision, communicationState: outcome.state };
    },
  );

  // --- POST /family/reviews/:matchId/revoke --------------------------------------------

  /**
   * Withdraw an approval.
   *
   * `revoked` closes writing without destroying the thread. ERD §21 lists it
   * as a state a match can be moved into after approval, and the conversation
   * slice reads it: membership is necessary and not sufficient.
   */
  fastify.post(
    '/family/reviews/:matchId/revoke',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const { matchId } = request.params as { matchId: string };
      const parsed = revokeReviewSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest('Invalid revocation');

      const delegateUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!delegateUserId) throw notFound('No account for this session');

      const outcome = await db.asService('family.decide_review', async (session) => {
        const allowed = await session.query<{ ok: boolean }>(
          `select app.can_review_match($1::uuid, $2::uuid) as ok`,
          [delegateUserId, matchId],
        );
        if (!allowed[0]?.ok) return { kind: 'not_found' as const };

        const found = await session.query<{
          id: string;
          owner_user_id: string;
          decision: string;
          relationship_id: string;
          state: string;
        }>(
          `select v.id, v.owner_user_id, v.decision, r.id as relationship_id,
                  m.communication_state as state
             from public.family_reviews v
             join public.matches m on m.id = v.match_id
             join public.family_relationships r
               on r.owner_user_id = v.owner_user_id
              and r.delegate_user_id = $1::uuid
              and r.status = 'active'
            where v.match_id = $2::uuid
            for update of v`,
          [delegateUserId, matchId],
        );
        const review = found[0];
        if (!review) return { kind: 'not_found' as const };
        // Only an approval can be withdrawn. Revoking a rejection would be a
        // way of re-opening a decision the delegate already made against.
        if (review.decision !== 'approved') return { kind: 'not_approved' as const };

        await session.query(
          `update public.family_reviews
              set decision = 'revoked', decided_at = now(), decided_by_user_id = $2::uuid,
                  relationship_id = $3::uuid, note = $4
            where id = $1::uuid`,
          [review.id, delegateUserId, review.relationship_id, parsed.data.note ?? null],
        );

        await session.query(
          `update public.matches
              set communication_state = 'revoked', communication_state_at = now()
            where id = $1::uuid`,
          [matchId],
        );
        await session.query(
          `insert into public.match_events
             (match_id, event, actor_user_id, acted_by_user_id, relationship_id,
              from_state, to_state)
           values ($1::uuid, 'family_revoked', $2::uuid, $3::uuid, $4::uuid, $5, 'revoked')`,
          [matchId, review.owner_user_id, delegateUserId, review.relationship_id, review.state],
        );
        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
           values ($1::uuid, 'family_review_decided', $2::jsonb, $3)
           on conflict do nothing`,
          [
            review.owner_user_id,
            JSON.stringify({ matchId, decision: 'revoked' }),
            `family_review_decided:${review.id}:revoked`,
          ],
        );

        return {
          kind: 'ok' as const,
          relationshipId: review.relationship_id,
          ownerUserId: review.owner_user_id,
        };
      });

      if (outcome.kind === 'not_found') throw notFound('Review not found');
      if (outcome.kind === 'not_approved') {
        throw conflict('Only an approved review can be revoked');
      }

      await recordAccess({
        relationshipId: outcome.relationshipId,
        delegateUserId,
        ownerUserId: outcome.ownerUserId,
        action: 'review.revoked',
        permission: 'approve_communication',
        resourceType: 'review',
        resourceId: matchId,
      });

      return { matchId, decision: 'revoked', communicationState: 'revoked' };
    },
  );

  // --- GET /family/my-reviews ------------------------------------------------------

  /**
   * The owner's own view of reviews pending ON their matches.
   *
   * Separate from `/family/reviews`, which is the delegate's inbox, because
   * these are two different questions asked by two different people. This is
   * also where the SLA sweep runs: the owner opening their family screen is
   * the moment the warning is both relevant and cheap to produce.
   */
  fastify.get('/family/my-reviews', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const ownerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!ownerUserId) throw notFound('No account for this session');

    await sweepStalledReviews(ownerUserId);

    return db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<{
        match_id: string;
        decision: string;
        requested_at: string;
        decided_at: string | null;
        note: string | null;
      }>(
        `select match_id, decision, requested_at, decided_at, note
           from public.family_reviews
          where owner_user_id = app.current_user_id()
          order by requested_at desc
          limit 100`,
      );

      const now = new Date();
      return {
        items: rows.map((row) => ({
          matchId: row.match_id,
          decision: row.decision,
          requestedAt: row.requested_at,
          decidedAt: row.decided_at,
          // The delegate's note is the owner's to read. It is never shown to
          // the counterpart.
          note: row.note,
          overdue:
            row.decided_at === null &&
            (now.getTime() - new Date(row.requested_at).getTime()) / 3_600_000 >= REVIEW_SLA_HOURS,
        })),
        nextCursor: null,
        hasMore: false,
      };
    });
  });
};
