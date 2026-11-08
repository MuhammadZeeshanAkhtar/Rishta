/**
 * Review N3: photos and profiles approved before human moderation existed, and
 * original photos stored before metadata stripping existed.
 *
 *   pnpm --filter @nikahmate/api legacy-content report
 *   pnpm --filter @nikahmate/api legacy-content scan-originals [--limit=N]
 *   pnpm --filter @nikahmate/api legacy-content strip-originals [--limit=N] [--apply]
 *   pnpm --filter @nikahmate/api legacy-content requeue [--limit=N] [--apply]
 *
 * DRY RUN BY DEFAULT. Nothing changes without `--apply`. Requeueing hides content
 * from other members until a moderator decides, so whether, when and how much is a
 * company decision: see docs/LEGACY_CONTENT_RUNBOOK.md before using it.
 *
 * NOTHING PRIVATE IS PRINTED. Counts and photo ids only, never a coordinate, an
 * image, a member's name, or a connection string.
 *
 * Reading and rewriting originals needs the Storage service-role key, in
 * LEGACY_TOOL_STORAGE_KEY. The API refuses to hold such a key (config.ts), so this
 * runs as a separate, supervised process and the key belongs nowhere else.
 *
 * WHAT COUNTS AS LEGACY:
 *   photo    approved, with no human approval on record. The old upload route
 *            recorded `auto_stub` and approved at once (fixed by review B5).
 *   profile  approved, with no `profile.approve` audit row. Submission used to
 *            approve at once (fixed by review B6).
 *   original `original_needs_strip`, set by migration 0033 on every row that
 *            existed then. Files already clean are cleared without being rewritten.
 *
 * Safe to repeat: a finished item no longer matches, so a second run changes nothing.
 */

import type { PhotoContentType } from '@nikahmate/domain';
import sharp from 'sharp';
import { Client, type QueryResultRow } from 'pg';
import { databaseConnection, explainTlsFailure } from '../src/db/tls';
import { createStorageClient, type StorageClient } from '../src/storage/client';
import { stripOriginal } from '../src/storage/variants';
import type { Queryable } from './phase1-security-checks';

const LEGACY_PHOTOS = `
  from public.photos p
 where p.deleted_at is null
   and p.moderation_status = 'approved'
   and not exists (
     select 1 from public.media_moderation_results r
      where r.photo_id = p.id and r.provider = 'human' and r.verdict = 'approved'
   )`;

const LEGACY_PROFILES = `
  from public.profiles pf
 where pf.deleted_at is null
   and pf.review_status = 'approved'
   and not exists (
     select 1 from public.admin_action_audit a
      where a.action = 'profile.approve' and a.target_type = 'profile'
        and a.target_id = pf.user_id
   )`;

export interface LegacyReport {
  legacyPhotos: number;
  legacyPrimaryPhotos: number;
  legacyPublicPhotos: number;
  legacyProfiles: number;
  originalsToClean: number;
  pendingPhotoQueue: number;
  pendingProfileQueue: number;
}

export async function legacyReport(db: Queryable): Promise<LegacyReport> {
  const n = async (sql: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n ${sql}`);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    legacyPhotos: await n(LEGACY_PHOTOS),
    legacyPrimaryPhotos: await n(`${LEGACY_PHOTOS} and p.is_primary`),
    legacyPublicPhotos: await n(`${LEGACY_PHOTOS} and p.visibility = 'public'`),
    legacyProfiles: await n(LEGACY_PROFILES),
    originalsToClean: await n(
      `from public.photos p where p.deleted_at is null and p.original_needs_strip`,
    ),
    pendingPhotoQueue: await n(
      `from public.photos p where p.deleted_at is null and p.moderation_status = 'pending'
         and exists (select 1 from public.photo_variants v where v.photo_id = p.id)`,
    ),
    pendingProfileQueue: await n(
      `from public.profiles pf where pf.deleted_at is null and pf.review_status = 'pending'
         and pf.submitted_at is not null`,
    ),
  };
}

// --- metadata ----------------------------------------------------------------

export interface ImageMetadata {
  exif: boolean;
  gps: boolean;
  xmp: boolean;
  iptc: boolean;
}

/**
 * Whether an EXIF block has a GPS pointer, read from the block's structure rather
 * than by decoding any value. The coordinates are never read.
 */
export function exifHasGpsPointer(exif: Buffer): boolean {
  const start = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
  if (exif.length < start + 8) return false;
  const order = exif.subarray(start, start + 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const u16 = (at: number) => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const u32 = (at: number) => (little ? exif.readUInt32LE(at) : exif.readUInt32BE(at));

  const ifd = start + u32(start + 4);
  if (ifd + 2 > exif.length) return false;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 2 > exif.length) return false;
    if (u16(entry) === 0x8825) return true;
  }
  return false;
}

export async function readImageMetadata(body: Buffer): Promise<ImageMetadata> {
  const meta = await sharp(body).metadata();
  return {
    exif: Boolean(meta.exif),
    gps: meta.exif ? exifHasGpsPointer(meta.exif) : false,
    xmp: Boolean(meta.xmp),
    iptc: Boolean(meta.iptc),
  };
}

const carriesMetadata = (m: ImageMetadata): boolean => m.exif || m.xmp || m.iptc;

// --- originals ---------------------------------------------------------------

export interface StripSummary {
  scanned: number;
  withExif: number;
  withGps: number;
  withOtherMetadata: number;
  alreadyClean: number;
  cleaned: number;
  failed: number;
  failedPhotoIds: string[];
  applied: boolean;
}

/**
 * Finds what is in each marked original and, with `apply`, removes it. A photo's
 * mark is cleared only after its file has been re-read and found clean, so a failed
 * or partial run leaves that photo withheld, and the next run retries it.
 */
export async function stripLegacyOriginals(
  db: Queryable,
  storage: StorageClient,
  serviceToken: string,
  options: { apply?: boolean; limit?: number } = {},
): Promise<StripSummary> {
  const apply = options.apply ?? false;
  const limit = options.limit ?? 500;
  const { rows } = await db.query<{ id: string; storage_path: string; content_type: string }>(
    `select p.id, p.storage_path, p.content_type
       from public.photos p
      where p.deleted_at is null and p.original_needs_strip
      order by p.created_at, p.id
      limit $1`,
    [limit],
  );

  const summary: StripSummary = {
    scanned: 0,
    withExif: 0,
    withGps: 0,
    withOtherMetadata: 0,
    alreadyClean: 0,
    cleaned: 0,
    failed: 0,
    failedPhotoIds: [],
    applied: apply,
  };

  for (const row of rows) {
    summary.scanned += 1;
    try {
      const original = await storage.download(serviceToken, row.storage_path);
      const found = await readImageMetadata(original);
      if (found.exif) summary.withExif += 1;
      if (found.gps) summary.withGps += 1;
      if (found.xmp || found.iptc) summary.withOtherMetadata += 1;

      if (!carriesMetadata(found)) {
        // Clean already: clear the mark without re-encoding, which would lose quality.
        summary.alreadyClean += 1;
        if (apply) await clearMark(db, row.id);
        continue;
      }
      if (!apply) continue;

      const clean = await stripOriginal(original, row.content_type as PhotoContentType);
      // Checked before the original is replaced, not assumed from the re-encode.
      if (carriesMetadata(await readImageMetadata(clean))) {
        throw new Error('metadata survived re-encoding');
      }
      await storage.upload(serviceToken, row.storage_path, clean, row.content_type);
      // And checked again as stored, before the photo can be served.
      const stored = await storage.download(serviceToken, row.storage_path);
      if (carriesMetadata(await readImageMetadata(stored))) {
        throw new Error('metadata present after upload');
      }
      await clearMark(db, row.id);
      summary.cleaned += 1;
    } catch {
      // The reason may name a path. Report the id; the photo stays withheld.
      summary.failed += 1;
      summary.failedPhotoIds.push(row.id);
    }
  }
  return summary;
}

const clearMark = (db: Queryable, photoId: string) =>
  db.query(`update public.photos set original_needs_strip = false where id = $1::uuid`, [photoId]);

// --- re-review ---------------------------------------------------------------

export interface RequeueSummary {
  photos: number;
  profiles: number;
  applied: boolean;
}

/**
 * Sends legacy content back to the moderation queue, which hides it from other
 * members until a moderator decides. Oldest first, `limit` of each per run, so the
 * queue can be paced to what the moderators can actually get through.
 *
 * An unapproved photo cannot be anyone's main photo (`photos_primary_approved`), so
 * that fact is kept and restored if the photo is approved again.
 */
export async function requeueLegacyContent(
  db: Queryable,
  options: { apply?: boolean; limit?: number } = {},
): Promise<RequeueSummary> {
  const apply = options.apply ?? false;
  const limit = options.limit ?? 100;

  if (!apply) {
    const report = await legacyReport(db);
    return {
      photos: Math.min(report.legacyPhotos, limit),
      profiles: Math.min(report.legacyProfiles, limit),
      applied: false,
    };
  }

  await db.query('begin');
  try {
    const photos = await db.query<{ id: string }>(
      `with due as (
         select p.id ${LEGACY_PHOTOS}
          order by p.created_at, p.id
          limit $1
          for update of p
       )
       update public.photos target
          set moderation_status = 'pending',
              moderated_at = null,
              primary_before_requeue = target.is_primary,
              is_primary = false
         from due
        where target.id = due.id
       returning target.id`,
      [limit],
    );
    if (photos.rows.length > 0) {
      await db.query(
        `insert into public.media_moderation_results (photo_id, provider, verdict, labels)
         select id, 'none', 'review', $2::jsonb from unnest($1::uuid[]) as q (id)`,
        [
          photos.rows.map((r) => r.id),
          JSON.stringify({ note: 'legacy auto-approval, queued for human review' }),
        ],
      );
    }

    const profiles = await db.query<{ user_id: string }>(
      `with due as (
         select pf.user_id ${LEGACY_PROFILES}
          order by pf.submitted_at nulls first, pf.user_id
          limit $1
          for update of pf
       )
       update public.profiles target
          set review_status = 'pending',
              reviewed_at = null,
              -- The moderation queue reads submitted_at.
              submitted_at = coalesce(target.submitted_at, now())
         from due
        where target.user_id = due.user_id
       returning target.user_id`,
      [limit],
    );
    if (profiles.rows.length > 0) {
      // The "profile reviewed" badge said a person had looked. None had.
      await db.query(
        `update public.verification_status set profile_reviewed_at = null
          where user_id = any($1::uuid[])`,
        [profiles.rows.map((r) => r.user_id)],
      );
    }
    await db.query('commit');
    return { photos: photos.rows.length, profiles: profiles.rows.length, applied: true };
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
}

// --- command line ------------------------------------------------------------

async function main(): Promise<void> {
  const write = (line: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  };
  const [command] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg === undefined ? undefined : Number(limitArg);

  if (!['report', 'scan-originals', 'strip-originals', 'requeue'].includes(command ?? '')) {
    write({ level: 'error', msg: 'usage: report | scan-originals | strip-originals | requeue' });
    process.exit(2);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    write({ level: 'error', msg: '--limit must be a positive whole number' });
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    write({ level: 'error', msg: 'DATABASE_URL is not set' });
    process.exit(2);
  }

  const { connectionString, ssl } = databaseConnection(url);
  const client = new Client({ connectionString, ssl, application_name: 'nikahmate-legacy' });
  try {
    await client.connect();
  } catch (error) {
    write({ level: 'error', msg: explainTlsFailure(error) ?? 'could not connect to the database' });
    process.exit(1);
  }
  const db: Queryable = {
    query: <T>(sql: string, params?: unknown[]) => client.query<T & QueryResultRow>(sql, params),
  };

  try {
    if (command === 'report') {
      write({ level: 'info', command, ...(await legacyReport(db)) });
    } else if (command === 'requeue') {
      write({
        level: 'info',
        command,
        ...(await requeueLegacyContent(db, { apply, ...(limit ? { limit } : {}) })),
      });
    } else {
      const key = process.env.LEGACY_TOOL_STORAGE_KEY;
      const supabaseUrl = process.env.SUPABASE_URL;
      if (!key || !supabaseUrl) {
        write({ level: 'error', msg: 'LEGACY_TOOL_STORAGE_KEY and SUPABASE_URL are required' });
        process.exit(2);
      }
      const storage = createStorageClient({ supabaseUrl, publishableKey: key });
      write({
        level: 'info',
        command,
        ...(await stripLegacyOriginals(db, storage, key, {
          // `scan-originals` is the same pass with no way to write.
          apply: command === 'strip-originals' && apply,
          ...(limit ? { limit } : {}),
        })),
      });
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// Only when run as a script: tests import the functions above.
if (process.argv[1] && /legacy-content\.ts$/.test(process.argv[1])) {
  void main();
}
