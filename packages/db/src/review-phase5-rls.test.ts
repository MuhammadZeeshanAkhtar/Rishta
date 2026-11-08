import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Code review remediation, Phase 5 — the database half (migration 0031, L3).
 *
 *   photo_requests, photo_grants   each party reads its own; nobody writes
 *                                  through the Data API
 *   app.photo_variant_readable     the per-visibility, per-object rule
 *   app.can_read_photo_object      the same rule by exact Storage path
 */

let db: TestDb;
let owner: SeededUser;
let viewer: SeededUser;
let other: SeededUser;

const asMember = <T = Record<string, unknown>>(
  user: SeededUser,
  sql: string,
  params: unknown[] = [],
) => db.as<T>('api_member', user.authUserId, sql, params);

async function photo(
  visibility: string,
  status = 'approved',
): Promise<{ id: string; full: string; blurred: string; thumb: string }> {
  const folder = crypto.randomUUID();
  const full = `${owner.userId}/${folder}/original.jpg`;
  const rows = await db.admin<{ id: string }>(
    `insert into public.photos (user_id, storage_path, content_type, visibility, moderation_status)
     values ($1::uuid, $2, 'image/jpeg', $3, $4) returning id`,
    [owner.userId, full, visibility, status],
  );
  const id = rows[0]!.id;
  await db.admin(
    `insert into public.photo_variants (photo_id, variant, storage_path)
     values ($1::uuid, 'thumb', $2), ($1::uuid, 'blurred', $3)`,
    [id, `${owner.userId}/${folder}/thumb.jpg`, `${owner.userId}/${folder}/blurred.jpg`],
  );
  return {
    id,
    full,
    thumb: `${owner.userId}/${folder}/thumb.jpg`,
    blurred: `${owner.userId}/${folder}/blurred.jpg`,
  };
}

async function readable(user: SeededUser, photoId: string, kind: string): Promise<boolean> {
  const rows = await asMember<{ ok: boolean }>(
    user,
    `select app.photo_variant_readable(app.current_user_id(), $1::uuid, $2) as ok`,
    [photoId, kind],
  );
  return rows[0]!.ok;
}

async function objectReadable(user: SeededUser, path: string): Promise<boolean> {
  const rows = await asMember<{ ok: boolean }>(user, `select app.can_read_photo_object($1) as ok`, [
    path,
  ]);
  return rows[0]!.ok;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  owner = await seedUser(db, { displayName: 'Photo Owner', gender: 'female' });
  viewer = await seedUser(db, { displayName: 'Photo Viewer', gender: 'male' });
  other = await seedUser(db, { displayName: 'Other Viewer', gender: 'male' });
  for (const u of [owner, viewer, other]) {
    await db.admin(
      `insert into public.profiles
         (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
       values ($1::uuid, 'A sufficiently long about-me for this member.', 'ms_never_married',
               'rel_practising', 'approved', now())`,
      [u.userId],
    );
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('the rule: which object of which photo a viewer may read', () => {
  it.each([
    ['public', 'thumb', true],
    ['public', 'blurred', true],
    ['public', 'full', true],
    ['blurred', 'blurred', true],
    ['blurred', 'thumb', false],
    ['blurred', 'full', false],
    ['on_request', 'blurred', false],
    ['on_request', 'thumb', false],
    ['on_request', 'full', false],
    ['private', 'blurred', false],
    ['private', 'full', false],
  ])('%s photo, %s object, no grant → %s', async (visibility, kind, expected) => {
    const p = await photo(visibility);
    expect(await readable(viewer, p.id, kind)).toBe(expected);
  });

  it('never an unapproved or deleted photo, never an unknown kind', async () => {
    const pending = await photo('public', 'pending');
    const rejected = await photo('public', 'rejected');
    const deleted = await photo('public');
    await db.admin(`update public.photos set deleted_at = now() where id = $1::uuid`, [deleted.id]);
    const pub = await photo('public');
    expect(await readable(viewer, pending.id, 'full')).toBe(false);
    expect(await readable(viewer, rejected.id, 'full')).toBe(false);
    expect(await readable(viewer, deleted.id, 'full')).toBe(false);
    expect(await readable(viewer, pub.id, 'original')).toBe(false);
  });

  it('a grant reveals blurred and on-request photos in full, to the grantee only, never a private one', async () => {
    const blurred = await photo('blurred');
    const onRequest = await photo('on_request');
    const priv = await photo('private');
    await db.admin(
      `insert into public.photo_grants (owner_user_id, grantee_user_id) values ($1::uuid, $2::uuid)`,
      [owner.userId, viewer.userId],
    );
    expect(await readable(viewer, blurred.id, 'full')).toBe(true);
    expect(await readable(viewer, onRequest.id, 'thumb')).toBe(true);
    expect(await readable(viewer, priv.id, 'full')).toBe(false);
    expect(await readable(other, onRequest.id, 'full')).toBe(false);

    // Revoked: gone.
    await db.admin(
      `update public.photo_grants set revoked_at = now()
        where owner_user_id = $1::uuid and grantee_user_id = $2::uuid`,
      [owner.userId, viewer.userId],
    );
    expect(await readable(viewer, onRequest.id, 'full')).toBe(false);
  });

  it('a block ends every read, public included', async () => {
    const pub = await photo('public');
    expect(await readable(other, pub.id, 'full')).toBe(true);
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [owner.userId, other.userId],
    );
    expect(await readable(other, pub.id, 'full')).toBe(false);
  });

  it('by Storage path: exact stored paths only', async () => {
    const pub = await photo('public');
    const blurred = await photo('blurred');
    expect(await objectReadable(viewer, pub.full)).toBe(true);
    expect(await objectReadable(viewer, blurred.blurred)).toBe(true);
    expect(await objectReadable(viewer, blurred.full)).toBe(false);
    expect(await objectReadable(viewer, blurred.thumb)).toBe(false);
    expect(await objectReadable(viewer, `${pub.full}/../x`)).toBe(false);
    expect(await objectReadable(viewer, 'nothing/here.jpg')).toBe(false);
    // Anonymous callers cannot ask at all.
    await expect(
      db.as('anon', null, `select app.photo_variant_readable(null, $1::uuid, 'full') as ok`, [
        pub.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as('anon', null, `select app.can_read_photo_object($1) as ok`, [pub.full]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('photo_requests and photo_grants: read by the parties, written by the server', () => {
  it('a member can neither insert a request nor issue themselves a grant', async () => {
    await expect(
      asMember(
        viewer,
        `insert into public.photo_requests (requester_user_id, owner_user_id) values (app.current_user_id(), $1::uuid)`,
        [owner.userId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asMember(
        viewer,
        `insert into public.photo_grants (owner_user_id, grantee_user_id) values ($1::uuid, app.current_user_id())`,
        [owner.userId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asMember(owner, `update public.photo_requests set status = 'approved'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('each party reads its own rows, a third party nothing', async () => {
    await db.admin(
      `insert into public.photo_requests (requester_user_id, owner_user_id, message) values ($1::uuid, $2::uuid, 'hello')`,
      [viewer.userId, owner.userId],
    );
    expect(await asMember(viewer, `select id from public.photo_requests`)).toHaveLength(1);
    expect(await asMember(owner, `select id from public.photo_requests`)).toHaveLength(1);
    expect(await asMember(other, `select id from public.photo_requests`)).toHaveLength(0);
    await expect(db.as('anon', null, `select 1 from public.photo_requests`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it.each([
    [
      'one open request per pair',
      `insert into public.photo_requests (requester_user_id, owner_user_id) values ($1::uuid, $2::uuid), ($1::uuid, $2::uuid)`,
      /photo_requests_one_pending/,
    ],
    [
      'a request to oneself',
      `insert into public.photo_requests (requester_user_id, owner_user_id) select $1::uuid, $1::uuid where $2::uuid is not null`,
      /photo_requests_not_self/,
    ],
    [
      'an answered request without a time',
      `insert into public.photo_requests (requester_user_id, owner_user_id, status) values ($1::uuid, $2::uuid, 'approved')`,
      /responded_consistent/,
    ],
    [
      'a 301-character message',
      `insert into public.photo_requests (requester_user_id, owner_user_id, message) values ($1::uuid, $2::uuid, repeat('x', 301))`,
      /message_len/,
    ],
    [
      'two live grants for the same pair',
      `insert into public.photo_grants (owner_user_id, grantee_user_id) values ($2::uuid, $1::uuid), ($2::uuid, $1::uuid)`,
      /photo_grants_one_live_all/,
    ],
  ])('refuses %s', async (_label, sql, pattern) => {
    await expect(db.admin(sql, [other.userId, owner.userId])).rejects.toThrow(pattern);
  });
});
