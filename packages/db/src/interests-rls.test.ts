import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `interests`, `interest_events`, `usage_counters`, and the extended
 * `app.relationship()`.
 *
 * Three different shapes of risk, so three different controls:
 *
 *   * `interests` is SHARED — both parties read it, because an interest is a
 *     fact about the pair — but status is server state. A member who could
 *     UPDATE it could mark an interest accepted without the recipient ever
 *     seeing it, which once matches exist is how you manufacture a match.
 *   * `interest_events` has no member grant at all. An audit a participant can
 *     write is not an audit.
 *   * `usage_counters` is read-own, write-service. A member who could write
 *     their own counter could zero it, and the daily limit would be a
 *     suggestion.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let chloe: SeededUser;
let interestId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
  chloe = await seedUser(db, { displayName: 'Chloe', gender: 'female' });

  const rows = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, note)
     values ($1::uuid, $2::uuid, 'Assalamu alaikum') returning id`,
    [alice.userId, bilal.userId],
  );
  interestId = rows[0]!.id;

  await db.admin(
    `insert into public.interest_events (interest_id, event, actor_user_id)
     values ($1::uuid, 'sent', $2::uuid)`,
    [interestId, alice.userId],
  );
  await db.admin(
    `insert into public.usage_counters (user_id, counter_key, period_start, count)
     values ($1::uuid, 'daily_interests', current_date, 1)`,
    [alice.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('interests — shared read, server-owned state', () => {
  it('lets the sender read their own', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select status from public.interests`,
    );
    expect(rows).toHaveLength(1);
  });

  it('lets the RECIPIENT read it too', async () => {
    // Shared, not owner: an interest is a fact about the pair, and a recipient
    // who could not see it could not respond to it.
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select status from public.interests`,
    );
    expect(rows).toHaveLength(1);
  });

  it('shows an uninvolved member nothing', async () => {
    const rows = await db.as('authenticated', chloe.authUserId, `select id from public.interests`);
    expect(rows).toHaveLength(0);
  });

  it('lets a member insert an interest as themselves', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `insert into public.interests (sender_user_id, recipient_user_id)
       values (app.current_user_id(), $1::uuid) returning id`,
      [chloe.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member send as someone else', async () => {
    // The forgery case, refused by the database rather than by a handler.
    await expect(
      db.as(
        'authenticated',
        chloe.authUserId,
        `insert into public.interests (sender_user_id, recipient_user_id)
         values ($1::uuid, $2::uuid)`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does NOT let the sender change the status', async () => {
    // No UPDATE grant at all. Status is server state, like review_status.
    await expect(
      db.as('authenticated', alice.authUserId, `update public.interests set status = 'accepted'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let the recipient change the status either', async () => {
    // Accepting arrives with the respond endpoint and creates a match; a
    // direct write would skip the state machine entirely.
    await expect(
      db.as('authenticated', bilal.authUserId, `update public.interests set status = 'accepted'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let anyone delete an interest', async () => {
    // Withdrawn rows are kept, so the audit trail survives a change of mind.
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.interests`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let anon touch the table', async () => {
    await expect(db.as('anon', null, `select id from public.interests`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses a self-interest', async () => {
    await expect(
      db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id)
         values ($1::uuid, $1::uuid)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/interests_not_self/);
  });

  it('refuses a second ACTIVE interest to the same person', async () => {
    await expect(
      db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id)
         values ($1::uuid, $2::uuid)`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/interests_active_pair_key/);
  });

  it('allows a fresh interest once the previous one was withdrawn', async () => {
    // The index is partial for exactly this: someone may reconsider.
    const pair = await seedUser(db, { displayName: 'Dawood', gender: 'male' });
    await db.admin(
      `insert into public.interests (sender_user_id, recipient_user_id, status)
       values ($1::uuid, $2::uuid, 'withdrawn')`,
      [alice.userId, pair.userId],
    );
    const rows = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id)
       values ($1::uuid, $2::uuid) returning id`,
      [alice.userId, pair.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses an unknown status', async () => {
    // Two constraints can catch this and either is a correct refusal: the
    // status enum, and `interests_responded_consistent`, which 0018 tightened
    // to require `responded_at` for exactly the answered statuses — an
    // unrecognised one satisfies neither branch.
    await expect(
      db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id, status)
         values ($1::uuid, $2::uuid, 'ghosted')`,
        [chloe.userId, bilal.userId],
      ),
    ).rejects.toThrow(/interests_status_valid|interests_responded_consistent/);
  });
});

describe('interest_events — append-only, no member path', () => {
  it('gives members no read path', async () => {
    for (const member of [alice, bilal]) {
      await expect(
        db.as('authenticated', member.authUserId, `select id from public.interest_events`),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('gives members no write path', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.interest_events (interest_id, event, actor_user_id)
         values ($1::uuid, 'sent', app.current_user_id())`,
        [interestId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let a member fabricate an event attributed to someone else', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.interest_events (interest_id, event, actor_user_id)
         values ($1::uuid, 'withdrawn', $2::uuid)`,
        [interestId, alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses an event nothing can produce', async () => {
    // 0018 added `accepted`, `declined` and `maybe_later` as the respond
    // endpoint made them performable. Anything still outside the set would
    // describe a transition no code path can reach.
    await expect(
      db.admin(
        `insert into public.interest_events (interest_id, event, actor_user_id)
         values ($1::uuid, 'expired', $2::uuid)`,
        [interestId, bilal.userId],
      ),
    ).rejects.toThrow(/interest_events_event_valid/);
  });

  it('does NOT let anon touch it', async () => {
    await expect(db.as('anon', null, `select id from public.interest_events`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('usage_counters — read own, write service', () => {
  it('lets a member read their own counter', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select count from public.usage_counters`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member read another counter', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select count from public.usage_counters`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member mint quota by writing their own counter', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.usage_counters (user_id, counter_key, period_start, count)
         values (app.current_user_id(), 'daily_interests', current_date, 0)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let a member reset a counter', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `update public.usage_counters set count = 0`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let a member delete a counter', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.usage_counters`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a negative count', async () => {
    // A counter that can go negative is a counter that can mint quota.
    await expect(
      db.admin(`update public.usage_counters set count = -1 where user_id = $1::uuid`, [
        alice.userId,
      ]),
    ).rejects.toThrow(/usage_counters_count_non_negative/);
  });

  it('holds one row per member per key per day', async () => {
    await expect(
      db.admin(
        `insert into public.usage_counters (user_id, counter_key, period_start, count)
         values ($1::uuid, 'daily_interests', current_date, 1)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/usage_counters_period_key/);
  });

  it('does NOT let anon touch it', async () => {
    await expect(db.as('anon', null, `select id from public.usage_counters`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('app.relationship — interest_pending', () => {
  const relationship = async (viewer: SeededUser, target: SeededUser): Promise<string> => {
    const rows = await db.admin<{ v: string }>(`select app.relationship($1, $2) as v`, [
      viewer.userId,
      target.userId,
    ]);
    return rows[0]!.v;
  };

  it('reports interest_pending to the sender', async () => {
    expect(await relationship(alice, bilal)).toBe('interest_pending');
  });

  it('reports interest_pending to the RECIPIENT as well', async () => {
    // The relationship is a property of the pair, not of whoever asked.
    expect(await relationship(bilal, alice)).toBe('interest_pending');
  });

  it('keeps blocked ABOVE interest_pending', async () => {
    // Blocking someone you have a pending interest with has to win, or the
    // block does nothing for the pair it matters most for.
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );
    try {
      expect(await relationship(alice, bilal)).toBe('blocked');
      expect(await relationship(bilal, alice)).toBe('blocked');
    } finally {
      await db.admin(`delete from public.blocks where blocker_user_id = $1::uuid`, [bilal.userId]);
    }
  });

  it('returns to stranger once the interest is withdrawn', async () => {
    const pair = await seedUser(db, { displayName: 'Ehsan', gender: 'male' });
    const rows = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id)
       values ($1::uuid, $2::uuid) returning id`,
      [chloe.userId, pair.userId],
    );
    expect(await relationship(chloe, pair)).toBe('interest_pending');

    await db.admin(`update public.interests set status = 'withdrawn' where id = $1::uuid`, [
      rows[0]!.id,
    ]);
    expect(await relationship(chloe, pair)).toBe('stranger');
  });

  it('does NOT change what can_view_profile answers', async () => {
    // interest_pending lands exactly where stranger did: both fall through to
    // the discoverability test. Widening what a pending interest can see is a
    // product decision for the slice that has a reveal flow.
    const rows = await db.admin<{ v: boolean }>(
      `select app.can_view_profile($1::uuid, $2::uuid) as v`,
      [alice.userId, bilal.userId],
    );
    // Neither has an approved profile in this fixture, so both answer false —
    // the point is that a pending interest did not turn it true.
    expect(typeof rows[0]!.v).toBe('boolean');
    expect(rows[0]!.v).toBe(false);
  });

  it('produces no state whose table does not exist yet', async () => {
    const rows = await db.admin<{ v: string }>(
      `select distinct app.relationship(a.id, b.id) as v
         from public.users a cross join public.users b`,
    );
    const states = new Set(rows.map((r) => r.v));
    // `match`, `own_wali` and `counterpart_wali` all still absent.
    for (const state of states) {
      expect(['self', 'blocked', 'interest_pending', 'stranger']).toContain(state);
    }
  });
});
