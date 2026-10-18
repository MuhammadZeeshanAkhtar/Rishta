import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `notifications`.
 *
 * Two write risks, and they point in opposite directions:
 *
 *   * **Forgery.** A member who could INSERT could send themselves — or worse,
 *     someone else — a "you have a new match" from a person who never matched
 *     them.
 *   * **Erasure.** `security_alert` is one of the contract's types, and an
 *     alert its subject can delete is not an alert. So no DELETE either.
 *
 * Between them sits the one thing a member legitimately does: mark something
 * read. That is a COLUMN-level grant on `read_at` alone, so it cannot become
 * rewriting the type or the payload.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let aliceNotification: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });

  const rows = await db.admin<{ id: string }>(
    `insert into public.notifications (user_id, type, dedupe_key, payload)
     values ($1::uuid, 'interest_received', 'seed-1', '{"actorUserId":"x"}'::jsonb)
     returning id`,
    [alice.userId],
  );
  aliceNotification = rows[0]!.id;
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('reads', () => {
  it('lets the owner read their own', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select type from public.notifications`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let another member read them', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select type from public.notifications`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let anon read any', async () => {
    await expect(db.as('anon', null, `select id from public.notifications`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('a member cannot forge one', () => {
  it('cannot insert for themselves', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.notifications (user_id, type, dedupe_key)
         values (app.current_user_id(), 'new_match', 'forged')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot insert for someone else', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.notifications (user_id, type, dedupe_key)
         values ($1::uuid, 'security_alert', 'forged')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot delete one', async () => {
    // `security_alert` lives in this table. An alert its subject can erase is
    // not an alert.
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.notifications`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot rewrite the type or payload while marking it read', async () => {
    // The grant is column-level on read_at, so these are refused outright.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.notifications set type = 'new_match'`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.notifications set payload = '{"hacked":true}'::jsonb`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('marking read', () => {
  it('lets the owner set read_at', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.notifications set read_at = now()
        where id = $1::uuid returning id`,
      [aliceNotification],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let another member mark it read', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `update public.notifications set read_at = now() returning id`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('constraints', () => {
  it('refuses a type outside the contract enum', async () => {
    await expect(
      db.admin(
        `insert into public.notifications (user_id, type, dedupe_key)
         values ($1::uuid, 'you_have_mail', 'x')`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/notifications_type_valid/);
  });

  it('refuses a payload that is not an object', async () => {
    await expect(
      db.admin(
        `insert into public.notifications (user_id, type, dedupe_key, payload)
         values ($1::uuid, 'new_match', 'x', '"nope"'::jsonb)`,
        [bilal.userId],
      ),
    ).rejects.toThrow(/notifications_payload_object/);
  });

  it('refuses a duplicate of the same event for the same member', async () => {
    await expect(
      db.admin(
        `insert into public.notifications (user_id, type, dedupe_key)
         values ($1::uuid, 'interest_received', 'seed-1')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/notifications_dedupe_key/);
  });

  it('allows the SAME event key for a different member', async () => {
    // Both participants of a match share one dedupe key; the constraint is
    // per member, which is what lets each of them be told.
    const rows = await db.admin<{ id: string }>(
      `insert into public.notifications (user_id, type, dedupe_key)
       values ($1::uuid, 'interest_received', 'seed-1') returning id`,
      [bilal.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('allows a different event of the same type for the same member', async () => {
    // A rematch is exactly this: same type, same pair, different event key.
    const rows = await db.admin<{ id: string }>(
      `insert into public.notifications (user_id, type, dedupe_key)
       values ($1::uuid, 'interest_received', 'seed-2') returning id`,
      [alice.userId],
    );
    expect(rows).toHaveLength(1);
  });
});
