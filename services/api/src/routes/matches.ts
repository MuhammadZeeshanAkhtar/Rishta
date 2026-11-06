import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { REVIEW_SLA_HOURS } from '@nikahmate/domain';
import { badRequest, conflict, notFound } from '../errors';
import { isoTimestamp } from '../db/sql';
import { requireAuthContext } from '../auth/plugin';
import {
  CARDS_BY_USER_IDS,
  buildCards,
  decodeCursor,
  encodeCursor,
  parseLimit,
  type CardRow,
} from '../discovery/cards';
import type { Db, DbSession } from '../db/types';
import { isUuid, uuidParam } from '../http/params';

/**
 * Match reads.
 *
 * READ-ONLY, and side-effect free: nothing here writes a row, consumes quota,
 * records an event or marks a view. `POST /matches/{id}/unmatch` is a
 * mutation and belongs to the slice that owns ending a match;
 * `/matches/{id}/family-review` is Family Safety.
 *
 * ACCESS IS RLS, NOT A HANDLER CHECK. `matches_select_participant` confines
 * every read to rows where the caller is `user_a_id` or `user_b_id`, so a
 * match between two other people is simply absent rather than refused — the
 * handler never has to decide who may read what, and cannot get it wrong.
 */

const unmatchSchema = z.object({
  reason: z.string().max(300).optional(),
});

export interface MatchRoutesOptions {
  db: Db;
}

interface MatchRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  communication_state: string;
  created_at: string;
  ended_at: string | null;
  position: number;
}

/**
 * The contract's `Match`.
 *
 * `conversationId` is null until the chat slice creates a thread — the schema
 * says so explicitly ("A match can exist with no thread"), and ADR 0011 is the
 * reason: a match is an agreement, not a permission to write.
 *
 * `familyReview` is null because nothing can require review until Family
 * Safety ships. It is present in the shape rather than omitted, so a client
 * written against this does not have to change when it starts being populated.
 *
 * No internal column reaches the response: `interest_id`, `ended_by_user_id`,
 * `end_reason` and `communication_state_at` are all absent. The first is an
 * audit link, and the last three describe the other party's actions.
 */
function toMatch(row: MatchRow, viewerUserId: string, counterpart: unknown): unknown {
  return {
    id: row.id,
    counterpart,
    counterpartUserId: row.user_a_id === viewerUserId ? row.user_b_id : row.user_a_id,
    conversationId: null,
    stage: 1,
    communicationState: row.communication_state,
    familyReview: null,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

export const matchRoutes: FastifyPluginAsync<MatchRoutesOptions> = async (fastify, { db }) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  const counterpartCards = async (
    viewerUserId: string,
    ids: readonly string[],
  ): Promise<Map<string, unknown>> => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    return db.asService('discovery.read_cards', async (session) => {
      const rows = await session.query<CardRow>(CARDS_BY_USER_IDS, [viewerUserId, unique]);
      const built = (await buildCards(session, viewerUserId, rows)) as Array<{ userId: string }>;
      return new Map<string, unknown>(built.map((card) => [card.userId, card]));
    });
  };

  // --- GET /matches ----------------------------------------------------------

  fastify.get('/matches', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) return { items: [], nextCursor: null, hasMore: false };

    // "Active matches" — an ended match is not one. Keyset over newest first
    // with the id as a tiebreak, so the order is total and two matches made in
    // the same millisecond never swap between pages.
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<MatchRow>(
        `select id, user_a_id, user_b_id, communication_state, created_at, ended_at, position
           from (
             select m.*,
                    (row_number() over (order by m.created_at desc, m.id))::int - 1 as position
               from public.matches m
              where m.ended_at is null
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      ),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const cards = await counterpartCards(
      viewerUserId,
      page.map((row) => (row.user_a_id === viewerUserId ? row.user_b_id : row.user_a_id)),
    );

    return {
      items: page.map((row) => {
        const counterpartUserId = row.user_a_id === viewerUserId ? row.user_b_id : row.user_a_id;
        return toMatch(row, viewerUserId, cards.get(counterpartUserId) ?? null);
      }),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- GET /matches/:matchId -------------------------------------------------

  fastify.get('/matches/:matchId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const params = request.params as { matchId?: string };
    const matchId = params.matchId ?? '';
    if (!isUuid(matchId)) throw badRequest('Invalid match id');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) throw notFound('Match not found');

    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<MatchRow>(
        `select id, user_a_id, user_b_id, communication_state, created_at, ended_at,
                0 as position
           from public.matches where id = $1::uuid`,
        [matchId],
      ),
    );
    const row = rows[0];
    // Absent rather than forbidden: RLS removed it if the caller is not a
    // participant, and a 403 would confirm the match exists.
    if (!row) throw notFound('Match not found');

    const counterpartUserId = row.user_a_id === viewerUserId ? row.user_b_id : row.user_a_id;
    const cards = await counterpartCards(viewerUserId, [counterpartUserId]);
    return toMatch(row, viewerUserId, cards.get(counterpartUserId) ?? null);
  });

  // --- POST /matches/:matchId/unmatch ---------------------------------------

  /**
   * End a match.
   *
   * ONLY A PARTICIPANT, and a non-participant gets the same 404 as a match
   * that does not exist — a 403 would confirm it does. RLS confines the lookup
   * to the caller's own rows, so the handler mostly cannot get this wrong.
   *
   * IDEMPOTENT. The contract defines 204, 401 and 404 and no conflict, so
   * ending something already ended answers 204: that is the state the caller
   * asked for. It writes no second event, because the audit trail should show
   * one ending, not one per retry.
   *
   * `communication_state` is left alone. Ending is the member's decision about
   * the relationship; the gate is the family's decision about writing, and
   * conflating them would let an unmatch look like a family rejection in the
   * event log.
   *
   * No notification, no conversation teardown, no quota movement — none of
   * those is in this contract, and the ones that exist belong to later slices.
   */
  fastify.post(
    '/matches/:matchId/unmatch',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { matchId?: string };
      const matchId = params.matchId ?? '';
      if (!isUuid(matchId)) throw badRequest('Invalid match id');

      const parsed = unmatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest('reason must be 300 characters or fewer');

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('Match not found');

      // Participation established as the CALLER, so RLS decides it.
      const visible = await db.asUser(auth.authUserId, (session) =>
        session.query<{ id: string }>(`select id from public.matches where id = $1::uuid`, [
          matchId,
        ]),
      );
      if (!visible[0]) throw notFound('Match not found');

      await db.asService('match.end', async (session) => {
        // Conditional on still being active, so two concurrent unmatches
        // produce one ending and one event rather than racing on a read.
        const ended = await session.query<{ id: string; communication_state: string }>(
          `update public.matches
              set ended_at = now(),
                  ended_by_user_id = $2::uuid,
                  end_reason = $3::text
            where id = $1::uuid and ended_at is null
            returning id, communication_state`,
          [matchId, viewerUserId, parsed.data.reason ?? null],
        );

        if (ended[0]) {
          await session.query(
            `insert into public.match_events (match_id, event, actor_user_id, from_state)
             values ($1::uuid, 'ended', $2::uuid, $3::text)`,
            [matchId, viewerUserId, ended[0].communication_state],
          );
        }
      });

      return reply.code(204).send();
    },
  );

  // ===========================================================================
  // GET/POST /matches/:matchId/family-review — review L10 (and L6)
  //
  // The OWNER's view of where their match stands with families, and the
  // owner's escape hatch from an indefinite veto (R16): ask their own family
  // to review again. Never a way to approve; never a way to override the
  // other family.
  // ===========================================================================

  interface ReviewRow {
    id: string;
    owner_user_id: string;
    decision: string;
    decided_at: string | null;
    requested_at: string;
    note: string | null;
    decided_by_user_id: string | null;
    decided_by_name: string | null;
    decided_by_relationship: string | null;
    stalled: boolean;
  }

  /** The match, if the caller is a participant (RLS); else null. */
  const participantMatch = async (authUserId: string, matchId: string) => {
    const rows = await db.asUser(authUserId, (session) =>
      session.query<MatchRow>(
        `select id, user_a_id, user_b_id, communication_state, created_at, ended_at,
                0 as position
           from public.matches where id = $1::uuid`,
        [matchId],
      ),
    );
    return rows[0] ?? null;
  };

  const reviewsFor = (matchId: string) =>
    db.asService('family.match_review', (session) =>
      session.query<ReviewRow>(
        `select r.id, r.owner_user_id, r.decision,
                ${isoTimestamp('r.decided_at')} as decided_at,
                ${isoTimestamp('r.requested_at')} as requested_at,
                r.note, r.decided_by_user_id,
                d.display_name as decided_by_name,
                rel.relationship_code as decided_by_relationship,
                (r.decision in ('pending', 'more_info_requested')
                 and r.requested_at < now() - make_interval(hours => $2::int)) as stalled
           from public.family_reviews r
           left join public.users d on d.id = r.decided_by_user_id
           left join public.family_relationships rel on rel.id = r.relationship_id
          where r.match_id = $1::uuid`,
        [matchId, REVIEW_SLA_HOURS],
      ),
    );

  fastify.get(
    '/matches/:matchId/family-review',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const matchId = uuidParam(request, 'matchId', 'match id');
      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('Match not found');
      const match = await participantMatch(auth.authUserId, matchId);
      if (!match) throw notFound('Match not found');

      const reviews = await reviewsFor(matchId);
      const mine = reviews.find((r) => r.owner_user_id === viewerUserId);
      const theirs = reviews.find((r) => r.owner_user_id !== viewerUserId);

      // `state` is the caller's own side when it requires review; otherwise
      // the counterpart side's bare decision; otherwise nothing is pending.
      const state = mine?.decision ?? theirs?.decision ?? 'approved';
      return {
        state,
        mySideRequiresReview: mine !== undefined,
        counterpartSideRequiresReview: theirs !== undefined,
        // Own side only. The counterpart's reviewer is never named and their
        // note never returned.
        decidedBy: mine?.decided_by_user_id
          ? {
              userId: mine.decided_by_user_id,
              ...(mine.decided_by_name ? { displayName: mine.decided_by_name } : {}),
              ...(mine.decided_by_relationship
                ? { relationshipCode: mine.decided_by_relationship }
                : {}),
            }
          : null,
        decidedAt: mine?.decided_at ?? null,
        note: mine?.note ?? null,
        requestedAt: mine?.requested_at ?? null,
      };
    },
  );

  /**
   * Ask my family to review again (R16). Allowed when MY side was rejected,
   * or has stalled past the SLA. Refused when the OTHER family rejected: an
   * owner may ask their own family again, never overrule someone else's.
   * Resets my side to pending, moves a `family_rejected` match back to
   * `pending_family_review` (only when no other side rejected), and
   * re-notifies every delegate who can decide.
   */
  fastify.post(
    '/matches/:matchId/family-review',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const matchId = uuidParam(request, 'matchId', 'match id');
      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('Match not found');
      const match = await participantMatch(auth.authUserId, matchId);
      if (!match) throw notFound('Match not found');
      if (match.ended_at !== null) throw conflict('This match has ended');

      await db.asService('family.match_review', async (session) => {
        // Lock the match and its reviews: two re-requests, or a re-request
        // racing a decision, must serialise.
        await session.query(`select id from public.matches where id = $1::uuid for update`, [
          matchId,
        ]);
        const rows = await session.query<{
          id: string;
          owner_user_id: string;
          decision: string;
          stalled: boolean;
        }>(
          `select id, owner_user_id, decision,
                  (decision in ('pending', 'more_info_requested')
                   and requested_at < now() - make_interval(hours => $2::int)) as stalled
             from public.family_reviews where match_id = $1::uuid
            for update`,
          [matchId, REVIEW_SLA_HOURS],
        );
        const mine = rows.find((r) => r.owner_user_id === viewerUserId);
        if (!mine) throw conflict('Your family is not reviewing this match');
        if (rows.some((r) => r.owner_user_id !== viewerUserId && r.decision === 'rejected')) {
          throw conflict('The other family has declined; that decision is theirs');
        }
        if (mine.decision !== 'rejected' && !mine.stalled) {
          throw conflict('You can ask again after a decline, or once the review is overdue');
        }

        await session.query(
          `update public.family_reviews
              set decision = 'pending', decided_at = null, decided_by_user_id = null,
                  relationship_id = null, note = null, requested_at = now(),
                  sla_notified_at = null
            where id = $1::uuid`,
          [mine.id],
        );
        await session.query(
          `update public.matches
              set communication_state = 'pending_family_review', communication_state_at = now()
            where id = $1::uuid and communication_state = 'family_rejected'`,
          [matchId],
        );

        const delegates = await session.query<{ delegate_user_id: string }>(
          `select r.delegate_user_id
             from public.family_relationships r
             join public.family_permissions p on p.relationship_id = r.id
            where r.owner_user_id = $1::uuid and r.status = 'active'
              and p.permission = 'approve_communication' and p.granted`,
          [viewerUserId],
        );
        for (const delegate of delegates) {
          await session.query(
            `insert into public.notifications (user_id, type, payload, dedupe_key)
             values ($1::uuid, 'family_review_requested', $2::jsonb, $3)
             on conflict do nothing`,
            [
              delegate.delegate_user_id,
              JSON.stringify({ matchId, ownerUserId: viewerUserId, again: true }),
              // A fresh key per request, or the first request's key would
              // swallow every re-request.
              `family_review_requested:${mine.id}:${Date.now()}`,
            ],
          );
        }
      });

      const fresh = await participantMatch(auth.authUserId, matchId);
      const counterpartUserId =
        fresh!.user_a_id === viewerUserId ? fresh!.user_b_id : fresh!.user_a_id;
      const cards = await counterpartCards(viewerUserId, [counterpartUserId]);
      return toMatch(fresh!, viewerUserId, cards.get(counterpartUserId) ?? null);
    },
  );
};
