import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  createHarness,
  grantStorageStandIn,
  randomAuthId,
  seedStorageStandIn,
  type TestHarness,
} from './helpers';

/**
 * Stage 2, Priority 6: least-privilege staff access to member photos.
 *
 *   the route   logs one row per queued photo, and offers only queued photos
 *   the policy  (real migrations, a stand-in for Supabase's storage tables) lets a
 *               moderator read only what the log has an open row for
 */

describe('GET /admin/moderation/photos', () => {
  let harness: TestHarness;
  let moderator: { userId: string; authId: string; adminId: string };

  const seedMember = async () => {
    const authId = randomAuthId();
    const users = await harness.raw.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
       values ('Member', 'female', date '1995-06-15', 'pk', 'active', now()) returning id`,
    );
    const userId = users.rows[0]!.id;
    await harness.raw.query(
      `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
      [userId, authId],
    );
    return { userId, authId };
  };

  const seedStaff = async (role: string) => {
    const member = await seedMember();
    const admin = await harness.raw.query<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [member.userId],
    );
    await harness.raw.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, $2)`,
      [admin.rows[0]!.id, role],
    );
    return { ...member, adminId: admin.rows[0]!.id };
  };

  const seedPhoto = async (
    userId: string,
    options: { status?: string; variants?: boolean; needsStrip?: boolean } = {},
  ) => {
    const folder = randomAuthId();
    const photo = await harness.raw.query<{ id: string }>(
      `insert into public.photos (user_id, storage_path, content_type, moderation_status, original_needs_strip)
       values ($1::uuid, $2, 'image/jpeg', $3, $4) returning id`,
      [
        userId,
        `${userId}/${folder}/original.jpg`,
        options.status ?? 'pending',
        options.needsStrip ?? false,
      ],
    );
    if (options.variants ?? true) {
      await harness.raw.query(
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1::uuid, 'thumb', $2)`,
        [photo.rows[0]!.id, `${userId}/${folder}/thumb.jpg`],
      );
    }
    return { id: photo.rows[0]!.id, folder };
  };

  const queue = (authId: string, aal: 'aal2' | undefined = 'aal2') =>
    harness.app.inject({
      method: 'GET',
      url: '/admin/moderation/photos?limit=50',
      headers: authHeader(authId, undefined, aal),
    });

  const logFor = async (photoId: string) =>
    (
      await harness.raw.query<{
        admin_user_id: string;
        subject_user_id: string;
        fields: string[];
        justification: string;
      }>(
        `select admin_user_id, subject_user_id, fields, justification
           from public.pii_access_log where photo_id = $1::uuid`,
        [photoId],
      )
    ).rows;

  beforeAll(async () => {
    harness = await createHarness();
    moderator = await seedStaff('moderator');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('records who viewed which member’s photo, and why, before returning it', async () => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId);
    const res = await queue(moderator.authId);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { photoId: string }) => i.photoId)).toContain(photo.id);
    expect(await logFor(photo.id)).toEqual([
      {
        admin_user_id: moderator.adminId,
        subject_user_id: owner.userId,
        fields: ['photo'],
        justification: 'moderation_queue',
      },
    ]);
  });

  it('each view is its own record', async () => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId);
    await queue(moderator.authId);
    await queue(moderator.authId);
    expect(await logFor(photo.id)).toHaveLength(2);
  });

  it.each([
    ['approved', { status: 'approved' }],
    ['rejected', { status: 'rejected' }],
    ['not finalized', { variants: false }],
  ])('a photo that is %s is neither offered nor logged', async (_label, options) => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId, options);
    const res = await queue(moderator.authId);
    expect(res.json().items.map((i: { photoId: string }) => i.photoId)).not.toContain(photo.id);
    expect(await logFor(photo.id)).toEqual([]);
  });

  it('an original not yet cleaned of EXIF is not shown even to staff: the thumbnail is', async () => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId, { needsStrip: true });
    harness.storage.put(`${owner.userId}/${photo.folder}/thumb.jpg`, Buffer.from('thumb'));
    harness.storage.put(`${owner.userId}/${photo.folder}/original.jpg`, Buffer.from('original'));
    const res = await queue(moderator.authId);
    const item = res.json().items.find((i: { photoId: string }) => i.photoId === photo.id);
    expect(item.url).toContain('thumb.jpg');
    expect(item.url).not.toContain('original');
  });

  it.each([
    ['without a second factor', undefined],
    ['a member who is not staff', 'member'],
    ['support, whose work does not need photos', 'support'],
  ])('%s gets nothing, and leaves no log row', async (_label, who) => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId);
    let res;
    if (who === undefined) {
      res = await harness.app.inject({
        method: 'GET',
        url: '/admin/moderation/photos',
        headers: authHeader(moderator.authId),
      });
    } else if (who === 'member') {
      res = await queue((await seedMember()).authId);
    } else {
      res = await queue((await seedStaff('support')).authId);
    }
    expect(res.statusCode).toBeGreaterThanOrEqual(403);
    expect(await logFor(photo.id)).toEqual([]);
  });

  it('a decision still works, and queue photos are not lost by viewing them', async () => {
    const owner = await seedMember();
    const photo = await seedPhoto(owner.userId);
    await queue(moderator.authId);
    const decided = await harness.app.inject({
      method: 'POST',
      url: `/admin/moderation/photos/${photo.id}`,
      headers: authHeader(moderator.authId, undefined, 'aal2'),
      payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(200);
    const again = await queue(moderator.authId);
    expect(again.json().items.map((i: { photoId: string }) => i.photoId)).not.toContain(photo.id);
  });

  describe('the log itself', () => {
    it.each(['api_member', 'authenticated', 'anon'])('%s cannot read or write it', async (role) => {
      for (const sql of [
        `select * from public.pii_access_log`,
        `insert into public.pii_access_log (admin_user_id, subject_user_id, fields, justification)
         values (gen_random_uuid(), gen_random_uuid(), array['x'], 'x')`,
        `delete from public.pii_access_log`,
      ]) {
        await harness.raw.exec('begin');
        try {
          await harness.raw.exec(`set local role ${role}`);
          await expect(harness.raw.query(sql)).rejects.toThrow(/permission denied/);
        } finally {
          await harness.raw.exec('rollback');
        }
      }
    });

    it('cannot be edited, even by the server', async () => {
      await expect(
        harness.db.asService('admin.record_access', (session) =>
          session.query(`update public.pii_access_log set justification = 'nothing to see'`),
        ),
      ).rejects.toThrow();
    });

    it('needs a reason and a field', async () => {
      const owner = await seedMember();
      await expect(
        harness.raw.query(
          `insert into public.pii_access_log (admin_user_id, subject_user_id, fields, justification)
           values ($1::uuid, $2::uuid, array['photo'], '   ')`,
          [moderator.adminId, owner.userId],
        ),
      ).rejects.toThrow(/justification_present/);
      await expect(
        harness.raw.query(
          `insert into public.pii_access_log (admin_user_id, subject_user_id, fields, justification)
           values ($1::uuid, $2::uuid, array[]::text[], 'x')`,
          [moderator.adminId, owner.userId],
        ),
      ).rejects.toThrow(/fields_present/);
    });

    it('rows older than 24 months go, and no others', async () => {
      const owner = await seedMember();
      await harness.raw.query(
        `insert into public.pii_access_log (admin_user_id, subject_user_id, fields, justification, accessed_at)
         values ($1::uuid, $2::uuid, array['photo'], 'old', now() - interval '25 months'),
                ($1::uuid, $2::uuid, array['photo'], 'recent', now() - interval '23 months')`,
        [moderator.adminId, owner.userId],
      );
      await harness.raw.query(`select app.purge_expired_pii_access_log()`);
      const left = await harness.raw.query<{ justification: string }>(
        `select justification from public.pii_access_log where subject_user_id = $1::uuid`,
        [owner.userId],
      );
      expect(left.rows.map((r) => r.justification)).toEqual(['recent']);
    });
  });
});

describe('the Storage policy', () => {
  let pg: PGlite;
  let moderatorAuth: string;
  let adminId: string;
  let ownerId: string;
  let path: string;
  let photoId: string;

  const read = async (auth: string, object: string, aal = 'aal2') => {
    await pg.exec('begin');
    try {
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: auth, role: 'authenticated', aal }),
      ]);
      await pg.exec('set local role authenticated');
      return (
        await pg.query(`select name from storage.objects where name = $1`, [object] as never[])
      ).rows.length;
    } finally {
      await pg.exec('rollback');
    }
  };

  const seedUser = async () => {
    const auth = randomAuthId();
    const users = await pg.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status)
       values ('Someone', 'female', date '1995-06-15', 'pk', 'active') returning id`,
    );
    await pg.query(
      `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
      [users.rows[0]!.id, auth],
    );
    return { id: users.rows[0]!.id, auth };
  };

  const log = (photo: string, subject: string, ago = '1 minute') =>
    pg.query(
      `insert into public.pii_access_log (admin_user_id, subject_user_id, photo_id, fields, justification, accessed_at)
       values ($1::uuid, $2::uuid, $3::uuid, array['photo'], 'moderation_queue', now() - $4::interval)`,
      [adminId, subject, photo, ago],
    );

  const seedPhoto = async (owner: string, name: string) => {
    const rows = await pg.query<{ id: string }>(
      `insert into public.photos (user_id, storage_path, content_type, visibility)
       values ($1::uuid, $2, 'image/jpeg', 'private') returning id`,
      [owner, name],
    );
    await pg.query(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [name]);
    return rows.rows[0]!.id;
  };

  beforeAll(async () => {
    pg = new PGlite();
    await seedStorageStandIn(pg);
    await applyMigrations(pg);
    await grantStorageStandIn(pg);

    const moderator = await seedUser();
    moderatorAuth = moderator.auth;
    const admin = await pg.query<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [moderator.id],
    );
    adminId = admin.rows[0]!.id;
    await pg.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, 'moderator')`,
      [adminId],
    );
    ownerId = (await seedUser()).id;
    path = `${ownerId}/f/original.jpg`;
    photoId = await seedPhoto(ownerId, path);
  }, 180_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('with no log row a moderator reads nothing: not the whole bucket, as before', async () => {
    expect(await read(moderatorAuth, path)).toBe(0);
  });

  it('a stale row opens nothing: longer ago than a signed URL lasts', async () => {
    await log(photoId, ownerId, '6 minutes');
    expect(await read(moderatorAuth, path)).toBe(0);
  });

  it('a fresh row opens that photo', async () => {
    await log(photoId, ownerId);
    expect(await read(moderatorAuth, path)).toBe(1);
  });

  it('and only that photo', async () => {
    const other = `${ownerId}/g/original.jpg`;
    await seedPhoto(ownerId, other);
    expect(await read(moderatorAuth, other)).toBe(0);
  });

  it('still needs a second factor', async () => {
    expect(await read(moderatorAuth, path, 'aal1')).toBe(0);
  });

  it('another moderator’s log row opens nothing for this one', async () => {
    const someone = await seedUser();
    const otherAdmin = await pg.query<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [someone.id],
    );
    await pg.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, 'moderator')`,
      [otherAdmin.rows[0]!.id],
    );
    expect(await read(someone.auth, path)).toBe(0);
  });

  it('a log row is no use to someone who has lost the role', async () => {
    await pg.exec('begin');
    try {
      await pg.query(`update public.admin_users set status = 'disabled' where id = $1::uuid`, [
        adminId,
      ]);
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: moderatorAuth, role: 'authenticated', aal: 'aal2' }),
      ]);
      await pg.exec('set local role authenticated');
      const rows = await pg.query(`select name from storage.objects where name = $1`, [path]);
      expect(rows.rows).toEqual([]);
    } finally {
      await pg.exec('rollback');
    }
  });

  it('a member cannot use it at all', async () => {
    const member = await seedUser();
    expect(await read(member.auth, path)).toBe(0);
  });
});
