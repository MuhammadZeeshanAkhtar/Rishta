import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * RLS and constraints for the Phase 4 media tables.
 *
 * Photo leakage is risk R5 — the highest-severity personal harm in this
 * product — so these lean hard on the negative cases: can someone else read my
 * photo row, can I approve my own photo, can I point the "blurred" variant at
 * the original, can I move a photo to another account.
 *
 * Cross-user reads
 * now go through `app.can_view_photo()`, added in Phase 5 Slice 1 — see
 * visibility-rls.test.ts. This file keeps pinning the owner half.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let photoId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });

  const rows = await db.admin<{ id: string }>(
    `insert into public.photos (user_id, storage_path, content_type, byte_size, width, height)
     values ($1::uuid, $1::text || '/p1/original.jpg', 'image/jpeg', 120000, 1200, 1600)
     returning id`,
    [alice.userId],
  );
  photoId = rows[0]!.id;

  await db.admin(
    `insert into public.photo_variants (photo_id, variant, storage_path)
     values ($1, 'thumb', $2), ($1, 'blurred', $3)`,
    [photoId, `${alice.userId}/p1/thumb.jpg`, `${alice.userId}/p1/blurred.jpg`],
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('photos', () => {
  it('defaults to private — A1', async () => {
    // Uploading a photo and doing nothing else must not publish it.
    const rows = await db.as<{ visibility: string; moderation_status: string }>(
      'authenticated',
      alice.authUserId,
      `select visibility, moderation_status from public.photos`,
    );
    expect(rows[0]?.visibility).toBe('private');
    expect(rows[0]?.moderation_status).toBe('pending');
  });

  it('lets the owner read their own photos', async () => {
    const rows = await db.as('authenticated', alice.authUserId, `select id from public.photos`);
    expect(rows).toHaveLength(1);
  });

  it('does NOT let another member read them', async () => {
    const rows = await db.as('authenticated', bilal.authUserId, `select id from public.photos`);
    expect(rows).toHaveLength(0);
  });

  it('does NOT let an anonymous caller read any photo', async () => {
    await expect(db.as('anon', null, `select id from public.photos`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('does NOT let a member approve their own photo', async () => {
    // moderation_status carries no column grant. A member who could write it
    // would make their photo visible without it ever being checked.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.photos set moderation_status = 'approved'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member rewrite the storage path', async () => {
    // The path points at the bytes. Rewriting it would let someone attach a
    // row they control to an object they do not own.
    await expect(
      db.as('authenticated', alice.authUserId, `update public.photos set storage_path = 'x/y.jpg'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member move a photo to another account', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `update public.photos set user_id = $1`, [
        bilal.userId,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member insert a photo for someone else', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.photos (user_id, storage_path, content_type)
         values ($1::uuid, $1::text || '/x/o.jpg', 'image/jpeg')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('refuses a storage path outside the owner folder', async () => {
    // The constraint mirrors the Storage policy. Agreeing on both sides means
    // a mismatched path cannot be written at all.
    await expect(
      db.admin(
        `insert into public.photos (user_id, storage_path, content_type)
         values ($1::uuid, 'somebody-else/x/o.jpg', 'image/jpeg')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/storage_path_owned/);
  });

  it('refuses a content type outside the allowed set', async () => {
    await expect(
      db.admin(
        `insert into public.photos (user_id, storage_path, content_type)
         values ($1::uuid, $1::text || '/x/o.svg', 'image/svg+xml')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/content_type_valid/);
  });

  it('refuses a file over the 10 MB ceiling', async () => {
    await expect(
      db.admin(
        `insert into public.photos (user_id, storage_path, content_type, byte_size)
         values ($1::uuid, $1::text || '/x/big.jpg', 'image/jpeg', 10485761)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/byte_size_sane/);
  });

  it('allows only one primary photo per person', async () => {
    await db.admin(`update public.photos set is_primary = true where id = $1`, [photoId]);
    const second = await db.admin<{ id: string }>(
      `insert into public.photos (user_id, storage_path, content_type)
       values ($1::uuid, $1::text || '/p2/original.jpg', 'image/jpeg') returning id`,
      [alice.userId],
    );
    await expect(
      db.admin(`update public.photos set is_primary = true where id = $1`, [second[0]!.id]),
    ).rejects.toThrow(/photos_one_primary_per_user/);
    // Leave the fixture as it was.
    await db.admin(`update public.photos set deleted_at = now() where id = $1`, [second[0]!.id]);
  });

  it('hides a soft-deleted photo from its owner', async () => {
    const extra = await db.admin<{ id: string }>(
      `insert into public.photos (user_id, storage_path, content_type, deleted_at)
       values ($1::uuid, $1::text || '/p3/original.jpg', 'image/jpeg', now()) returning id`,
      [alice.userId],
    );
    const rows = await db.as<{ id: string }>(
      'authenticated',
      alice.authUserId,
      `select id from public.photos where id = $1`,
      [extra[0]!.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('photo_variants', () => {
  it('lets the owner read variants of their own photo', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select variant from public.photo_variants`,
    );
    expect(rows).toHaveLength(2);
  });

  it('does NOT expose another member variants', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select variant from public.photo_variants`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member write a variant row', async () => {
    // The decisive one. A member who could write this could point the
    // `blurred` variant at the unblurred original and defeat the tier.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1, 'full', 'anything.jpg')`,
        [photoId],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member repoint an existing variant', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.photo_variants set storage_path = 'original.jpg'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses an unknown variant name', async () => {
    await expect(
      db.admin(
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1, 'original', 'x.jpg')`,
        [photoId],
      ),
    ).rejects.toThrow(/variant_valid/);
  });

  it('refuses two rows for the same variant of one photo', async () => {
    await expect(
      db.admin(
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1, 'thumb', 'dup.jpg')`,
        [photoId],
      ),
    ).rejects.toThrow(/photo_variant_key/);
  });
});

describe('media_moderation_results — restricted', () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.media_moderation_results (photo_id, provider, verdict)
       values ($1, 'stub', 'approved')`,
      [photoId],
    );
  });

  it('is unreachable by the member whose photo it describes', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `select verdict from public.media_moderation_results`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is unreachable by an anonymous caller', async () => {
    await expect(
      db.as('anon', null, `select verdict from public.media_moderation_results`),
    ).rejects.toThrow(/permission denied/);
  });

  it('is reachable by the service role', async () => {
    const rows = await db.as(
      'service_role',
      null,
      `select verdict from public.media_moderation_results`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
