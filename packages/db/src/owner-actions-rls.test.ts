import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `shortlists` and `dismissed_profiles` — the first tables in this phase that
 * members write directly.
 *
 * That makes ownership the whole question, and it has to hold at the DATABASE
 * rather than only in a route handler. These tests go straight at the tables
 * as an authenticated member, with no API in the way, because an API-level
 * check is only as good as the handler that remembers to call it.
 *
 * Two asymmetries worth stating:
 *   * the saved member is never told, so there is no read path for them;
 *   * a dismissal must be undetectable, because a detectable one is a
 *     rejection notice — which is not what "not interested" means.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let chloe: SeededUser;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
  chloe = await seedUser(db, { displayName: 'Chloe', gender: 'female' });

  await db.admin(
    `insert into public.shortlists (user_id, target_user_id) values ($1::uuid, $2::uuid)`,
    [alice.userId, bilal.userId],
  );
  await db.admin(
    `insert into public.dismissed_profiles (user_id, target_user_id) values ($1::uuid, $2::uuid)`,
    [alice.userId, chloe.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('shortlists', () => {
  it('lets the owner read their own', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select target_user_id from public.shortlists`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let the saved member learn they were saved', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select user_id from public.shortlists`,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets the owner save someone', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `insert into public.shortlists (user_id, target_user_id)
       values (app.current_user_id(), $1::uuid) returning id`,
      [chloe.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member save on someone else behalf', async () => {
    // The forgery case. A handler that forgot to scope `user_id` would be
    // caught here rather than in production.
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.shortlists (user_id, target_user_id)
         values ($1::uuid, $2::uuid)`,
        [alice.userId, chloe.userId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does NOT let a member delete another member shortlist row', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `delete from public.shortlists where user_id = $1::uuid returning id`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
    // And Alice's row survives.
    const left = await db.as('authenticated', alice.authUserId, `select id from public.shortlists`);
    expect(left).toHaveLength(1);
  });

  it('does NOT let a member reassign ownership of a row', async () => {
    // No UPDATE grant at all, so `user_id` and `target_user_id` cannot be
    // moved. There is nothing mutable on these rows by design.
    await expect(
      db.as('authenticated', alice.authUserId, `update public.shortlists set user_id = $1::uuid`, [
        bilal.userId,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a self-shortlist', async () => {
    await expect(
      db.admin(
        `insert into public.shortlists (user_id, target_user_id) values ($1::uuid, $1::uuid)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/shortlists_not_self/);
  });

  it('holds one row per pair, which is what makes saving idempotent', async () => {
    await expect(
      db.admin(
        `insert into public.shortlists (user_id, target_user_id) values ($1::uuid, $2::uuid)`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/shortlists_pair_key/);
  });

  it('does NOT let anon touch the table', async () => {
    await expect(db.as('anon', null, `select id from public.shortlists`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('dismissed_profiles', () => {
  it('lets the owner read their own dismissals', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select target_user_id from public.dismissed_profiles`,
    );
    expect(rows).toHaveLength(1);
  });

  it('is UNDETECTABLE to the dismissed member', async () => {
    // The property that makes "not interested" different from a rejection
    // notice. Chloe must have no way to learn Alice dismissed her.
    const rows = await db.as(
      'authenticated',
      chloe.authUserId,
      `select user_id from public.dismissed_profiles`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member dismiss on someone else behalf', async () => {
    await expect(
      db.as(
        'authenticated',
        chloe.authUserId,
        `insert into public.dismissed_profiles (user_id, target_user_id)
         values ($1::uuid, $2::uuid)`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does NOT let the dismissed member delete the dismissal', async () => {
    // Undoing someone else's "not interested" would resurrect a profile they
    // already said no to.
    const rows = await db.as(
      'authenticated',
      chloe.authUserId,
      `delete from public.dismissed_profiles returning id`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member reassign a dismissal', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.dismissed_profiles set target_user_id = $1::uuid`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a self-dismissal', async () => {
    await expect(
      db.admin(
        `insert into public.dismissed_profiles (user_id, target_user_id)
         values ($1::uuid, $1::uuid)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/dismissed_profiles_not_self/);
  });

  it('holds one row per pair', async () => {
    await expect(
      db.admin(
        `insert into public.dismissed_profiles (user_id, target_user_id)
         values ($1::uuid, $2::uuid)`,
        [alice.userId, chloe.userId],
      ),
    ).rejects.toThrow(/dismissed_profiles_pair_key/);
  });

  it('does NOT let anon touch the table', async () => {
    await expect(db.as('anon', null, `select id from public.dismissed_profiles`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});
