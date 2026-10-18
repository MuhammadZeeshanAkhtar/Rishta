import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  MAX_PHOTOS_PER_USER,
  VISIBILITY_FIELD_KEYS,
  createUploadRequestSchema,
  fieldVisibilityMapSchema,
  photoReorderSchema,
  photoUpdateSchema,
  type OwnPhoto,
} from '@nikahmate/domain';
import { badRequest, conflict, notFound } from '../errors';
import { bearerFrom, type AuthContext } from '../auth/verify';
import { requireAuthContext } from '../auth/plugin';
import type { Db, DbSession } from '../db/types';
import { isoTimestamp } from '../db/sql';
import type { StorageClient } from '../storage/client';
import { SIGNED_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from '../storage/client';
import { generateVariants, readDimensions } from '../storage/variants';

/**
 * Photos, and the per-field profile visibility left over from Phase 3.
 *
 * Both live here because they are the same product surface — a Privacy Center
 * — and splitting them across two route files would mean two places to look
 * for "what can other people see about me".
 *
 * Everything runs as `asUser`, so RLS scopes every statement to the caller.
 * Storage is reached with the caller's own token (see storage/client.ts), so
 * there is no service-role key anywhere in this flow.
 */

interface PhotoRow {
  id: string;
  visibility: string;
  position: number;
  is_primary: boolean;
  moderation_status: string;
  rejection_reason_key: string | null;
  width: number | null;
  height: number | null;
  storage_path: string;
  created_at: string;
  thumb_path: string | null;
}

const PHOTO_SELECT = `
  select p.id, p.visibility, p.position, p.is_primary, p.moderation_status,
         p.rejection_reason_key, p.width, p.height, p.storage_path,
         ${isoTimestamp('p.created_at')} as created_at,
         (select v.storage_path from public.photo_variants v
           where v.photo_id = p.id and v.variant = 'thumb') as thumb_path
  from public.photos p
  where p.deleted_at is null
  order by p.position, p.created_at
`;

export interface PhotoRoutesOptions {
  db: Db;
  storage: StorageClient;
}

export const photoRoutes: FastifyPluginAsync<PhotoRoutesOptions> = async (
  fastify,
  { db, storage },
) => {
  /**
   * The caller's raw token, for Storage.
   *
   * Storage needs the JWT itself, not the decoded claims, because it does its
   * own verification and applies RLS as that user. Re-reading the header is
   * the honest way to get it — the auth context deliberately does not keep the
   * token around.
   */
  const tokenOf = (authorization: string | undefined): string => {
    const token = bearerFrom(authorization);
    if (!token) throw notFound('No token for storage access');
    return token;
  };

  const resolveUserId = (auth: AuthContext): Promise<string> =>
    db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<{ id: string }>(`select id from public.users`);
      const id = rows[0]?.id;
      if (!id) throw notFound('No account for this session');
      return id;
    });

  /**
   * Signs the URLs a photo can expose to its owner.
   *
   * `full` is only signed once moderation has passed. Before that the owner
   * sees their own thumbnail and nothing else — a photo that has not been
   * checked should not be fetchable at full resolution even by the person who
   * uploaded it, because that URL is the thing that gets forwarded.
   */
  const toOwnPhoto = async (row: PhotoRow, token: string): Promise<OwnPhoto> => {
    const [thumb, full] = await Promise.all([
      row.thumb_path ? storage.createSignedUrl(token, row.thumb_path) : Promise.resolve(null),
      row.moderation_status === 'approved'
        ? storage.createSignedUrl(token, row.storage_path)
        : Promise.resolve(null),
    ]);

    return {
      id: row.id,
      visibility: row.visibility as OwnPhoto['visibility'],
      position: row.position,
      isPrimary: row.is_primary,
      moderationStatus: row.moderation_status as OwnPhoto['moderationStatus'],
      rejectionReasonKey: row.rejection_reason_key,
      width: row.width,
      height: row.height,
      urls: { thumb, full },
      createdAt: row.created_at,
    };
  };

  const listPhotos = (session: DbSession): Promise<PhotoRow[]> =>
    session.query<PhotoRow>(PHOTO_SELECT);

  // --- GET /me/photos --------------------------------------------------------

  fastify.get('/me/photos', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const token = tokenOf(request.headers.authorization);
    const rows = await db.asUser(auth.authUserId, listPhotos);
    return { items: await Promise.all(rows.map((row) => toOwnPhoto(row, token))) };
  });

  // --- POST /me/photos/upload-url --------------------------------------------

  fastify.post(
    '/me/photos/upload-url',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const parsed = createUploadRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid upload request',
          Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
        );
      }

      const token = tokenOf(request.headers.authorization);
      const userId = await resolveUserId(auth);
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[
        parsed.data.contentType
      ];

      /**
       * The folder segment is a fresh uuid rather than the row's own id.
       *
       * `photos.id` carries no INSERT grant — the grant lists exactly the fields
       * a member may set, and an id is not one of them — so the row id is
       * produced by the column default and is not available while building the
       * path. A separate uuid keeps the path unique without widening that grant,
       * and `storage_path` on the row is what maps one to the other.
       *
       * What matters is the FIRST segment: the owner's id, which is what the
       * Storage policy checks and what `photos_storage_path_owned` checks. Both
       * sides agree, so a mismatched path cannot be written at all.
       */
      const folder = randomUUID();
      const path = `${userId}/${folder}/original.${extension}`;

      const row = await db.asUser(auth.authUserId, async (session) => {
        const existing = await session.query<{ n: number }>(
          `select count(*)::int as n from public.photos where deleted_at is null`,
        );
        if ((existing[0]?.n ?? 0) >= MAX_PHOTOS_PER_USER) {
          throw conflict(`At most ${MAX_PHOTOS_PER_USER} photos`);
        }

        const inserted = await session.query<{ id: string }>(
          `insert into public.photos
           (user_id, storage_path, content_type, byte_size, position)
         values ($1, $2, $3, $4,
                 coalesce((select max(position) + 1 from public.photos where deleted_at is null), 0))
         returning id`,
          [userId, path, parsed.data.contentType, parsed.data.byteSize],
        );
        return inserted[0]!;
      });

      const { uploadUrl } = await storage.createSignedUploadUrl(token, path);

      return reply.code(201).send({
        photoId: row.id,
        uploadUrl,
        method: 'PUT' as const,
        headers: { 'Content-Type': parsed.data.contentType },
        path,
        expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      });
    },
  );

  // --- POST /me/photos/:photoId/finalize -------------------------------------

  fastify.post(
    '/me/photos/:photoId/finalize',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { photoId } = request.params as { photoId: string };
      const token = tokenOf(request.headers.authorization);

      const photo = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<PhotoRow>(
          `${PHOTO_SELECT.replace('where p.deleted_at is null', 'where p.deleted_at is null and p.id = $1')}`,
          [photoId],
        );
        const row = rows[0];
        if (!row) throw notFound('No such photo');
        return row;
      });

      // Fetched with the caller's own token, so Storage RLS confirms the
      // object really is theirs before a single byte is processed.
      const original = await storage.download(token, photo.storage_path);

      let dimensions;
      try {
        dimensions = await readDimensions(original);
      } catch {
        // Not a decodable image. The row is marked rejected rather than left
        // pending, so it cannot sit in the moderation queue forever.
        await db.asService('photo.record_moderation', (session) =>
          session.query(
            `update public.photos
             set moderation_status = 'rejected', rejection_reason_key = 'errors.photoUnreadable',
                 moderated_at = now()
             where id = $1`,
            [photoId],
          ),
        );
        throw badRequest('That file is not a readable image');
      }

      const variants = await generateVariants(original);
      const basePath = photo.storage_path.replace(/\/original\.[a-z]+$/, '');

      await Promise.all(
        variants.map((v) =>
          storage.upload(token, `${basePath}/${v.variant}.jpg`, v.body, v.contentType),
        ),
      );

      /**
       * Variants, dimensions and the moderation verdict are written by the
       * server. Members hold no grant on `photo_variants` or on
       * `moderation_status` — a member who could write either could point the
       * blurred variant at the original, or approve their own photo.
       */
      await db.asService('photo.record_moderation', async (session) => {
        for (const v of variants) {
          await session.query(
            `insert into public.photo_variants (photo_id, variant, storage_path, width, height, byte_size)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (photo_id, variant) do update set
               storage_path = excluded.storage_path,
               width = excluded.width, height = excluded.height,
               byte_size = excluded.byte_size`,
            [photoId, v.variant, `${basePath}/${v.variant}.jpg`, v.width, v.height, v.body.length],
          );
        }

        // The moderation hook. Automated screening is a Phase 8 concern
        // (and Gemini triage is 1.2); what matters now is that the decision
        // is RECORDED and that nothing is visible until it says approved.
        await session.query(
          `insert into public.media_moderation_results (photo_id, provider, verdict, labels)
           values ($1, 'auto_stub', 'approved', $2::jsonb)`,
          [photoId, JSON.stringify({ note: 'no automated provider configured' })],
        );

        await session.query(
          `update public.photos
           set width = $2, height = $3, moderation_status = 'approved', moderated_at = now()
           where id = $1`,
          [photoId, dimensions.width, dimensions.height],
        );
      });

      const updated = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<PhotoRow>(
          `${PHOTO_SELECT.replace('where p.deleted_at is null', 'where p.deleted_at is null and p.id = $1')}`,
          [photoId],
        );
        return rows[0]!;
      });

      return reply.code(202).send(await toOwnPhoto(updated, token));
    },
  );

  // --- PATCH /me/photos/:photoId ---------------------------------------------

  fastify.patch('/me/photos/:photoId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const { photoId } = request.params as { photoId: string };
    const parsed = photoUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid photo update');

    const token = tokenOf(request.headers.authorization);
    const patch = parsed.data;

    const row = await db.asUser(auth.authUserId, async (session) => {
      // Primary is exclusive, and the database enforces it with a partial
      // unique index — so the old one has to be cleared in the same
      // transaction rather than hoping the order of writes works out.
      if (patch.isPrimary === true) {
        await session.query(
          `update public.photos set is_primary = false where is_primary and id <> $1`,
          [photoId],
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [photoId];
      for (const [key, column] of Object.entries({
        visibility: 'visibility',
        position: 'position',
        isPrimary: 'is_primary',
      })) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined) {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        }
      }
      if (sets.length === 0) throw badRequest('No changes supplied');

      const updated = await session.query<{ id: string }>(
        `update public.photos set ${sets.join(', ')} where id = $1 returning id`,
        params,
      );
      if (updated.length === 0) throw notFound('No such photo');

      const rows = await session.query<PhotoRow>(
        `${PHOTO_SELECT.replace('where p.deleted_at is null', 'where p.deleted_at is null and p.id = $1')}`,
        [photoId],
      );
      return rows[0]!;
    });

    return toOwnPhoto(row, token);
  });

  // --- PUT /me/photos/order --------------------------------------------------

  fastify.put('/me/photos/order', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const parsed = photoReorderSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid order');
    const token = tokenOf(request.headers.authorization);

    const rows = await db.asUser(auth.authUserId, async (session) => {
      // One statement, so a half-applied reorder is impossible. RLS scopes it
      // to the caller, so an id belonging to someone else simply matches
      // nothing rather than reordering their gallery.
      await session.query(
        `update public.photos as p
         set position = v.position
         from (select unnest($1::uuid[]) as id, generate_subscripts($1::uuid[], 1) - 1 as position) as v
         where p.id = v.id and p.deleted_at is null`,
        [parsed.data.photoIds],
      );
      return listPhotos(session);
    });

    return { items: await Promise.all(rows.map((row) => toOwnPhoto(row, token))) };
  });

  // --- DELETE /me/photos/:photoId --------------------------------------------

  fastify.delete(
    '/me/photos/:photoId',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { photoId } = request.params as { photoId: string };
      const token = tokenOf(request.headers.authorization);

      const paths = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<{ storage_path: string }>(
          `select storage_path from public.photos where id = $1 and deleted_at is null`,
          [photoId],
        );
        if (rows.length === 0) throw notFound('No such photo');

        const variants = await session.query<{ storage_path: string }>(
          `select storage_path from public.photo_variants where photo_id = $1`,
          [photoId],
        );

        return [...rows, ...variants].map((r) => r.storage_path);
      });

      // Soft delete runs as the server. A member-run UPDATE cannot do this:
      // FORCE RLS requires the new row to remain visible under
      // `photos_select_own`, which filters `deleted_at is null` (migration 0008).
      // The row survives for abuse investigation (E1); the bytes do not.
      await db.asService('photo.soft_delete', (session) =>
        session.query(
          `update public.photos set deleted_at = now(), is_primary = false where id = $1`,
          [photoId],
        ),
      );

      // Bytes go immediately. The row survives for investigation; the image
      // does not need to.
      await storage.remove(token, paths);
      return reply.code(204).send();
    },
  );

  // ===========================================================================
  // Per-field profile visibility — the Phase 3 gap
  // ===========================================================================

  /**
   * Defaults for the fourteen controllable keys (ERD E6).
   *
   * Absent rows mean "default", so this is what the client sees before anyone
   * has touched the screen. Chosen to be useful rather than maximally closed:
   * a profile where everything is hidden is not a profile, and someone who
   * never opens this screen should still be findable.
   */
  const VISIBILITY_DEFAULTS: Record<string, string> = {
    profession: 'matched_only',
    industry: 'public',
    employment_status: 'public',
    institution: 'matched_only',
    education_level: 'public',
    field_of_study: 'public',
    location_precision: 'city',
    height: 'public',
    nationality: 'public',
    family_background: 'matched_only',
    sect: 'public',
    children_details: 'matched_only',
    hobbies_and_lifestyle: 'public',
    about_me: 'public',
  };

  fastify.get('/me/profile/visibility', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<{ field_key: string; visibility: string }>(
        `select field_key, visibility from public.profile_field_visibility`,
      ),
    );
    const stored = Object.fromEntries(rows.map((r) => [r.field_key, r.visibility]));
    return { ...VISIBILITY_DEFAULTS, ...stored };
  });

  fastify.put('/me/profile/visibility', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const parsed = fieldVisibilityMapSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid visibility map');

    const userId = await resolveUserId(auth);
    const entries = Object.entries(parsed.data).filter(([key]) =>
      (VISIBILITY_FIELD_KEYS as readonly string[]).includes(key),
    );

    const rows = await db.asUser(auth.authUserId, async (session) => {
      for (const [key, value] of entries) {
        // The CHECK constraints are the real control — about_me cannot be
        // hidden entirely, and location_precision takes its own value set —
        // so a bad pair is refused by the database, not just by this route.
        await session.query(
          `insert into public.profile_field_visibility (user_id, field_key, visibility)
           values ($1, $2, $3)
           on conflict (user_id, field_key) do update set visibility = excluded.visibility`,
          [userId, key, value],
        );
      }
      return session.query<{ field_key: string; visibility: string }>(
        `select field_key, visibility from public.profile_field_visibility`,
      );
    });

    const stored = Object.fromEntries(rows.map((r) => [r.field_key, r.visibility]));
    return { ...VISIBILITY_DEFAULTS, ...stored };
  });

  void SIGNED_URL_TTL_SECONDS;
};
