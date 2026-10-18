import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../errors';
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
    if (!/^[0-9a-f-]{36}$/i.test(matchId)) throw badRequest('Invalid match id');

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
      if (!/^[0-9a-f-]{36}$/i.test(matchId)) throw badRequest('Invalid match id');

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
};
