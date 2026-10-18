import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `user_entitlements` — who may read and, far more importantly, who may write.
 *
 * The risk this table carries is not disclosure. An entitlement is not secret;
 * the member is told what they may do. The risk is **self-elevation** — a
 * member who can write this table grants themselves `who_viewed_me`, turns on
 * `incognito`, or raises their own `daily_interests`.
 *
 * So the control is the GRANT, not the policy: `authenticated` holds SELECT
 * and nothing else, and there is deliberately no INSERT, UPDATE or DELETE
 * policy because there is no privilege for one to govern. These tests assert
 * the absence, which is the part that cannot be seen by reading the policies.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });

  await db.admin(
    `insert into public.user_entitlements (user_id, entitlement_key, value, source)
     values ($1::uuid, 'who_viewed_me', 'true'::jsonb, 'grant')`,
    [alice.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('reads', () => {
  it('lets a member read their own entitlements', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select entitlement_key, value from public.user_entitlements`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entitlement_key).toBe('who_viewed_me');
  });

  it('does NOT let a member read another member entitlements', async () => {
    // Bilal asking for Alice's row by id gets nothing, rather than an error
    // that would confirm the row exists.
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select entitlement_key from public.user_entitlements where user_id = $1::uuid`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let anon read entitlements at all', async () => {
    // Refused at the grant, before any policy runs.
    await expect(
      db.as('anon', null, `select entitlement_key from public.user_entitlements`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('a member cannot elevate themselves', () => {
  it('cannot grant themselves an entitlement', async () => {
    // The whole reason this table is service-role-write.
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'who_viewed_me', 'true'::jsonb)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot raise the value of an entitlement they already hold', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.user_entitlements set value = '999'::jsonb where user_id = $1::uuid`,
        [alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot delete an entitlement to escape a restriction', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `delete from public.user_entitlements where user_id = $1::uuid`,
        [alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot write an entitlement onto another member', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'profile_boost', 'true'::jsonb)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('the service role manages entitlements', () => {
  it('can write on a member behalf', async () => {
    const rows = await db.as(
      'service_role',
      null,
      `insert into public.user_entitlements (user_id, entitlement_key, value, source)
       values ($1::uuid, 'advanced_filters', 'true'::jsonb, 'promo')
       returning entitlement_key`,
      [bilal.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('can revoke', async () => {
    await db.as(
      'service_role',
      null,
      `delete from public.user_entitlements
        where user_id = $1::uuid and entitlement_key = 'advanced_filters'`,
      [bilal.userId],
    );
    const left = await db.as(
      'authenticated',
      bilal.authUserId,
      `select entitlement_key from public.user_entitlements`,
    );
    expect(left).toHaveLength(0);
  });
});

describe('constraints', () => {
  it('refuses an entitlement key the product does not define', async () => {
    // A typo would otherwise sit in the table matching nothing, applying
    // nothing, and raising nothing.
    await expect(
      db.admin(
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'advanced_filterz', 'true'::jsonb)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/user_entitlements_key_valid/);
  });

  it('refuses a value that is neither a flag nor a number', async () => {
    await expect(
      db.admin(
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'incognito', '"yes"'::jsonb)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/user_entitlements_value_shape/);
  });

  it('refuses an unknown source', async () => {
    await expect(
      db.admin(
        `insert into public.user_entitlements (user_id, entitlement_key, value, source)
         values ($1::uuid, 'incognito', 'true'::jsonb, 'because_i_said_so')`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/user_entitlements_source_valid/);
  });

  it('holds one row per member per key', async () => {
    await expect(
      db.admin(
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'who_viewed_me', 'false'::jsonb)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/user_entitlements_user_key_key/);
  });

  it('accepts a number, because not every entitlement is a flag', async () => {
    const rows = await db.admin<{ value: unknown }>(
      `insert into public.user_entitlements (user_id, entitlement_key, value)
       values ($1::uuid, 'daily_interests', '25'::jsonb)
       returning value`,
      [bilal.userId],
    );
    expect(rows[0]!.value).toBe(25);
  });
});
