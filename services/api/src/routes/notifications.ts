import type { FastifyPluginAsync } from 'fastify';
import { badRequest, notFound } from '../errors';
import { requireAuthContext } from '../auth/plugin';
import { decodeCursor, encodeCursor, parseLimit } from '../discovery/cards';
import type { Db, DbSession } from '../db/types';

/**
 * The notification inbox.
 *
 * READS AND READ-STATE ONLY. Nothing here creates a notification — those are
 * written inside the transactions that cause them (see
 * `src/notifications/service.ts`), which is what keeps a notification from
 * outliving a rolled-back interest.
 *
 * EVERYTHING RUNS AS THE CALLER. `notifications_select_own` and
 * `notifications_update_own` confine every row to them, and the update grant
 * is column-level on `read_at` alone — so marking something read cannot become
 * rewriting its type or payload. The handlers never decide who may read what.
 */

export interface NotificationRoutesOptions {
  db: Db;
}

interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  position: number;
}

/**
 * The contract's `Notification`.
 *
 * `titleKey` and `bodyKey` rather than rendered `title` and `body`. The
 * catalogs own user-facing wording — the same reason discovery sections return
 * `titleKey` and compatibility returns `messageKey` — and the project's own
 * exit criteria forbid hardcoded strings. Rendering English in a route handler
 * would put copy in the one place the architecture keeps it out of.
 *
 * `data` carries identifiers only. A notification is read long after it is
 * written, so a name copied into it would outlive the permission that allowed
 * it; the client resolves the actor through the normal reads, which re-apply
 * visibility at the moment of reading.
 */
function toNotification(row: NotificationRow): unknown {
  return {
    id: row.id,
    type: row.type,
    titleKey: `notifications.${row.type}.title`,
    bodyKey: `notifications.${row.type}.body`,
    data: row.payload,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  fastify,
  { db },
) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  // --- GET /notifications ----------------------------------------------------

  fastify.get('/notifications', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { unreadOnly?: string; cursor?: string; limit?: string };

    if (query.unreadOnly !== undefined && !['true', 'false'].includes(query.unreadOnly)) {
      throw badRequest('unreadOnly must be true or false');
    }
    const unreadOnly = query.unreadOnly === 'true';

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    return db.asUser(auth.authUserId, async (session) => {
      const viewerUserId = await resolveViewer(session);
      if (!viewerUserId) {
        return { items: [], unreadCount: 0, nextCursor: null, hasMore: false };
      }

      // Keyset over a stable total order: newest first, id as the tiebreak so
      // two notifications written in the same transaction never swap between
      // pages. One row over the limit, so `hasMore` is observed not guessed.
      const rows = await session.query<NotificationRow>(
        `select id, type, payload, read_at, created_at, position
           from (
             select n.*,
                    (row_number() over (order by n.created_at desc, n.id))::int - 1 as position
               from public.notifications n
              where ${unreadOnly ? 'n.read_at is null' : 'true'}
           ) ranked
          where $1::int is null or position > $1::int
          order by position
          limit ${limit + 1}`,
        [after],
      );

      // The badge count, and always the UNREAD total rather than the size of
      // this page — a filtered page would otherwise make the badge wrong.
      const counted = await session.query<{ n: string }>(
        `select count(*)::text as n from public.notifications where read_at is null`,
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];

      return {
        items: page.map(toNotification),
        unreadCount: Number.parseInt(counted[0]?.n ?? '0', 10),
        nextCursor: hasMore && last ? encodeCursor(last.position) : null,
        hasMore,
      };
    });
  });

  // --- POST /notifications/read-all -----------------------------------------
  //
  // Registered before the parameterised route so `read-all` is never read as a
  // notification id.

  fastify.post(
    '/notifications/read-all',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      // Idempotent, and the `read_at is null` guard is what makes it so: a
      // second call does not move the timestamps of things already read, which
      // would reorder nothing but would misreport when they were seen.
      await db.asUser(auth.authUserId, (session) =>
        session.query(
          `update public.notifications set read_at = now()
            where user_id = app.current_user_id() and read_at is null`,
        ),
      );

      return reply.code(204).send();
    },
  );

  // --- POST /notifications/:notificationId/read ------------------------------

  fastify.post(
    '/notifications/:notificationId/read',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { notificationId?: string };
      const notificationId = params.notificationId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(notificationId)) throw badRequest('Invalid notification id');

      const updated = await db.asUser(auth.authUserId, async (session) => {
        // Existence is checked through the same RLS-scoped read that the
        // update uses, so someone else's notification is absent rather than
        // refused — a 403 would confirm it exists.
        const rows = await session.query<{ id: string }>(
          `select id from public.notifications where id = $1::uuid`,
          [notificationId],
        );
        if (!rows[0]) return false;

        await session.query(
          `update public.notifications set read_at = coalesce(read_at, now())
            where id = $1::uuid`,
          [notificationId],
        );
        return true;
      });

      // `coalesce` above keeps the FIRST read time rather than the latest, so
      // marking something read twice answers 204 without rewriting history.
      if (!updated) throw notFound('Notification not found');
      return reply.code(204).send();
    },
  );
};
