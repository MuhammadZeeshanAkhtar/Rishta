import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  exifHasGpsPointer,
  legacyReport,
  readImageMetadata,
  requeueLegacyContent,
  stripLegacyOriginals,
} from '../scripts/legacy-content';
import type { Queryable } from '../scripts/phase1-security-checks';
import {
  authHeader,
  createHarness,
  createMemoryStorage,
  randomAuthId,
  type MemoryStorage,
  type TestHarness,
} from './helpers';

/**
 * Review N3, against real migrations and real image files carrying real EXIF. It
 * never touches a hosted database or real Storage: the storage here is in memory.
 */

const SERVICE_TOKEN = 'not-a-real-key';

const GPS = {
  IFD0: { Copyright: 'someone' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '31/1 31/1 0/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '74/1 21/1 0/1',
  },
};

const image = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } } });

const withGps = () => image().withExif(GPS).jpeg().toBuffer();
const clean = () => image().jpeg().toBuffer();

let pg: PGlite;
let db: Queryable;
let storage: MemoryStorage;

const seedUser = async (): Promise<string> => {
  const users = await pg.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ('Member', 'female', date '1995-06-15', 'pk', 'active') returning id`,
  );
  return users.rows[0]!.id;
};

const seedPhoto = async (
  owner: string,
  options: {
    status?: string;
    primary?: boolean;
    needsStrip?: boolean;
    body?: Buffer;
    missing?: boolean;
    provider?: string;
  } = {},
) => {
  const path = `${owner}/${randomAuthId()}/original.jpg`;
  const rows = await pg.query<{ id: string }>(
    `insert into public.photos
       (user_id, storage_path, content_type, moderation_status, is_primary, original_needs_strip, visibility)
     values ($1::uuid, $2, 'image/jpeg', $3, $4, $5, 'public') returning id`,
    [
      owner,
      path,
      options.status ?? 'approved',
      options.primary ?? false,
      options.needsStrip ?? false,
    ],
  );
  const id = rows.rows[0]!.id;
  await pg.query(
    `insert into public.photo_variants (photo_id, variant, storage_path) values ($1::uuid, 'thumb', $2)`,
    [id, path.replace('original.jpg', 'thumb.jpg')],
  );
  if (options.provider) {
    await pg.query(
      `insert into public.media_moderation_results (photo_id, provider, verdict, labels)
       values ($1::uuid, $2, 'approved', '{}'::jsonb)`,
      [id, options.provider],
    );
  }
  if (!options.missing) {
    storage.put(path, options.body ?? (await clean()), 'image/jpeg');
  }
  return { id, path };
};

const seedProfile = async (owner: string, status = 'approved') => {
  await pg.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.', 'ms_never_married', 'rel_practising', $2, now())`,
    [owner, status],
  );
  await pg.query(
    `insert into public.verification_status (user_id, profile_reviewed_at) values ($1::uuid, now())`,
    [owner],
  );
};

const photoRow = async (id: string) =>
  (
    await pg.query<{
      moderation_status: string;
      is_primary: boolean;
      original_needs_strip: boolean;
      primary_before_requeue: boolean;
    }>(
      `select moderation_status, is_primary, original_needs_strip, primary_before_requeue
         from public.photos where id = $1::uuid`,
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  await pg.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'), ('religious_practice', 'rel_practising'),
      ('country', 'pk')
    on conflict (type, code) do nothing
  `);
  db = { query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]) };
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  storage = createMemoryStorage();
  await pg.exec(`
    delete from public.media_moderation_results;
    delete from public.photo_variants;
    delete from public.photos;
    delete from public.verification_status;
    delete from public.profiles;
  `);
});

describe('migration 0033 marks what already existed', () => {
  it('marks every photo present at the time, and only those', async () => {
    const before = new PGlite();
    try {
      await applyMigrations(before, { through: '20261106000032' });
      await before.exec(
        `insert into public.reference_items (type, code) values ('country', 'pk') on conflict do nothing`,
      );
      const user = await before.query<{ id: string }>(
        `insert into public.users (display_name, gender, date_of_birth, country_code, status)
         values ('Old', 'female', date '1995-06-15', 'pk', 'active') returning id`,
      );
      const old = await before.query<{ id: string }>(
        `insert into public.photos (user_id, storage_path, content_type, moderation_status)
         values ($1::uuid, $2, 'image/jpeg', 'approved') returning id`,
        [user.rows[0]!.id, `${user.rows[0]!.id}/old/original.jpg`],
      );

      await applyMigrations(before, { from: '20261106000033' });

      const marked = await before.query<{
        original_needs_strip: boolean;
        moderation_status: string;
      }>(`select original_needs_strip, moderation_status from public.photos where id = $1::uuid`, [
        old.rows[0]!.id,
      ]);
      // Marked, and its visibility untouched: applying the migration hides nothing.
      expect(marked.rows[0]).toEqual({ original_needs_strip: true, moderation_status: 'approved' });

      const fresh = await before.query<{ original_needs_strip: boolean }>(
        `insert into public.photos (user_id, storage_path, content_type)
         values ($1::uuid, $2, 'image/jpeg') returning original_needs_strip`,
        [user.rows[0]!.id, `${user.rows[0]!.id}/new/original.jpg`],
      );
      expect(fresh.rows[0]!.original_needs_strip).toBe(false);
    } finally {
      await before.close();
    }
  }, 180_000);
});

describe('EXIF detection, on real files', () => {
  it('finds EXIF and a GPS pointer, without reading any coordinate', async () => {
    const found = await readImageMetadata(await withGps());
    expect(found.exif).toBe(true);
    expect(found.gps).toBe(true);
  });

  it('a file with EXIF but no location is not called a GPS leak', async () => {
    const body = await image()
      .withExif({ IFD0: { Copyright: 'someone' } })
      .jpeg()
      .toBuffer();
    const found = await readImageMetadata(body);
    expect(found.exif).toBe(true);
    expect(found.gps).toBe(false);
  });

  it('a clean file shows nothing', async () => {
    expect(await readImageMetadata(await clean())).toEqual({
      exif: false,
      gps: false,
      xmp: false,
      iptc: false,
    });
  });

  it('finds XMP, which also carries location data', async () => {
    const body = await image().withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>').jpeg().toBuffer();
    expect((await readImageMetadata(body)).xmp).toBe(true);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['too short', Buffer.from('Exif\0\0II')],
    ['not TIFF', Buffer.from('Exif\0\0XX*\0\x08\0\0\0\0\0')],
    ['pointing outside itself', Buffer.from('Exif\0\0II*\0\xff\xff\0\0')],
  ])('a malformed block does not throw: %s', (_label, body) => {
    expect(exifHasGpsPointer(body)).toBe(false);
  });
});

describe('stripLegacyOriginals', () => {
  it('a dry run reports what it found and changes nothing', async () => {
    const owner = await seedUser();
    const body = await withGps();
    const photo = await seedPhoto(owner, { needsStrip: true, body });
    const summary = await stripLegacyOriginals(db, storage, SERVICE_TOKEN);
    expect(summary).toMatchObject({
      scanned: 1,
      withExif: 1,
      withGps: 1,
      cleaned: 0,
      applied: false,
    });
    expect(storage.objects.get(photo.path)!.body.equals(body)).toBe(true);
    expect((await photoRow(photo.id)).original_needs_strip).toBe(true);
  });

  it('with apply the stored file loses its metadata, and the mark clears', async () => {
    const owner = await seedUser();
    const photo = await seedPhoto(owner, { needsStrip: true, body: await withGps() });
    const summary = await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true });
    expect(summary).toMatchObject({ cleaned: 1, failed: 0, applied: true });

    const stored = storage.objects.get(photo.path)!.body;
    expect(await readImageMetadata(stored)).toEqual({
      exif: false,
      gps: false,
      xmp: false,
      iptc: false,
    });
    expect((await sharp(stored).metadata()).width).toBe(64);
    expect((await photoRow(photo.id)).original_needs_strip).toBe(false);
  });

  it('a file already clean is cleared without being rewritten', async () => {
    const owner = await seedUser();
    const body = await clean();
    const photo = await seedPhoto(owner, { needsStrip: true, body });
    const summary = await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true });
    expect(summary).toMatchObject({ alreadyClean: 1, cleaned: 0 });
    expect(storage.objects.get(photo.path)!.body.equals(body)).toBe(true);
    expect((await photoRow(photo.id)).original_needs_strip).toBe(false);
  });

  it('a second run changes nothing', async () => {
    const owner = await seedUser();
    await seedPhoto(owner, { needsStrip: true, body: await withGps() });
    await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true });
    expect(await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true })).toMatchObject({
      scanned: 0,
    });
  });

  it('an unmarked photo is left alone', async () => {
    const owner = await seedUser();
    const body = await withGps();
    const photo = await seedPhoto(owner, { needsStrip: false, body });
    expect(await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true })).toMatchObject({
      scanned: 0,
    });
    expect(storage.objects.get(photo.path)!.body.equals(body)).toBe(true);
  });

  it('a missing file keeps its mark, is reported by id only, and does not stop the run', async () => {
    const owner = await seedUser();
    const gone = await seedPhoto(owner, { needsStrip: true, missing: true });
    const fine = await seedPhoto(owner, { needsStrip: true, body: await withGps() });
    const summary = await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { apply: true });
    expect(summary).toMatchObject({ scanned: 2, cleaned: 1, failed: 1 });
    expect(summary.failedPhotoIds).toEqual([gone.id]);
    expect((await photoRow(gone.id)).original_needs_strip).toBe(true);
    expect((await photoRow(fine.id)).original_needs_strip).toBe(false);
  });

  it('a failed upload leaves the original and the mark in place', async () => {
    const owner = await seedUser();
    const body = await withGps();
    const photo = await seedPhoto(owner, { needsStrip: true, body });
    const failing: MemoryStorage = {
      ...storage,
      async upload() {
        throw new Error('storage unavailable');
      },
    };
    const summary = await stripLegacyOriginals(db, failing, SERVICE_TOKEN, { apply: true });
    expect(summary.failed).toBe(1);
    expect((await photoRow(photo.id)).original_needs_strip).toBe(true);
    expect(storage.objects.get(photo.path)!.body.equals(body)).toBe(true);
  });

  it('if storage hands back a file still carrying metadata, the mark stays', async () => {
    const owner = await seedUser();
    const dirty = await withGps();
    const photo = await seedPhoto(owner, { needsStrip: true, body: dirty });
    const lying: MemoryStorage = {
      ...storage,
      async upload() {},
    };
    const summary = await stripLegacyOriginals(db, lying, SERVICE_TOKEN, { apply: true });
    expect(summary.failed).toBe(1);
    expect((await photoRow(photo.id)).original_needs_strip).toBe(true);
  });

  it('nothing it reports can identify a place or a path', async () => {
    const owner = await seedUser();
    await seedPhoto(owner, { needsStrip: true, body: await withGps() });
    const printed = JSON.stringify(await stripLegacyOriginals(db, storage, SERVICE_TOKEN));
    expect(printed).not.toContain(owner);
    expect(printed).not.toMatch(/31\/1|74\/1|GPSLatitude/);
  });

  it('respects the limit', async () => {
    const owner = await seedUser();
    for (let i = 0; i < 3; i += 1) await seedPhoto(owner, { needsStrip: true });
    expect(await stripLegacyOriginals(db, storage, SERVICE_TOKEN, { limit: 2 })).toMatchObject({
      scanned: 2,
    });
  });
});

describe('legacyReport', () => {
  it('counts auto-approvals, and not what a person approved', async () => {
    const owner = await seedUser();
    await seedPhoto(owner, { provider: 'auto_stub', primary: true });
    await seedPhoto(owner, { provider: 'human' });
    await seedPhoto(owner, { status: 'pending' });
    await seedPhoto(owner, { status: 'rejected' });
    await seedProfile(owner);
    const report = await legacyReport(db);
    expect(report.legacyPhotos).toBe(1);
    expect(report.legacyPrimaryPhotos).toBe(1);
    expect(report.legacyProfiles).toBe(1);
    expect(report.pendingPhotoQueue).toBe(1);
  });

  it('a profile a moderator approved is not legacy', async () => {
    const staffUser = await seedUser();
    const admin = await pg.query<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [staffUser],
    );
    const owner = await seedUser();
    await seedProfile(owner);
    await pg.query(
      `insert into public.admin_action_audit (admin_user_id, action, target_type, target_id)
       values ($1::uuid, 'profile.approve', 'profile', $2::uuid)`,
      [admin.rows[0]!.id, owner],
    );
    expect((await legacyReport(db)).legacyProfiles).toBe(0);
  });

  it('changes nothing', async () => {
    const owner = await seedUser();
    const photo = await seedPhoto(owner, { provider: 'auto_stub' });
    await legacyReport(db);
    expect((await photoRow(photo.id)).moderation_status).toBe('approved');
  });
});

describe('requeueLegacyContent', () => {
  it('a dry run changes nothing', async () => {
    const owner = await seedUser();
    const photo = await seedPhoto(owner, { provider: 'auto_stub', primary: true });
    await seedProfile(owner);
    expect(await requeueLegacyContent(db)).toEqual({ photos: 1, profiles: 1, applied: false });
    expect(await photoRow(photo.id)).toMatchObject({
      moderation_status: 'approved',
      is_primary: true,
    });
  });

  it('with apply, legacy content goes back to the queue, and a person’s decision does not', async () => {
    const owner = await seedUser();
    const legacy = await seedPhoto(owner, { provider: 'auto_stub', primary: true });
    const reviewed = await seedPhoto(owner, { provider: 'human' });
    await seedProfile(owner);

    expect(await requeueLegacyContent(db, { apply: true })).toEqual({
      photos: 1,
      profiles: 1,
      applied: true,
    });
    expect(await photoRow(legacy.id)).toMatchObject({
      moderation_status: 'pending',
      is_primary: false,
      primary_before_requeue: true,
    });
    expect((await photoRow(reviewed.id)).moderation_status).toBe('approved');

    const profile = await pg.query<{ review_status: string; profile_reviewed_at: string | null }>(
      `select p.review_status, v.profile_reviewed_at
         from public.profiles p join public.verification_status v on v.user_id = p.user_id
        where p.user_id = $1::uuid`,
      [owner],
    );
    expect(profile.rows[0]).toEqual({ review_status: 'pending', profile_reviewed_at: null });
    expect((await legacyReport(db)).pendingPhotoQueue).toBe(1);
  });

  it('paces by the limit, oldest first, and a second run takes the next', async () => {
    const owner = await seedUser();
    const first = await seedPhoto(owner, { provider: 'auto_stub' });
    const second = await seedPhoto(owner, { provider: 'auto_stub' });
    await pg.query(
      `update public.photos set created_at = now() - interval '2 days' where id = $1::uuid`,
      [first.id],
    );
    expect(await requeueLegacyContent(db, { apply: true, limit: 1 })).toMatchObject({ photos: 1 });
    expect((await photoRow(first.id)).moderation_status).toBe('pending');
    expect((await photoRow(second.id)).moderation_status).toBe('approved');
    await requeueLegacyContent(db, { apply: true, limit: 1 });
    expect((await photoRow(second.id)).moderation_status).toBe('pending');
  });

  it('a third run finds nothing: it is idempotent', async () => {
    const owner = await seedUser();
    await seedPhoto(owner, { provider: 'auto_stub' });
    await requeueLegacyContent(db, { apply: true });
    expect(await requeueLegacyContent(db, { apply: true })).toMatchObject({ photos: 0 });
  });

  it('if anything fails nothing is half done', async () => {
    const owner = await seedUser();
    const photo = await seedPhoto(owner, { provider: 'auto_stub' });
    const failing: Queryable = {
      query: async <T>(sql: string, params?: unknown[]) => {
        if (sql.includes('insert into public.media_moderation_results')) throw new Error('no');
        return pg.query<T>(sql, params as never[]);
      },
    };
    await expect(requeueLegacyContent(failing, { apply: true })).rejects.toThrow('no');
    expect((await photoRow(photo.id)).moderation_status).toBe('approved');
  });
});

describe('the rule and the moderation flow, through the real API', () => {
  let harness: TestHarness;

  const member = async (gender = 'female') => {
    const authId = randomAuthId();
    const users = await harness.raw.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
       values ('Member', $1, date '1995-06-15', 'pk', 'active', now()) returning id`,
      [gender],
    );
    const userId = users.rows[0]!.id;
    await harness.raw.query(
      `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
      [userId, authId],
    );
    await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [
      userId,
    ]);
    await harness.raw.query(
      `insert into public.verification_status (user_id, email_verified_at) values ($1::uuid, now())`,
      [userId],
    );
    await harness.raw.query(
      `insert into public.profiles
         (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
       values ($1::uuid, 'A sufficiently long about-me for this member.', 'ms_never_married', 'rel_practising', 'approved', now())`,
      [userId],
    );
    await harness.raw.query(
      `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
      [userId],
    );
    return { userId, authId };
  };

  const photo = async (
    ownerId: string,
    options: { needsStrip?: boolean; primary?: boolean } = {},
  ) => {
    const path = `${ownerId}/${randomAuthId()}/original.jpg`;
    const rows = await harness.raw.query<{ id: string }>(
      `insert into public.photos
         (user_id, storage_path, content_type, moderation_status, visibility, original_needs_strip, is_primary)
       values ($1::uuid, $2, 'image/jpeg', 'approved', 'public', $3, $4) returning id`,
      [ownerId, path, options.needsStrip ?? false, options.primary ?? false],
    );
    const blurred = path.replace('original.jpg', 'blurred.jpg');
    await harness.raw.query(
      `insert into public.photo_variants (photo_id, variant, storage_path) values ($1::uuid, 'blurred', $2)`,
      [rows.rows[0]!.id, blurred],
    );
    harness.storage.put(path, Buffer.from('original'), 'image/jpeg');
    harness.storage.put(blurred, Buffer.from('blurred'), 'image/jpeg');
    return { id: rows.rows[0]!.id, path, blurred };
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.raw.exec(`
      insert into public.reference_items (type, code) values
        ('marital_status', 'ms_never_married'), ('religious_practice', 'rel_practising'), ('country', 'pk')
      on conflict (type, code) do nothing
    `);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const gallery = (viewer: string, owner: string) =>
    harness.app.inject({
      method: 'GET',
      url: `/profiles/${owner}/photos`,
      headers: authHeader(viewer),
    });

  it('a marked original is never served to another member', async () => {
    const owner = await member();
    const viewer = await member('male');
    const marked = await photo(owner.userId, { needsStrip: true });
    const res = await gallery(viewer.authId, owner.userId);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('original.jpg');
    expect(res.body).toContain('blurred.jpg');
    const rule = await harness.raw.query<{ full: boolean }>(
      `select app.photo_variant_readable($1::uuid, $2::uuid, 'full') as full`,
      [viewer.userId, marked.id],
    );
    expect(rule.rows[0]!.full).toBe(false);
  });

  it('once cleaned the same original is served again', async () => {
    const owner = await member();
    const viewer = await member('male');
    const marked = await photo(owner.userId, { needsStrip: true });
    await harness.raw.query(
      `update public.photos set original_needs_strip = false where id = $1::uuid`,
      [marked.id],
    );
    expect((await gallery(viewer.authId, owner.userId)).body).toContain('original.jpg');
  });

  it('the owner can still see their own marked original', async () => {
    const owner = await member();
    const marked = await photo(owner.userId, { needsStrip: true });
    const rule = await harness.raw.query<{ full: boolean }>(
      `select app.photo_variant_readable($1::uuid, $2::uuid, 'full') as full`,
      [owner.userId, marked.id],
    );
    expect(rule.rows[0]!.full).toBe(true);
  });

  const staff = async () => {
    const person = await member();
    const admin = await harness.raw.query<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [person.userId],
    );
    await harness.raw.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, 'moderator')`,
      [admin.rows[0]!.id],
    );
    return person;
  };

  const decide = (moderator: string, id: string, decision: string) =>
    harness.app.inject({
      method: 'POST',
      url: `/admin/moderation/photos/${id}`,
      headers: authHeader(moderator, undefined, 'aal2'),
      payload: {
        decision,
        ...(decision === 'reject' ? { reasonKey: 'errors.photoRejected' } : {}),
      },
    });

  const hRow = async (id: string) =>
    (
      await harness.raw.query<{ is_primary: boolean; primary_before_requeue: boolean }>(
        `select is_primary, primary_before_requeue from public.photos where id = $1::uuid`,
        [id],
      )
    ).rows[0]!;

  const requeue = (id: string) =>
    harness.raw.query(
      `update public.photos
          set moderation_status = 'pending', primary_before_requeue = is_primary, is_primary = false
        where id = $1::uuid`,
      [id],
    );

  it('approved again, a re-queued main photo gets its place back', async () => {
    const owner = await member();
    const moderator = await staff();
    const main = await photo(owner.userId, { primary: true });
    await requeue(main.id);
    expect((await decide(moderator.authId, main.id, 'approve')).statusCode).toBe(200);
    expect(await hRow(main.id)).toEqual({ is_primary: true, primary_before_requeue: false });
  });

  it('unless the member chose another in the meantime', async () => {
    const owner = await member();
    const moderator = await staff();
    const main = await photo(owner.userId, { primary: true });
    await requeue(main.id);
    await photo(owner.userId, { primary: true });
    expect((await decide(moderator.authId, main.id, 'approve')).statusCode).toBe(200);
    expect(await hRow(main.id)).toEqual({ is_primary: false, primary_before_requeue: false });
  });

  it('rejected, it does not', async () => {
    const owner = await member();
    const moderator = await staff();
    const main = await photo(owner.userId, { primary: true });
    await requeue(main.id);
    expect((await decide(moderator.authId, main.id, 'reject')).statusCode).toBe(200);
    expect(await hRow(main.id)).toEqual({ is_primary: false, primary_before_requeue: false });
  });

  it('a photo finalized now is never marked', async () => {
    const owner = await member();
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/me/photos/upload-url',
      headers: authHeader(owner.authId),
      payload: { contentType: 'image/jpeg', byteSize: 1000 },
    });
    expect(upload.statusCode).toBe(201);
    const { photoId, path } = upload.json();
    await harness.raw.query(
      `update public.photos set original_needs_strip = true where id = $1::uuid`,
      [photoId],
    );
    harness.storage.put(path, await withGps(), 'image/jpeg');
    const done = await harness.app.inject({
      method: 'POST',
      url: `/me/photos/${photoId}/finalize`,
      headers: authHeader(owner.authId),
    });
    expect(done.statusCode).toBe(202);
    const row = await harness.raw.query<{ original_needs_strip: boolean }>(
      `select original_needs_strip from public.photos where id = $1::uuid`,
      [photoId],
    );
    expect(row.rows[0]!.original_needs_strip).toBe(false);
    expect((await readImageMetadata(harness.storage.objects.get(path)!.body)).exif).toBe(false);
  });
});
