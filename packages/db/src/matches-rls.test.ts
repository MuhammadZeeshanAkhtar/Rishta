import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `matches`, `match_events`, and the completed `app.relationship()`.
 *
 * A match is a relationship the other person agreed to, so the risk here is
 * FABRICATION: a member who could insert one would manufacture that agreement,
 * and a member who could update `communication_state` could approve their own
 * conversation past the Family Safety gate (ADR 0011). Hence no member write
 * path of any kind — the only way a match appears is by accepting an interest.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let chloe: SeededUser;
let interestId: string;
let matchId: string;

/** Matches store the pair ordered, so tests have to as well. */
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
  chloe = await seedUser(db, { displayName: 'Chloe', gender: 'female' });

  const interests = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [alice.userId, bilal.userId],
  );
  interestId = interests[0]!.id;

  const [a, b] = ordered(alice.userId, bilal.userId);
  const matches = await db.admin<{ id: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid) returning id`,
    [a, b, interestId],
  );
  matchId = matches[0]!.id;

  await db.admin(
    `insert into public.match_events (match_id, event, actor_user_id, to_state)
     values ($1::uuid, 'created', $2::uuid, 'open')`,
    [matchId, bilal.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('matches — shared read, no member writes', () => {
  it('lets both participants read it', async () => {
    for (const member of [alice, bilal]) {
      const rows = await db.as(
        'authenticated',
        member.authUserId,
        `select communication_state from public.matches`,
      );
      expect(rows, member.userId).toHaveLength(1);
    }
  });

  it('shows an uninvolved member nothing', async () => {
    const rows = await db.as('authenticated', chloe.authUserId, `select id from public.matches`);
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member fabricate a match', async () => {
    // The agreement the other person never gave.
    const [a, b] = ordered(chloe.userId, bilal.userId);
    await expect(
      db.as(
        'authenticated',
        chloe.authUserId,
        `insert into public.matches (user_a_id, user_b_id, interest_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [a, b, interestId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let a participant change the communication state', async () => {
    // That column is the Family Safety gate. A member who could write it could
    // approve their own conversation.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.matches set communication_state = 'family_approved'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let a participant delete a match', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.matches`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does NOT let anon read matches', async () => {
    await expect(db.as('anon', null, `select id from public.matches`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('matches — constraints', () => {
  it('refuses a self-match', async () => {
    await expect(
      db.admin(
        `insert into public.matches (user_a_id, user_b_id, interest_id)
         values ($1::uuid, $1::uuid, $2::uuid)`,
        [alice.userId, interestId],
      ),
    ).rejects.toThrow(/matches_ordered|matches_not_self/);
  });

  it('refuses an unordered pair', async () => {
    // Without the ordering rule, (A,B) and (B,A) are different rows and the
    // unique index stops meaning anything.
    const [a, b] = ordered(chloe.userId, bilal.userId);
    await expect(
      db.admin(
        `insert into public.matches (user_a_id, user_b_id, interest_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [b, a, interestId],
      ),
    ).rejects.toThrow(/matches_ordered/);
  });

  it('refuses a second match for the same unordered pair', async () => {
    const [a, b] = ordered(alice.userId, bilal.userId);
    await expect(
      db.admin(
        `insert into public.matches (user_a_id, user_b_id, interest_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [a, b, interestId],
      ),
    ).rejects.toThrow(/matches_pair_key/);
  });

  it('refuses a communication state outside the gate', async () => {
    await expect(
      db.admin(`update public.matches set communication_state = 'whatever' where id = $1::uuid`, [
        matchId,
      ]),
    ).rejects.toThrow(/matches_communication_state_valid/);
  });

  it('refuses the DERIVED active state as a stored value', async () => {
    // `active` means a writable state plus at least one message. Storing it
    // would make it a third source of truth about whether a thread has traffic.
    await expect(
      db.admin(`update public.matches set communication_state = 'active' where id = $1::uuid`, [
        matchId,
      ]),
    ).rejects.toThrow(/matches_communication_state_valid/);
  });

  it('refuses an ending with no one who ended it', async () => {
    await expect(
      db.admin(`update public.matches set ended_at = now() where id = $1::uuid`, [matchId]),
    ).rejects.toThrow(/matches_ended_consistent/);
  });
});

describe('match_events — append-only, no member path', () => {
  it('gives members no read path', async () => {
    for (const member of [alice, bilal]) {
      await expect(
        db.as('authenticated', member.authUserId, `select id from public.match_events`),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('gives members no write path', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.match_events (match_id, event, actor_user_id)
         values ($1::uuid, 'created', app.current_user_id())`,
        [matchId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses an event this slice cannot perform', async () => {
    await expect(
      db.admin(
        `insert into public.match_events (match_id, event, actor_user_id)
         values ($1::uuid, 'revoked', $2::uuid)`,
        [matchId, alice.userId],
      ),
    ).rejects.toThrow(/match_events_event_valid/);
  });
});

describe('interests — the tightened responded_at invariant', () => {
  it('requires responded_at once an interest is answered', async () => {
    // The 0017 version of this constraint could never fail. A constraint that
    // cannot fail is worse than none, because it reads like a guarantee.
    const rows = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id)
       values ($1::uuid, $2::uuid) returning id`,
      [chloe.userId, bilal.userId],
    );
    await expect(
      db.admin(`update public.interests set status = 'declined' where id = $1::uuid`, [
        rows[0]!.id,
      ]),
    ).rejects.toThrow(/interests_responded_consistent/);
  });

  it('refuses a pending interest that claims to have been answered', async () => {
    const pair = await seedUser(db, { displayName: 'Dawood', gender: 'male' });
    await expect(
      db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id, responded_at)
         values ($1::uuid, $2::uuid, now())`,
        [chloe.userId, pair.userId],
      ),
    ).rejects.toThrow(/interests_responded_consistent/);
  });
});

describe('app.relationship — match', () => {
  const relationship = async (viewer: string, target: string): Promise<string> => {
    const rows = await db.admin<{ v: string }>(`select app.relationship($1, $2) as v`, [
      viewer,
      target,
    ]);
    return rows[0]!.v;
  };

  it('reports match to both participants', async () => {
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');
    expect(await relationship(bilal.userId, alice.userId)).toBe('match');
  });

  it('keeps match ABOVE interest_pending', async () => {
    // A matched pair usually still has an interest row; reporting
    // interest_pending for them would describe the weaker relationship.
    const pair = await seedUser(db, { displayName: 'Ehsan', gender: 'male' });
    const interest = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id)
       values ($1::uuid, $2::uuid) returning id`,
      [chloe.userId, pair.userId],
    );
    expect(await relationship(chloe.userId, pair.userId)).toBe('interest_pending');

    const [a, b] = ordered(chloe.userId, pair.userId);
    await db.admin(
      `insert into public.matches (user_a_id, user_b_id, interest_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [a, b, interest[0]!.id],
    );
    expect(await relationship(chloe.userId, pair.userId)).toBe('match');
  });

  it('keeps blocked ABOVE match', async () => {
    // Blocking someone you matched with has to win, or the block is useless
    // for the pair it matters most for.
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );
    try {
      expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');
      expect(await relationship(bilal.userId, alice.userId)).toBe('blocked');
    } finally {
      await db.admin(`delete from public.blocks where blocker_user_id = $1::uuid`, [bilal.userId]);
    }
  });

  it('stops reporting match once the match has ended', async () => {
    // Otherwise unmatching would leave a relationship nothing can clear.
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid
        where id = $1::uuid`,
      [matchId, alice.userId],
    );
    try {
      // The accepted interest is no longer pending, so the pair fall all the
      // way back to strangers.
      expect(await relationship(alice.userId, bilal.userId)).toBe('stranger');
    } finally {
      await db.admin(
        `update public.matches set ended_at = null, ended_by_user_id = null where id = $1::uuid`,
        [matchId],
      );
    }
  });

  it('produces no state whose table does not exist yet', async () => {
    const rows = await db.admin<{ v: string }>(
      `select distinct app.relationship(a.id, b.id) as v
         from public.users a cross join public.users b`,
    );
    for (const row of rows) {
      // The wali states still absent.
      expect(['self', 'blocked', 'match', 'interest_pending', 'stranger']).toContain(row.v);
    }
  });

  it('does NOT change what can_view_profile answers', async () => {
    // `match` lands exactly where `stranger` did. Widening what a match may
    // see belongs to the slice that has a conversation to justify it.
    const rows = await db.admin<{ v: boolean }>(
      `select app.can_view_profile($1::uuid, $2::uuid) as v`,
      [alice.userId, bilal.userId],
    );
    expect(rows[0]!.v).toBe(false);
  });
});
