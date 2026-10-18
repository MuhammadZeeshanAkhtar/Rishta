import type { FastifyPluginAsync } from 'fastify';
import { blockRequestSchema, createReportSchema } from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, conflict, notFound } from '../errors';
import { decodeCursor, encodeCursor, parseLimit } from '../discovery/cards';
import type { Db, DbSession } from '../db/types';

/**
 * Safety: blocking and reporting.
 *
 * Mirrors the Safety section of docs/openapi.yaml.
 *
 * THE TWO ARE SEPARATE ACTIONS and stay separate. Blocking is a private
 * preference that takes effect instantly and tells nobody; reporting asks a
 * human to look at someone and changes nothing by itself. Fusing them — "block
 * and report" as one button — would either file reports nobody meant to file
 * or leave people exposed while they decide. The UI may offer both together;
 * the API does not conflate them.
 *
 * WHY BLOCKS RUN AS THE MEMBER AND REPORTS DO NOT. Every column of a `blocks`
 * row belongs to the member, and migration 0011 gave them the grant and the
 * policy to prove it, so the block paths run under `asUser` and RLS is the
 * authority. A report carries `status` and `outcome_key`, which belong to the
 * moderation pipeline, so `reports` has no member write grant and the insert
 * goes through the service role — alongside the checks the route is the only
 * place to make.
 *
 * NOT-FOUND, NEVER FORBIDDEN. ADR-wide convention and the contract agree: a
 * 403 would confirm the other member exists. Everything a caller may not see
 * is 404.
 */

export interface SafetyRoutesOptions {
  db: Db;
}

const UUID = /^[0-9a-f-]{36}$/i;

interface BlockRow {
  blocked_user_id: string;
  created_at: string;
  position: number;
}

interface ReportRow {
  id: string;
  category: string;
  status: string;
  outcome_key: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toReport(row: ReportRow): Record<string, unknown> {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    outcomeKey: row.outcome_key,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    // `description`, `contextType`, `contextId` and everything identifying the
    // reported member are absent by construction, not filtered out. The
    // contract's Report schema has no such fields and the reporter is told the
    // outcome, never what happened to another person's account.
  };
}

export const safetyRoutes: FastifyPluginAsync<SafetyRoutesOptions> = async (fastify, { db }) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  // --- GET /blocks -----------------------------------------------------------

  /**
   * People this member has blocked.
   *
   * ONE DIRECTION ONLY — the rows where the caller is the blocker. The reverse
   * half of `app.is_blocked()` is never surfaced: a list that revealed who had
   * blocked YOU would hand over the one fact the entire design withholds, and
   * the RLS policy on `blocks` already refuses it.
   */
  fastify.get('/blocks', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const { viewerUserId, page } = await db.asUser(auth.authUserId, async (session) => {
      // Keyset over newest first with the id as a tiebreak, so two blocks made
      // in the same millisecond never swap between pages.
      const rows = await session.query<BlockRow>(
        `select blocked_user_id, created_at, position
           from (
             select b.*,
                    (row_number() over (order by b.created_at desc, b.id))::int - 1 as position
               from public.blocks b
              where b.blocker_user_id = app.current_user_id()
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      );
      return { viewerUserId: await resolveViewer(session), page: rows };
    });

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    if (rows.length === 0 || !viewerUserId) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Names come from `users`, which is owner-only. Not the discovery card
    // builder: that re-applies `app.can_view_profile()`, which a blocked
    // member fails by definition, so it would return an empty list and leave
    // the blocks unmanageable.
    //
    // Confined by the join: the rows reachable here are exactly the ones the
    // caller's own `blocks` already named, with `viewerUserId` resolved above
    // under the caller's own session.
    const names = await db.asService('safety.read_blocked_identities', async (session) => {
      const found = await session.query<{ id: string; display_name: string | null }>(
        `select u.id, u.display_name
           from public.users u
           join public.blocks b on b.blocked_user_id = u.id
          where b.blocker_user_id = $1::uuid
            and u.id = any($2::uuid[])`,
        [viewerUserId, rows.map((r) => r.blocked_user_id)],
      );
      return new Map(found.map((row) => [row.id, row.display_name]));
    });

    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => ({
        userId: row.blocked_user_id,
        displayName: names.get(row.blocked_user_id) ?? null,
        blockedAt: row.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- PUT /blocks/:userId ---------------------------------------------------

  /**
   * Block a member.
   *
   * IDEMPOTENT. `on conflict do nothing` and 204 either way: blocking someone
   * already blocked is the state the caller asked for, and a 409 would make a
   * double-tap look like a failure at the exact moment someone is trying to
   * get away from another person.
   *
   * THE MATCH IS NOT ENDED, and that is deliberate. `app.relationship()`
   * already answers `blocked` above `match`, so every visibility decision
   * flips immediately without touching the match row. Ending it here would
   * destroy the history of something that genuinely happened, and would take
   * the decision to unmatch away from the other party, who has not been told
   * anything. Either side can still unmatch afterwards — the unmatch path
   * deliberately keeps working through a block so nobody is trapped in a match
   * they want out of.
   *
   * `matches.communication_state` is also left alone. ERD §21 lists `blocked`
   * as a state that is "reachable from every state and exits to none", so
   * writing it would make an unblock permanently un-writable — a product
   * decision that belongs with the slice that can act on it, not with this
   * one. Nothing reads the gate yet, and `app.relationship()` already carries
   * the truth.
   */
  fastify.put('/blocks/:userId', { preHandler: fastify.requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const params = request.params as { userId?: string };
    const targetUserId = params.userId ?? '';
    if (!UUID.test(targetUserId)) throw badRequest('Invalid user id');

    const parsed = blockRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid block request');

    await db.asUser(auth.authUserId, async (session) => {
      const viewerUserId = await resolveViewer(session);
      if (!viewerUserId) throw notFound('Profile not found');
      // A self-block is refused as not-found rather than as a validation
      // error, for the same reason a stranger is: the caller learns nothing
      // from the distinction, and the database refuses it regardless
      // (blocks_not_self).
      if (viewerUserId === targetUserId) throw notFound('Profile not found');

      // ALREADY BLOCKED IS DONE, and this check has to come first.
      //
      // The visibility check below cannot: a block makes the target invisible
      // to the blocker, so re-running it after the first block would answer
      // 404 and make a second tap look like a failure — at the exact moment
      // someone is trying to get away from another person. Asked before, the
      // answer is simply "yes, already".
      const existing = await session.query<{ ok: boolean }>(
        `select exists (
           select 1 from public.blocks
            where blocker_user_id = app.current_user_id()
              and blocked_user_id = $1::uuid
         ) as ok`,
        [targetUserId],
      );
      if (existing[0]?.ok) return;

      // The target must exist and be someone this member could otherwise see.
      // `can_view_profile` folds in deletion, suspension and review status —
      // and also returns false if the TARGET has blocked the caller, which is
      // correct: that pair is already mutually invisible, so the answer is 404
      // and the caller cannot tell which of the two situations they are in.
      const visible = await session.query<{ ok: boolean }>(
        `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
        [viewerUserId, targetUserId],
      );
      if (!visible[0]?.ok) throw notFound('Profile not found');

      // `on conflict do nothing` as well as the check above: the check makes
      // the ordinary repeat a clean no-op, and the constraint is what holds
      // when two taps race.
      await session.query(
        `insert into public.blocks (blocker_user_id, blocked_user_id, reason_code)
         values (app.current_user_id(), $1::uuid, $2::text)
         on conflict (blocker_user_id, blocked_user_id) do nothing`,
        [targetUserId, parsed.data.reasonCode ?? null],
      );
    });

    return reply.code(204).send();
  });

  // --- DELETE /blocks/:userId ------------------------------------------------

  /**
   * Unblock.
   *
   * NO VISIBILITY CHECK, on purpose, and this is the mirror of the shortlist
   * delete. The person you blocked is invisible to you by definition, so
   * requiring them to be visible in order to undo it would make every block
   * permanent. The RLS policy already confines the delete to the caller's own
   * rows.
   *
   * 204 whether or not a row existed: removing something already removed is
   * the state the caller asked for.
   */
  fastify.delete('/blocks/:userId', { preHandler: fastify.requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const params = request.params as { userId?: string };
    const targetUserId = params.userId ?? '';
    if (!UUID.test(targetUserId)) throw badRequest('Invalid user id');

    await db.asUser(auth.authUserId, (session) =>
      session.query(
        `delete from public.blocks
          where blocker_user_id = app.current_user_id() and blocked_user_id = $1::uuid`,
        [targetUserId],
      ),
    );

    return reply.code(204).send();
  });

  // --- POST /reports ---------------------------------------------------------

  /**
   * Report a member.
   *
   * REPORTING DOES NOT BLOCK. The two are offered side by side in the app and
   * remain separate here: someone reporting a profile they want a human to
   * look at has not necessarily decided to cut contact, and silently blocking
   * on their behalf would take that decision away.
   *
   * ONE OPEN REPORT PER PAIR is the spam control, enforced by a partial unique
   * index so a report about the same person is possible again once the first
   * has been resolved. Reporting repeatedly while a case is open adds nothing
   * a moderator can use.
   */
  fastify.post('/reports', { preHandler: fastify.requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);

    const parsed = createReportSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Invalid report',
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.') || '(root)', issue.message]),
        ),
      );
    }
    const { reportedUserId, category, description, contextType, contextId } = parsed.data;

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) throw notFound('Profile not found');
    // Checked before the transaction because it needs no data. The database
    // refuses it too (reports_not_self); this just avoids opening one.
    if (viewerUserId === reportedUserId) throw notFound('Profile not found');

    const created = await db.asService('report.file', async (session) => {
      // The reported member must be someone the caller can see. Note the
      // order: this runs BEFORE the block check below, so blocking someone and
      // then reporting them still works — see the comment there.
      const visible = await session.query<{ ok: boolean }>(
        `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
        [viewerUserId, reportedUserId],
      );

      // A blocked member is invisible, and reporting someone you have just
      // blocked is the single most likely sequence in the whole feature. So
      // the caller's OWN block is not a reason to refuse: only the absence of
      // the person, or their having blocked the caller, is.
      if (!visible[0]?.ok) {
        const ownBlock = await session.query<{ ok: boolean }>(
          `select exists (
             select 1 from public.blocks
              where blocker_user_id = $1::uuid and blocked_user_id = $2::uuid
           ) as ok`,
          [viewerUserId, reportedUserId],
        );
        if (!ownBlock[0]?.ok) throw notFound('Profile not found');
      }

      try {
        const rows = await session.query<ReportRow>(
          `insert into public.reports
             (reporter_user_id, reported_user_id, category, description,
              context_type, context_id)
           values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::uuid)
           returning id, category, status, outcome_key, created_at, resolved_at`,
          [
            viewerUserId,
            reportedUserId,
            category,
            description ?? null,
            contextType ?? null,
            contextId ?? null,
          ],
        );
        return rows[0] ?? null;
      } catch (error) {
        // The partial unique index is the race control; this turns the
        // ordinary case into the contract's conflict rather than a 500.
        if (isUniqueViolation(error, 'reports_one_open_per_pair')) {
          throw conflict('You have already reported this member. We are looking into it.');
        }
        throw error;
      }
    });

    if (!created) throw notFound('Profile not found');
    return reply.code(201).send(toReport(created));
  });

  // --- GET /me/reports -------------------------------------------------------

  /** The reporter's own reports and their outcomes (ERD §14). */
  fastify.get('/me/reports', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<ReportRow & { position: number }>(
        `select id, category, status, outcome_key, created_at, resolved_at, position
           from (
             select r.*,
                    (row_number() over (order by r.created_at desc, r.id))::int - 1 as position
               from public.reports r
              where r.reporter_user_id = app.current_user_id()
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

    return {
      items: page.map(toReport),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });
};

/** Postgres 23505, narrowed to one named constraint. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== '23505') return false;
  if (typeof candidate.constraint === 'string') return candidate.constraint === constraint;
  // PGlite reports the constraint in the message rather than the field.
  return typeof candidate.message === 'string' && candidate.message.includes(constraint);
}
