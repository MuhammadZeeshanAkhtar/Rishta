import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  createPhotoRequestSchema,
  findContactDetails,
  PHOTO_REQUEST_STATUSES,
  respondPhotoRequestSchema,
  type PhotoRequestStatus,
} from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { bearerFrom } from '../auth/verify';
import { buildCards, CARDS_BY_USER_IDS, parseLimit, type CardRow } from '../discovery/cards';
import { isoTimestamp } from '../db/sql';
import type { Db, DbSession } from '../db/types';
import { badRequest, conflict, notFound } from '../errors';
import { decodeKeyset, encodeKeyset, keysetTime } from '../http/cursor';
import { uuidParam } from '../http/params';
import { SIGNED_URL_TTL_SECONDS, type StorageClient } from '../storage/client';

/**
 * Another member's photos, and asking to see them — review L3, company
 * decision 2, migration 0031.
 *
 *   GET  /profiles/:userId/photos              what this viewer may see, signed
 *   POST /profiles/:userId/photo-request       ask to see blurred/on-request photos
 *   GET  /me/photo-requests                    incoming and outgoing
 *   POST /me/photo-requests/:requestId/respond approve (grant) or decline
 *
 * WHICH OBJECT A VIEWER MAY READ is decided once, in SQL —
 * `app.photo_variant_readable` — and this file only asks it. The same
 * function backs the Storage policy, and URLs are signed with the VIEWER's
 * own token, so a variant the rule refuses cannot be signed even if this code
 * asked for it. There is still no Storage service credential.
 *
 * A profile the viewer may not see is 404, as everywhere (`can_view_profile`).
 */

export interface PhotoAccessRoutesOptions {
  db: Db;
  storage: StorageClient;
}

/** A declined request blocks a new one for this long (anti-nagging, ERD §7). */
export const PHOTO_REQUEST_COOLDOWN_DAYS = 30;

const resolveViewer = async (session: DbSession): Promise<string | null> => {
  const rows = await session.query<{ id: string | null }>(`select app.current_user_id() as id`);
  return rows[0]?.id ?? null;
};

interface RequestRow {
  id: string;
  requester_user_id: string;
  owner_user_id: string;
  status: PhotoRequestStatus;
  message: string | null;
  created_at: string;
  responded_at: string | null;
  cursor_at?: string;
}

const REQUEST_COLUMNS = `r.id, r.requester_user_id, r.owner_user_id, r.status, r.message,
  ${isoTimestamp('r.created_at')} as created_at, ${isoTimestamp('r.responded_at')} as responded_at`;

export const photoAccessRoutes: FastifyPluginAsync<PhotoAccessRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { db, storage } = opts;
  const tokenOf = (request: FastifyRequest): string =>
    bearerFrom(request.headers.authorization) ?? '';

  /** The viewer, refused (404) unless they may see `target` at all. */
  const viewerOf = async (authUserId: string, target: string): Promise<string> => {
    const rows = await db.asUser(authUserId, (session) =>
      session.query<{ me: string | null; ok: boolean }>(
        `select app.current_user_id() as me,
                app.can_view_profile(app.current_user_id(), $1::uuid) as ok`,
        [target],
      ),
    );
    const me = rows[0]?.me ?? null;
    if (!me || me === target || !rows[0]?.ok) throw notFound('Profile not found');
    return me;
  };

  /** Cards for counterparts, in the given order, dropping any not viewable. */
  const cardsFor = async (viewer: string, ids: string[]): Promise<Map<string, unknown>> => {
    if (ids.length === 0) return new Map();
    const cards = await db.asService('discovery.read_cards', async (session) => {
      const rows = await session.query<CardRow>(CARDS_BY_USER_IDS, [viewer, [...new Set(ids)]]);
      return buildCards(session, viewer, rows);
    });
    return new Map((cards as Array<{ userId: string }>).map((c) => [c.userId, c]));
  };

  const toRequest = (row: RequestRow, viewer: string, card: unknown) => ({
    id: row.id,
    direction: row.requester_user_id === viewer ? ('outgoing' as const) : ('incoming' as const),
    counterpart: card,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  });

  // --- GET /profiles/:userId/photos ------------------------------------------

  fastify.get('/profiles/:userId/photos', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const target = uuidParam(request, 'userId', 'user id');
    await viewerOf(auth.authUserId, target);

    // As the viewer: `photos_select_visible` already limits the rows to
    // approved, non-private photos on a profile they may view; the rule then
    // says which stored object of each they may read.
    const {
      photos,
      request: latest,
      granted,
    } = await db.asUser(auth.authUserId, async (session) => {
      const photos = await session.query<{
        id: string;
        storage_path: string;
        blurred_path: string | null;
        can_full: boolean;
        can_blurred: boolean;
        visibility: string;
      }>(
        `select p.id, p.storage_path, p.visibility,
                  (select v.storage_path from public.photo_variants v
                    where v.photo_id = p.id and v.variant = 'blurred') as blurred_path,
                  app.photo_variant_readable(app.current_user_id(), p.id, 'full') as can_full,
                  app.photo_variant_readable(app.current_user_id(), p.id, 'blurred') as can_blurred
             from public.photos p
            where p.user_id = $1::uuid
              and p.deleted_at is null
              and p.moderation_status = 'approved'
              and p.visibility <> 'private'
            order by p.is_primary desc, p.position, p.id`,
        [target],
      );
      const requests = await session.query<RequestRow>(
        `select ${REQUEST_COLUMNS}
             from public.photo_requests r
            where r.requester_user_id = app.current_user_id() and r.owner_user_id = $1::uuid
            order by r.created_at desc
            limit 1`,
        [target],
      );
      const grant = await session.query<{ ok: boolean }>(
        `select app.has_photo_grant(app.current_user_id(), $1::uuid, null) as ok`,
        [target],
      );
      return { photos, request: requests[0] ?? null, granted: grant[0]?.ok ?? false };
    });

    const token = tokenOf(request);
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
    const items = [];
    for (const photo of photos) {
      if (photo.can_full) {
        const url = await storage.createSignedUrl(token, photo.storage_path);
        if (url)
          items.push({ id: photo.id, variant: 'full', url, expiresAt, requiresRequest: false });
      } else if (photo.can_blurred && photo.blurred_path) {
        const url = await storage.createSignedUrl(token, photo.blurred_path);
        // A blurred photo is revealed by a grant, so it can still be requested.
        if (url)
          items.push({ id: photo.id, variant: 'blurred', url, expiresAt, requiresRequest: true });
      } else {
        // on_request with no grant: the viewer learns only that it exists.
        items.push({
          id: photo.id,
          variant: 'blurred',
          url: null,
          expiresAt: null,
          requiresRequest: true,
        });
      }
    }

    return {
      items,
      request: latest
        ? {
            id: latest.id,
            status: latest.status,
            createdAt: latest.created_at,
            respondedAt: latest.responded_at,
          }
        : null,
      granted,
    };
  });

  // --- POST /profiles/:userId/photo-request ----------------------------------

  fastify.post(
    '/profiles/:userId/photo-request',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const target = uuidParam(request, 'userId', 'user id');
      const parsed = createPhotoRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest(
          'Invalid photo request',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }
      const message = parsed.data.message;
      // Review L9 / decision 3: a message reaches the owner before any
      // contact is allowed, so it obeys the same rule as an interest note.
      if (message !== undefined && findContactDetails(message).length > 0) {
        throw badRequest('A photo request cannot include contact details', {
          message: 'contact_details_not_allowed',
        });
      }
      const viewer = await viewerOf(auth.authUserId, target);

      const state = await db.asUser(auth.authUserId, (session) =>
        session.query<{
          requestable: number;
          granted: boolean;
          pending: boolean;
          declined: boolean;
        }>(
          `select
             (select count(*)::int from public.photos p
               where p.user_id = $1::uuid and p.deleted_at is null
                 and p.moderation_status = 'approved'
                 and p.visibility in ('blurred', 'on_request')) as requestable,
             app.has_photo_grant(app.current_user_id(), $1::uuid, null) as granted,
             exists (select 1 from public.photo_requests r
                      where r.requester_user_id = app.current_user_id()
                        and r.owner_user_id = $1::uuid and r.status = 'pending') as pending,
             exists (select 1 from public.photo_requests r
                      where r.requester_user_id = app.current_user_id()
                        and r.owner_user_id = $1::uuid and r.status = 'declined'
                        and r.responded_at > now() - make_interval(days => $2::int)) as declined`,
          [target, PHOTO_REQUEST_COOLDOWN_DAYS],
        ),
      );
      const s = state[0]!;
      if (s.granted) throw conflict('You can already see these photos');
      if (s.requestable === 0) throw conflict('There are no photos to request');
      if (s.pending) throw conflict('You have already asked to see these photos');
      if (s.declined) throw conflict('This request was declined recently');

      const row = await db.asService('photo.request', async (session) => {
        const rows = await session.query<RequestRow>(
          `insert into public.photo_requests as r (requester_user_id, owner_user_id, message)
           values ($1::uuid, $2::uuid, $3)
           returning ${REQUEST_COLUMNS}`,
          [viewer, target, message ?? null],
        );
        const created = rows[0]!;
        // Identifiers only; the owner's app renders the words.
        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
           values ($1::uuid, 'photo_request', $2::jsonb, $3)
           on conflict do nothing`,
          [target, JSON.stringify({ requestId: created.id }), `photo_request:${created.id}`],
        );
        return created;
      });

      const cards = await cardsFor(viewer, [target]);
      return reply.code(201).send(toRequest(row, viewer, cards.get(target)));
    },
  );

  // --- GET /me/photo-requests ------------------------------------------------

  fastify.get('/me/photo-requests', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as {
      direction?: string;
      status?: string;
      cursor?: string;
      limit?: string;
    };
    if (query.direction !== undefined && !['incoming', 'outgoing'].includes(query.direction)) {
      throw badRequest('Invalid direction');
    }
    if (
      query.status !== undefined &&
      !(PHOTO_REQUEST_STATUSES as readonly string[]).includes(query.status)
    ) {
      throw badRequest('Invalid status');
    }
    const limit = parseLimit(query.limit);
    const after = decodeKeyset(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    // As the member: RLS shows only requests they are a party to. A request
    // whose other party they can no longer see (blocked, suspended) is left
    // out rather than shown without a face.
    const { viewer, rows } = await db.asUser(auth.authUserId, async (session) => {
      const viewer = await resolveViewer(session);
      const rows = await session.query<RequestRow>(
        `select ${REQUEST_COLUMNS}, ${keysetTime('r.created_at')} as cursor_at
           from public.photo_requests r
          where ($1::text is null
                 or ($1 = 'incoming' and r.owner_user_id = app.current_user_id())
                 or ($1 = 'outgoing' and r.requester_user_id = app.current_user_id()))
            and ($2::text is null or r.status = $2)
            and app.can_view_profile(
                  app.current_user_id(),
                  case when r.owner_user_id = app.current_user_id()
                       then r.requester_user_id else r.owner_user_id end)
            and ($3::timestamptz is null or (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
          order by r.created_at desc, r.id desc
          limit ${limit + 1}`,
        [query.direction ?? null, query.status ?? null, after?.at ?? null, after?.id ?? null],
      );
      return { viewer, rows };
    });
    if (!viewer) throw notFound('No account for this session');

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const cards = await cardsFor(
      viewer,
      page.map((r) => (r.requester_user_id === viewer ? r.owner_user_id : r.requester_user_id)),
    );
    const items = page
      .map((r) => {
        const other = r.requester_user_id === viewer ? r.owner_user_id : r.requester_user_id;
        const card = cards.get(other);
        return card ? toRequest(r, viewer, card) : null;
      })
      .filter((r) => r !== null);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last?.cursor_at ? encodeKeyset({ at: last.cursor_at, id: last.id }) : null,
      hasMore,
    };
  });

  // --- POST /me/photo-requests/:requestId/respond ----------------------------

  fastify.post(
    '/me/photo-requests/:requestId/respond',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const requestId = uuidParam(request, 'requestId', 'request id');
      const parsed = respondPhotoRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest('decision must be approve or decline');
      const approve = parsed.data.decision === 'approve';

      // Only the OWNER may answer, and only a request they can read (RLS).
      const mine = await db.asUser(auth.authUserId, (session) =>
        session.query<{ id: string; owner: string; requester: string }>(
          `select r.id, r.owner_user_id as owner, r.requester_user_id as requester
             from public.photo_requests r
            where r.id = $1::uuid and r.owner_user_id = app.current_user_id()
              and app.can_view_profile(app.current_user_id(), r.requester_user_id)`,
          [requestId],
        ),
      );
      const own = mine[0];
      if (!own) throw notFound('No such request');

      const row = await db.asService('photo.respond', async (session) => {
        const updated = await session.query<RequestRow>(
          `update public.photo_requests as r
              set status = $2, responded_at = now()
            where r.id = $1::uuid and r.owner_user_id = $3::uuid and r.status = 'pending'
            returning ${REQUEST_COLUMNS}`,
          [requestId, approve ? 'approved' : 'declined', own.owner],
        );
        const result = updated[0];
        if (!result) throw conflict('This request has already been answered');
        if (approve) {
          await session.query(
            `insert into public.photo_grants (owner_user_id, grantee_user_id, request_id)
             values ($1::uuid, $2::uuid, $3::uuid)
             on conflict do nothing`,
            [own.owner, own.requester, requestId],
          );
        }
        // The requester learns the answer; the payload carries only ids.
        await session.query(
          `insert into public.notifications (user_id, type, payload, dedupe_key)
           values ($1::uuid, 'photo_request_answered', $2::jsonb, $3)
           on conflict do nothing`,
          [
            own.requester,
            JSON.stringify({ requestId, approved: approve }),
            `photo_request_answered:${requestId}`,
          ],
        );
        return result;
      });

      const cards = await cardsFor(own.owner, [own.requester]);
      const card = cards.get(own.requester);
      if (!card) throw notFound('No such request');
      return toRequest(row, own.owner, card);
    },
  );
};
