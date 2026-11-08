import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Code review remediation, Phase 3 — the database half (migration 0029).
 *
 * Each of these was reachable WITHOUT a route: a member writing through the
 * Supabase Data API, or a future caller using the service role carelessly.
 *
 *   B13  only an approved photo can be primary
 *   B6   date of birth locks at completion; edits to reviewed text and the
 *        name send the profile back to review; correction requests are the
 *        member's own and cannot be self-approved
 *   L1   admin tables are unreachable by members; the audit is append-only
 *        for EVERY role; a moderator needs MFA (aal2)
 *   B26  notification retention is service-role only, 12 months
 */

let db: TestDb;

async function completed(name: string): Promise<SeededUser> {
  const user = await seedUser(db, { displayName: name, gender: 'female' });
  await db.admin(`update public.users set profile_completed_at = now() where id = $1::uuid`, [
    user.userId,
  ]);
  await db.admin(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved', now())`,
    [user.userId],
  );
  return user;
}

const asMember = <T = Record<string, unknown>>(
  user: SeededUser,
  sql: string,
  params: unknown[] = [],
) => db.as<T>('api_member', user.authUserId, sql, params);

const asService = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.as<T>('service_role', null, sql, params);

const reviewStatus = async (user: SeededUser): Promise<string> =>
  (
    await db.admin<{ review_status: string }>(
      `select review_status from public.profiles where user_id = $1::uuid`,
      [user.userId],
    )
  )[0]!.review_status;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('B13 — photos_primary_approved', () => {
  it('refuses a member making a pending photo primary through the Data API', async () => {
    const user = await seedUser(db, { displayName: 'Primary', gender: 'female' });
    const photo = await db.admin<{ id: string }>(
      `insert into public.photos (user_id, storage_path, content_type)
       values ($1::uuid, $1::text || '/p/original.jpg', 'image/jpeg') returning id`,
      [user.userId],
    );
    await expect(
      asMember(user, `update public.photos set is_primary = true where id = $1::uuid`, [
        photo[0]!.id,
      ]),
    ).rejects.toThrow(/photos_primary_approved/);
    await db.admin(`update public.photos set moderation_status = 'approved' where id = $1::uuid`, [
      photo[0]!.id,
    ]);
    await asMember(user, `update public.photos set is_primary = true where id = $1::uuid`, [
      photo[0]!.id,
    ]);
  });
});

describe('B6 — the date of birth locks once the profile is complete', () => {
  it('lets a member set it during onboarding', async () => {
    const user = await seedUser(db, { displayName: 'Onboarding', gender: 'female' });
    await asMember(
      user,
      `update public.users set date_of_birth = date '1996-01-01' where id = app.current_user_id()`,
    );
  });

  it('refuses the member afterwards, through the Data API as well', async () => {
    const user = await completed('Locked');
    await expect(
      asMember(
        user,
        `update public.users set date_of_birth = date '1990-01-01' where id = app.current_user_id()`,
      ),
    ).rejects.toThrow(/date of birth is locked/);
  });

  it('still lets the server correct it (the audited workflow)', async () => {
    const user = await completed('Corrected');
    await asService(
      `update public.users set date_of_birth = date '1994-03-02' where id = $1::uuid`,
      [user.userId],
    );
  });
});

describe('B6 — editing what was reviewed sends the profile back to review', () => {
  it.each(['about_me', 'looking_for', 'institution', 'family_background'])(
    'a member editing %s',
    async (column) => {
      const user = await completed(`Edit ${column}`);
      // RETURNING shows the row as the BEFORE trigger left it.
      const rows = await asMember<{ review_status: string }>(
        user,
        `update public.profiles set ${column} = 'Freshly written text that nobody reviewed.'
          where user_id = app.current_user_id() returning review_status`,
      );
      expect(rows[0]!.review_status).toBe('pending');
    },
  );

  it('a reference-coded field does not', async () => {
    const user = await completed('Coded');
    const rows = await asMember<{ review_status: string }>(
      user,
      `update public.profiles set height_cm = 170 where user_id = app.current_user_id() returning review_status`,
    );
    expect(rows[0]!.review_status).toBe('approved');
  });

  it('the server (a moderator decision) does not', async () => {
    const user = await completed('Server');
    const rows = await asService<{ review_status: string }>(
      `update public.profiles set about_me = 'Edited by the server.' where user_id = $1::uuid returning review_status`,
      [user.userId],
    );
    expect(rows[0]!.review_status).toBe('approved');
  });

  it('a member renaming themselves', async () => {
    const user = await completed('Rename');
    // The rename and the read run as the MEMBER in one block, after the AFTER
    // trigger has fired; the block reports what it saw by raising it (`as`
    // rolls every call back, so nothing persists either way).
    await expect(
      asMember(
        user,
        `do $$
         declare s text;
         begin
           update public.users set display_name = 'A New Name' where id = app.current_user_id();
           select review_status into s from public.profiles where user_id = app.current_user_id();
           raise exception 'observed=%', s;
         end $$`,
      ),
    ).rejects.toThrow(/observed=pending/);
  });

  it('a server-side rename does not', async () => {
    const user = await completed('Server rename');
    await asService(`update public.users set display_name = 'Corrected Name' where id = $1::uuid`, [
      user.userId,
    ]);
    expect(await reviewStatus(user)).toBe('approved');
  });
});

describe('B6 — date-of-birth correction requests', () => {
  it('a member files their own, and the database records what the date WAS', async () => {
    const user = await completed('Requester');
    const rows = await asMember<{ current_dob: string; status: string }>(
      user,
      `insert into public.dob_correction_requests (user_id, requested_dob, reason)
       values (app.current_user_id(), date '1994-03-02', 'Entered the wrong year at sign-up.')
       returning current_dob::text as current_dob, status`,
    );
    expect(rows[0]).toEqual({ current_dob: '1995-06-15', status: 'pending' });
  });

  it('cannot be filed for someone else, or self-approved', async () => {
    const user = await completed('Forger');
    const other = await completed('Victim');
    await expect(
      asMember(
        user,
        `insert into public.dob_correction_requests (user_id, requested_dob, reason)
         values ($1::uuid, date '1994-03-02', 'Not mine to file.')`,
        [other.userId],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asMember(
        user,
        `insert into public.dob_correction_requests (user_id, requested_dob, reason, status)
         values (app.current_user_id(), date '1994-03-02', 'Approving myself.', 'approved')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is visible only to its owner', async () => {
    const owner = await completed('Owner');
    const stranger = await completed('Stranger');
    await db.admin(
      `insert into public.dob_correction_requests (user_id, requested_dob, reason)
       values ($1::uuid, date '1994-03-02', 'Entered the wrong year at sign-up.')`,
      [owner.userId],
    );
    const seen = await asMember(stranger, `select id from public.dob_correction_requests`);
    expect(seen).toEqual([]);
  });
});

describe('L1 — admin tables are not a member surface', () => {
  it.each(['admin_users', 'admin_role_assignments', 'admin_action_audit', 'moderation_actions'])(
    'a member cannot read %s',
    async (table) => {
      const user = await completed(`Reader ${table}`);
      await expect(asMember(user, `select 1 from public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it('a member cannot make themselves staff', async () => {
    const user = await completed('Climber');
    await expect(
      asMember(user, `insert into public.admin_users (user_id) values (app.current_user_id())`),
    ).rejects.toThrow(/permission denied/);
  });

  it('the audit is append-only — even for the service role', async () => {
    const staff = await completed('Staffer');
    const admin = await db.admin<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [staff.userId],
    );
    const audit = await db.admin<{ id: string }>(
      `insert into public.admin_action_audit (admin_user_id, action, target_type, target_id)
       values ($1::uuid, 'photo.approve', 'photo', gen_random_uuid()) returning id`,
      [admin[0]!.id],
    );
    await expect(
      asService(
        `update public.admin_action_audit set action = 'photo.reject' where id = $1::uuid`,
        [audit[0]!.id],
      ),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      db.admin(`delete from public.admin_action_audit where id = $1::uuid`, [audit[0]!.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('a ban without a reason is refused by the database', async () => {
    const staff = await completed('Banner');
    const subject = await completed('Subject');
    const admin = await db.admin<{ id: string }>(
      `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
      [staff.userId],
    );
    await expect(
      db.admin(
        `insert into public.moderation_actions (subject_user_id, actor_admin_id, action, reason)
         values ($1::uuid, $2::uuid, 'ban', '   ')`,
        [subject.userId, admin[0]!.id],
      ),
    ).rejects.toThrow(/moderation_actions_reason_present/);
  });
});

describe('L1 — app.is_active_moderator needs an active role and, by default, MFA', () => {
  async function moderator(mfaRequired: boolean): Promise<SeededUser> {
    const user = await completed(`Mod ${mfaRequired}`);
    const admin = await db.admin<{ id: string }>(
      `insert into public.admin_users (user_id, mfa_required) values ($1::uuid, $2) returning id`,
      [user.userId, mfaRequired],
    );
    await db.admin(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, 'moderator')`,
      [admin[0]!.id],
    );
    return user;
  }

  const ask = async (user: SeededUser, aal: string | null): Promise<boolean> => {
    const claims = JSON.stringify({
      sub: user.authUserId,
      role: 'api_member',
      ...(aal ? { aal } : {}),
    });
    const rows = await db.as<{ ok: boolean }>(
      'api_member',
      user.authUserId,
      `select set_config('request.jwt.claims', $1, true) is not null and app.is_active_moderator() as ok`,
      [claims],
    );
    return rows[0]!.ok;
  };

  it('is false without aal2 when MFA is required, true with it', async () => {
    const user = await moderator(true);
    expect(await ask(user, 'aal1')).toBe(false);
    expect(await ask(user, 'aal2')).toBe(true);
  });

  it('is false for a member who is not staff', async () => {
    const user = await completed('Not staff');
    expect(await ask(user, 'aal2')).toBe(false);
  });
});

describe('B26 — notification retention', () => {
  it('removes only notifications older than 12 months, and only for the service role', async () => {
    const user = await completed('Inbox');
    await db.admin(
      `insert into public.notifications (user_id, type, payload, dedupe_key, created_at)
       values ($1::uuid, 'new_match', '{}', 'old', now() - interval '13 months'),
              ($1::uuid, 'new_match', '{}', 'recent', now() - interval '11 months')`,
      [user.userId],
    );
    await expect(asMember(user, `select app.purge_expired_notifications()`)).rejects.toThrow(
      /permission denied/,
    );
    await db.admin(`select app.purge_expired_notifications()`);
    const left = await db.admin<{ dedupe_key: string }>(
      `select dedupe_key from public.notifications where user_id = $1::uuid order by dedupe_key`,
      [user.userId],
    );
    expect(left.map((r) => r.dedupe_key)).toEqual(['recent']);
  });
});
