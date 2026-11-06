import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Code review remediation, Phase 4 — the database half (migration 0030).
 *
 *   notification_preferences  owner-only; in-app OFF suppresses inserts from
 *                             ANY writer; security alerts cannot be silenced
 *   push_tokens, profile_views, account_deletion_requests
 *                             restricted / system: no member access at all
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;

const asMember = <T = Record<string, unknown>>(
  user: SeededUser,
  sql: string,
  params: unknown[] = [],
) => db.as<T>('api_member', user.authUserId, sql, params);

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  alice = await seedUser(db, { displayName: 'Prefs Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Prefs Bilal', gender: 'male' });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('notification_preferences', () => {
  it('a member sets their own, and cannot see or set anyone else’s', async () => {
    await asMember(
      alice,
      `insert into public.notification_preferences (user_id, type, inapp_enabled)
       values (app.current_user_id(), 'new_match', false)`,
    );
    await expect(
      asMember(
        alice,
        `insert into public.notification_preferences (user_id, type, inapp_enabled)
         values ($1::uuid, 'new_match', false)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/row-level security/);
    await db.admin(
      `insert into public.notification_preferences (user_id, type, inapp_enabled) values ($1::uuid, 'new_match', true)`,
      [bilal.userId],
    );
    expect(await asMember(alice, `select user_id from public.notification_preferences`)).toEqual(
      [],
    );
  });

  it('in-app OFF suppresses the insert from ANY writer, the service role included', async () => {
    await db.admin(
      `insert into public.notification_preferences (user_id, type, inapp_enabled) values ($1::uuid, 'new_match', false)
       on conflict (user_id, type) do update set inapp_enabled = false`,
      [alice.userId],
    );
    await db.as(
      'service_role',
      null,
      `insert into public.notifications (user_id, type, payload, dedupe_key)
       values ($1::uuid, 'new_match', '{}', 'm1'), ($1::uuid, 'interest_received', '{}', 'i1')`,
      [alice.userId],
    );
    // `as` rolls back; observe inside one service-role statement instead.
    const seen = await db.as<{ type: string }>(
      'service_role',
      null,
      `with ins as (
         insert into public.notifications (user_id, type, payload, dedupe_key)
         values ($1::uuid, 'new_match', '{}', 'm2'), ($1::uuid, 'interest_received', '{}', 'i2')
         returning type
       ) select type from ins order by type`,
      [alice.userId],
    );
    expect(seen.map((r) => r.type)).toEqual(['interest_received']);
  });

  it.each([
    [
      'a security alert silenced in-app',
      `insert into public.notification_preferences (user_id, type, inapp_enabled) values ($1::uuid, 'security_alert', false)`,
      /security_alert_inapp/,
    ],
    [
      'an unknown type',
      `insert into public.notification_preferences (user_id, type) values ($1::uuid, 'marketing')`,
      /type_valid/,
    ],
    [
      'half a quiet-hours window',
      `insert into public.notification_preferences (user_id, type, quiet_hours_start) values ($1::uuid, 'new_message', '22:00')`,
      /quiet_hours_paired/,
    ],
  ])('refuses %s', async (_label, sql, pattern) => {
    await expect(db.admin(sql, [bilal.userId])).rejects.toThrow(pattern);
  });
});

describe('restricted tables: no member access at all', () => {
  it.each(['push_tokens', 'profile_views', 'account_deletion_requests'])('%s', async (table) => {
    await expect(asMember(alice, `select 1 from public.${table}`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.as('anon', null, `select 1 from public.${table}`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('account_deletion_requests constraints', () => {
  it('allows one open request per member, and a hold needs its reason', async () => {
    await db.admin(
      `insert into public.account_deletion_requests (user_id, scheduled_for, previous_status)
       values ($1::uuid, now() + interval '30 days', 'active')`,
      [bilal.userId],
    );
    await expect(
      db.admin(
        `insert into public.account_deletion_requests (user_id, scheduled_for, previous_status)
         values ($1::uuid, now() + interval '30 days', 'active')`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/account_deletion_requests_one_open/);
    await expect(
      db.admin(
        `insert into public.account_deletion_requests (user_id, scheduled_for, status, previous_status)
         values ($1::uuid, now() + interval '30 days', 'held', 'active')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/hold_consistent/);
  });
});

describe('profile_views', () => {
  it('cannot record a member viewing themselves', async () => {
    await expect(
      db.admin(
        `insert into public.profile_views (viewer_user_id, viewed_user_id) values ($1::uuid, $1::uuid)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/profile_views_not_self/);
  });
});

describe('L11 maintenance functions', () => {
  it.each([
    'app.purge_expired_security_events()',
    'app.purge_expired_profile_views()',
    'app.expire_family_invitations()',
  ])('%s is the server’s: members and anon cannot run it', async (fn) => {
    await expect(asMember(alice, `select ${fn}`)).rejects.toThrow(/permission denied/);
    await expect(db.as('anon', null, `select ${fn}`)).rejects.toThrow(/permission denied/);
    await expect(db.as('service_role', null, `select ${fn} as n`)).resolves.toBeDefined();
  });
});
