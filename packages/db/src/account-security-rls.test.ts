import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Migration 0032, at the database. These run as `authenticated` with a member's
 * JWT claims, which is exactly what the Supabase Data API does, so they hold
 * whether or not `public` is exposed.
 *
 *   N2/B7  no member can read another member's private fields or photo rows
 *   N1     a restricted account can neither write nor read member data directly
 *   N1     timed suspensions end only as a moderator's date says
 */

let db: TestDb;
let owner: SeededUser;
let viewer: SeededUser;
let photoId: string;

const SECRET = {
  about: 'SECRET_ABOUT long enough to satisfy the profile constraint here.',
  family: 'SECRET_FAMILY_BACKGROUND',
  institution: 'SECRET_INSTITUTION',
  city: 'SECRET_CITY',
  photo: 'SECRET_PHOTO_FOLDER',
};

async function seedProfile(
  user: SeededUser,
  about: string,
  family: string | null,
  school: string | null,
) {
  await db.admin(
    `insert into public.profiles
       (user_id, about_me, family_background, institution, marital_status_code,
        religious_practice_code, has_children, children_count, review_status, submitted_at)
     values ($1::uuid, $2, $3, $4, 'ms_never_married', 'rel_practising', true, 2, 'approved', now())`,
    [user.userId, about, family, school],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  await db.admin(`
    insert into public.reference_items (type, code)
    values ('marital_status', 'ms_never_married'), ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing
  `);
  owner = await seedUser(db, { displayName: 'Owner', gender: 'female' });
  viewer = await seedUser(db, { displayName: 'Viewer', gender: 'male' });
  await seedProfile(owner, SECRET.about, SECRET.family, SECRET.institution);
  await seedProfile(viewer, 'A sufficiently long about-me for the viewer here.', null, null);
  await db.admin(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', $2)`,
    [owner.userId, SECRET.city],
  );
  // Both forms of "the owner said no": a private field and an approved photo.
  await db.admin(
    `insert into public.profile_field_visibility (user_id, field_key, visibility)
     values ($1::uuid, 'family_background', 'private'), ($1::uuid, 'institution', 'private')`,
    [owner.userId],
  );
  const photo = await db.admin<{ id: string }>(
    `insert into public.photos (user_id, storage_path, content_type, visibility, moderation_status)
     values ($1::uuid, $2, 'image/jpeg', 'public', 'approved') returning id`,
    [owner.userId, `${owner.userId}/${SECRET.photo}/original.jpg`],
  );
  photoId = photo[0]!.id;
  await db.admin(
    `insert into public.photo_variants (photo_id, variant, storage_path)
     values ($1::uuid, 'thumb', $2)`,
    [photoId, `${owner.userId}/${SECRET.photo}/thumb.jpg`],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const asMember = <T = Record<string, unknown>>(
  user: SeededUser,
  sql: string,
  params: unknown[] = [],
) => db.as<T>('api_member', user.authUserId, sql, params);

describe('N2/B7: another member is not readable directly', () => {
  it.each([
    ['profiles', 'user_id'],
    ['photos', 'user_id'],
  ])('%s returns no row of another member', async (table, key) => {
    const rows = await asMember(viewer, `select * from public.${table} where ${key} = $1::uuid`, [
      owner.userId,
    ]);
    expect(rows).toEqual([]);
  });

  it('photo_variants returns no row of another member', async () => {
    const rows = await asMember(
      viewer,
      `select * from public.photo_variants where photo_id = $1::uuid`,
      [photoId],
    );
    expect(rows).toEqual([]);
  });

  it('no table a member can read reveals any of it, whatever the table', async () => {
    const tables = await db.admin<{ t: string }>(
      `select distinct table_name as t from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'api_member' and privilege_type = 'SELECT'`,
    );
    expect(tables.length).toBeGreaterThan(30);
    for (const { t } of tables) {
      const dump = JSON.stringify(await asMember(viewer, `select * from public.${t}`));
      for (const secret of Object.values(SECRET)) {
        expect(dump.includes(secret), `${t} exposed ${secret}`).toBe(false);
      }
    }
  });

  it('every column read returns nothing, including the ones a filter would hide', async () => {
    const rows = await asMember(
      viewer,
      `select family_background, institution, has_children, children_count, about_me
         from public.profiles where family_background is not null`,
    );
    expect(rows).toEqual([]);
  });

  it('anon has no read at all', async () => {
    await expect(db.as('anon', null, `select about_me from public.profiles`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.as('anon', null, `select id from public.photos`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the owner still reads and edits their own', async () => {
    const mine = await asMember<{ family_background: string }>(
      owner,
      `select family_background from public.profiles`,
    );
    expect(mine).toEqual([{ family_background: SECRET.family }]);
    expect(await asMember(owner, `select id from public.photos`)).toHaveLength(1);
    expect(await asMember(owner, `select id from public.photo_variants`)).toHaveLength(1);
    const edited = await asMember(
      owner,
      `update public.profiles set looking_for = 'Someone kind' returning user_id`,
    );
    expect(edited).toHaveLength(1);
  });

  it('a member can still add a photo: RETURNING survives the owner-only policy', async () => {
    const rows = await asMember(
      viewer,
      `insert into public.photos (user_id, storage_path, content_type)
       values (app.current_user_id(), app.current_user_id()::text || '/n/original.jpg', 'image/jpeg')
       returning id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('the rules the API relies on still answer, so nothing legitimate is lost', async () => {
    const rows = await asMember<{ profile: boolean; photo: boolean; object: boolean }>(
      viewer,
      `select app.can_view_profile(app.current_user_id(), $1::uuid) as profile,
              app.photo_variant_readable(app.current_user_id(), $2::uuid, 'full') as photo,
              app.can_read_photo_object($3) as object`,
      [owner.userId, photoId, `${owner.userId}/${SECRET.photo}/original.jpg`],
    );
    expect(rows[0]).toEqual({ profile: true, photo: true, object: true });
  });
});

describe('N1: a restricted account cannot use the database directly', () => {
  const STATUSES = ['suspended', 'banned', 'deactivated', 'pending_deletion'] as const;

  describe.each(STATUSES)('%s', (status) => {
    let member: SeededUser;
    let partner: SeededUser;
    let conversationId: string;

    beforeAll(async () => {
      member = await seedUser(db, { displayName: 'Restricted', gender: 'male' });
      partner = await seedUser(db, { displayName: 'Partner', gender: 'female' });
      await seedProfile(member, 'A sufficiently long about-me for this member.', null, null);
      await seedProfile(partner, 'A sufficiently long about-me for the partner.', null, null);
      const [a, b] = [member.userId, partner.userId].sort();
      const interest = await db.admin<{ id: string }>(
        `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
         values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
        [member.userId, partner.userId],
      );
      const match = await db.admin<{ id: string }>(
        `insert into public.matches (user_a_id, user_b_id, interest_id)
         values ($1::uuid, $2::uuid, $3::uuid) returning id`,
        [a, b, interest[0]!.id],
      );
      const existing = await db.admin<{ id: string }>(
        `select id from public.conversations where match_id = $1::uuid`,
        [match[0]!.id],
      );
      if (existing[0]) {
        conversationId = existing[0].id;
      } else {
        const conversation = await db.admin<{ id: string }>(
          `insert into public.conversations (match_id) values ($1::uuid) returning id`,
          [match[0]!.id],
        );
        conversationId = conversation[0]!.id;
        await db.admin(
          `insert into public.conversation_participants (conversation_id, user_id)
           values ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`,
          [conversationId, a, b],
        );
      }
      await db.admin(`update public.users set status = $2 where id = $1::uuid`, [
        member.userId,
        status,
      ]);
    });

    const WRITES: Array<
      [string, (m: SeededUser, p: SeededUser, c: string) => [string, unknown[]]]
    > = [
      [
        'send a message',
        (m, _p, c) => [
          `insert into public.messages (conversation_id, sender_user_id, body)
           values ($1::uuid, $2::uuid, 'hello')`,
          [c, m.userId],
        ],
      ],
      [
        'edit their profile',
        () => [
          `update public.profiles set about_me = 'A different long enough about-me text here.'`,
          [],
        ],
      ],
      [
        'edit their location',
        (m) => [
          `insert into public.user_locations (user_id, country_code) values ($1::uuid, 'pk')`,
          [m.userId],
        ],
      ],
      ['change a setting', () => [`update public.user_settings set discovery_paused = true`, []]],
      ['rename themselves', () => [`update public.users set display_name = 'New name'`, []]],
      [
        'upload a photo row',
        (m) => [
          `insert into public.photos (user_id, storage_path, content_type)
           values ($1::uuid, $2, 'image/jpeg')`,
          [m.userId, `${m.userId}/z/original.jpg`],
        ],
      ],
      [
        'block someone',
        (m, p) => [
          `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
          [m.userId, p.userId],
        ],
      ],
      [
        'shortlist someone',
        (m, p) => [
          `insert into public.shortlists (user_id, target_user_id) values ($1::uuid, $2::uuid)`,
          [m.userId, p.userId],
        ],
      ],
    ];

    it.each(WRITES)('cannot %s', async (_label, statement) => {
      const [sql, params] = statement(member, partner, conversationId);
      const attempt = asMember(member, `${sql} returning 1 as wrote`, params).then(
        (rows) => rows.length,
        (error: Error) => error.message,
      );
      const outcome = await attempt;
      // A refusal is either an RLS error or an update that matched no row. What
      // it can never be is a row written.
      if (typeof outcome === 'number') expect(outcome).toBe(0);
      else expect(outcome).toMatch(/row-level security|permission denied/);
    });

    it.each([
      'conversations',
      'conversation_participants',
      'messages',
      'matches',
      'interests',
      'notifications',
      'profiles',
      'photos',
      'match_candidates',
      'shortlists',
    ])('cannot read %s', async (table) => {
      expect(await asMember(member, `select * from public.${table}`)).toEqual([]);
    });

    it('can still read what GET /me needs, and only their own', async () => {
      const users = await asMember<{ status: string }>(member, `select status from public.users`);
      expect(users).toEqual([{ status }]);
      expect(await asMember(member, `select user_id from public.user_settings`)).toHaveLength(1);
      expect(await asMember(member, `select user_id from public.verification_status`)).toHaveLength(
        1,
      );
    });

    it('cannot change their own status', async () => {
      await expect(asMember(member, `update public.users set status = 'active'`)).rejects.toThrow(
        /permission denied/,
      );
    });

    it('the service role is unaffected: moderation and account routes still work', async () => {
      const rows = await db.admin<{ n: number }>(
        `select count(*)::int as n from public.conversation_participants where user_id = $1::uuid`,
        [member.userId],
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  it('an onboarding member is not restricted: they can build a profile', async () => {
    const fresh = await seedUser(db, {
      displayName: 'New',
      gender: 'female',
      status: 'onboarding',
    });
    const rows = await asMember(
      fresh,
      `insert into public.profiles (user_id, about_me) values (app.current_user_id(), 'draft') returning user_id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('an unknown status fails closed', async () => {
    const fn = await db.admin<{ src: string }>(
      `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'current_account_can_act'`,
    );
    expect(fn[0]!.src).toMatch(/status in \('onboarding', 'active'\)/);
  });

  it('every table a member can reach has a decision: a restrictive policy, or the named exemption', async () => {
    const exempt = [
      'users',
      'user_settings',
      'verification_status',
      'family_relationships',
      'family_permissions',
      'reference_items',
      'reference_translations',
    ];
    const reachable = await db.admin<{ t: string }>(
      `select distinct table_name as t from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'api_member'`,
    );
    const guarded = await db.admin<{ t: string }>(
      `select tablename as t from pg_policies
        where schemaname = 'public' and permissive = 'RESTRICTIVE'
          and qual like '%current_account_can_act%' and cmd = 'ALL'`,
    );
    const names = new Set(guarded.map((g) => g.t));
    expect(reachable.map((r) => r.t).filter((t) => !names.has(t) && !exempt.includes(t))).toEqual(
      [],
    );
  });
});

describe('N1: app.lift_expired_suspensions', () => {
  let admin: string;

  beforeAll(async () => {
    const staff = await seedUser(db, { displayName: 'Staff' });
    const rows = await db.admin<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [staff.userId],
    );
    admin = rows[0]!.id;
  });

  const suspended = async (previous: string | null = 'active') => {
    const member = await seedUser(db, { displayName: 'Member', status: 'suspended' });
    return { member, previous };
  };

  const record = (
    userId: string,
    action: string,
    expiresAt: string | null,
    previous: string | null = 'active',
    ago = '1 hour',
  ) =>
    db.admin(
      `insert into public.moderation_actions
         (subject_user_id, actor_admin_id, action, reason, expires_at, previous_status, created_at)
       values ($1::uuid, $2::uuid, $3, 'because', $4::timestamptz, $5, now() - $6::interval)`,
      [userId, admin, action, expiresAt, previous, ago],
    );

  const statusOf = async (userId: string) =>
    (
      await db.admin<{ status: string }>(`select status from public.users where id = $1::uuid`, [
        userId,
      ])
    )[0]!.status;

  const lift = (userId: string) =>
    db.admin(`select app.lift_expired_suspensions($1::uuid)`, [userId]);

  it('ends a suspension whose date has passed, and records that it did', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', '2020-01-01T00:00:00Z');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('active');
    const log = await db.admin<{ actor_admin_id: string | null; reason: string }>(
      `select actor_admin_id, reason from public.moderation_actions
        where subject_user_id = $1::uuid and action = 'clear'`,
      [member.userId],
    );
    expect(log).toEqual([{ actor_admin_id: null, reason: 'suspension_expired' }]);
  });

  it('is idempotent', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', '2020-01-01T00:00:00Z');
    await lift(member.userId);
    await lift(member.userId);
    const log = await db.admin(
      `select 1 from public.moderation_actions where subject_user_id = $1::uuid and action = 'clear'`,
      [member.userId],
    );
    expect(log).toHaveLength(1);
  });

  it('never ends a suspension with no date', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', null);
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('never ends one whose date is still ahead', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', '2999-01-01T00:00:00Z');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('never ends an account with no moderation record at all', async () => {
    const { member } = await suspended();
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('a later ban wins over an expired suspension', async () => {
    const member = await seedUser(db, { displayName: 'Member', status: 'banned' });
    await record(member.userId, 'suspend', '2020-01-01T00:00:00Z', 'active', '2 hours');
    await record(member.userId, 'ban', null, 'active', '1 hour');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('banned');
  });

  it('only a suspension’s date counts: an expired date on a later ban or warning does not', async () => {
    // The old API accepted an end date on any action, so such rows can exist.
    const { member } = await suspended();
    await record(member.userId, 'suspend', null, 'active', '2 hours');
    await record(member.userId, 'ban', '2020-01-01T00:00:00Z', 'active', '1 hour');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('a newer open-ended suspension wins over an older expired one', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', '2020-01-01T00:00:00Z', 'active', '2 hours');
    await record(member.userId, 'suspend', null, 'active', '1 hour');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('returns a member who had deactivated to deactivated, not to discovery', async () => {
    const { member } = await suspended();
    await record(member.userId, 'suspend', '2020-01-01T00:00:00Z', 'deactivated');
    await lift(member.userId);
    expect(await statusOf(member.userId)).toBe('deactivated');
  });

  it('with no user named, lifts everyone due and no one else', async () => {
    const due = await suspended();
    const open = await suspended();
    await record(due.member.userId, 'suspend', '2020-01-01T00:00:00Z');
    await record(open.member.userId, 'suspend', null);
    await db.admin(`select app.lift_expired_suspensions()`);
    expect(await statusOf(due.member.userId)).toBe('active');
    expect(await statusOf(open.member.userId)).toBe('suspended');
  });

  it('a member cannot run it, or forge the record it reads', async () => {
    const { member } = await suspended();
    await expect(
      asMember(member, `select app.lift_expired_suspensions(app.current_user_id())`),
    ).rejects.toThrow(/permission denied/);
    await expect(asMember(viewer, `select * from public.moderation_actions`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('only the system record of an expiry may have no staff member behind it', async () => {
    await expect(
      db.admin(
        `insert into public.moderation_actions (subject_user_id, action, reason)
         values ($1::uuid, 'ban', 'no one did this')`,
        [viewer.userId],
      ),
    ).rejects.toThrow(/moderation_actions_actor_present/);
  });
});
