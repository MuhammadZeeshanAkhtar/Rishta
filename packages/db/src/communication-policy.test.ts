import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `user_settings.communication_policy` and the gate it feeds (migration 0021).
 *
 * This is a pre-beta safeguard, not Phase 6b: there is no delegate here, no
 * review and no approval. What is under test is narrower and, for the moment,
 * more important — that the Family Safety gate is CHOSEN rather than defaulted,
 * at every point a match period begins, and that nobody can reach around it.
 *
 * Three failure modes, each of which would be invisible until 6b shipped and
 * then permanent:
 *
 *   1. a match born `open` while a side required review — the gate never
 *      applied, and ERD §21 invariant 5 forbids retro-fitting it;
 *   2. a live match re-gated by a settings change — invariant 5 again, from
 *      the other direction, and the one that would read as a punishment;
 *   3. unmatch → rematch resetting a gated pair to `open` — a laundering path
 *      that needs no cooperation from anyone.
 *
 * The policy is not member-writable yet, so these tests set it with `admin()`.
 * That is the point: the column exists so that provenance is right from the
 * first match onward, and the *setting* arrives with the slice that can honour
 * it.
 */

let db: TestDb;

/** Matches store the pair ordered, so tests have to as well. */
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function setPolicy(userId: string, policy: string): Promise<void> {
  await db.admin(`update public.user_settings set communication_policy = $2 where user_id = $1`, [
    userId,
    policy,
  ]);
}

/** An accepted interest and the match it creates, by the route's own SQL. */
async function matchOf(
  sender: SeededUser,
  recipient: SeededUser,
): Promise<{ matchId: string; state: string }> {
  const interests = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [sender.userId, recipient.userId],
  );
  const [a, b] = ordered(sender.userId, recipient.userId);
  const rows = await db.admin<{ id: string; communication_state: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid)
     returning id, communication_state`,
    [a, b, interests[0]!.id],
  );
  return { matchId: rows[0]!.id, state: rows[0]!.communication_state };
}

async function stateOf(matchId: string): Promise<string> {
  const rows = await db.admin<{ communication_state: string }>(
    `select communication_state from public.matches where id = $1::uuid`,
    [matchId],
  );
  return rows[0]!.communication_state;
}

async function pair(): Promise<[SeededUser, SeededUser]> {
  return [
    await seedUser(db, { displayName: 'Sender', gender: 'female' }),
    await seedUser(db, { displayName: 'Recipient', gender: 'male' }),
  ];
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

describe('user_settings.communication_policy', () => {
  it('defaults to `direct`, so nobody is gated by arriving', async () => {
    // ERD §7 argues the default: a safety gate that is on for people who have
    // invited nobody locks them out of the product.
    const user = await seedUser(db, { displayName: 'Fresh' });
    const rows = await db.admin<{ communication_policy: string }>(
      `select communication_policy from public.user_settings where user_id = $1`,
      [user.userId],
    );
    expect(rows[0]!.communication_policy).toBe('direct');
  });

  it('is NOT NULL', async () => {
    const user = await seedUser(db, { displayName: 'NotNull' });
    await expect(setPolicy(user.userId, null as unknown as string)).rejects.toThrow(/null/i);
  });

  it('accepts only the two values ADR 0011 defines', async () => {
    const user = await seedUser(db, { displayName: 'Enum' });
    const stored = async (): Promise<string> => {
      const rows = await db.admin<{ p: string }>(
        `select communication_policy as p from public.user_settings where user_id = $1`,
        [user.userId],
      );
      return rows[0]!.p;
    };

    for (const policy of ['family_reviewed', 'direct'] as const) {
      await setPolicy(user.userId, policy);
      expect(await stored()).toBe(policy);
    }

    // A third value would be a gate state nothing knows how to open.
    await expect(setPolicy(user.userId, 'wali_only')).rejects.toThrow(
      /user_settings_communication_policy_valid/,
    );
    expect(await stored()).toBe('direct');
  });

  it('is not member-writable — the omission from the grant list is the control', async () => {
    // `user_settings` IS member-updatable, through a column allowlist the Data
    // API reaches directly. If this column were on that list, someone could
    // choose `family_reviewed` before any delegate exists to open it and stall
    // every match they make.
    const user = await seedUser(db, { displayName: 'NoGrant' });
    await expect(
      db.as(
        'authenticated',
        user.authUserId,
        `update public.user_settings set communication_policy = 'family_reviewed'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is readable by its owner and by nobody else', async () => {
    // The owner's own gate is theirs to see. A counterpart must never learn
    // what the other household expects (ADR 0011).
    const [alice, bilal] = await pair();
    const own = await db.as<{ communication_policy: string }>(
      'authenticated',
      alice.authUserId,
      `select communication_policy from public.user_settings`,
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.communication_policy).toBe('direct');

    const other = await db.as(
      'authenticated',
      bilal.authUserId,
      `select communication_policy from public.user_settings where user_id = $1`,
      [alice.userId],
    );
    expect(other).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// app.required_communication_state
// ---------------------------------------------------------------------------

describe('app.required_communication_state', () => {
  const required = async (a: string, b: string): Promise<string> => {
    const rows = await db.admin<{ v: string }>(
      `select app.required_communication_state($1::uuid, $2::uuid) as v`,
      [a, b],
    );
    return rows[0]!.v;
  };

  it('returns `open` when neither side requires review', async () => {
    const [alice, bilal] = await pair();
    expect(await required(alice.userId, bilal.userId)).toBe('open');
  });

  it('gates the pair when EITHER side requires review', async () => {
    // ADR 0011: "Both sides' families are protected by one person's setting,
    // which is the correct default for a product where the counterpart cannot
    // see what the other household expects."
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    expect(await required(alice.userId, bilal.userId)).toBe('pending_family_review');
    // And symmetrically — the function must not care which argument is which.
    expect(await required(bilal.userId, alice.userId)).toBe('pending_family_review');
  });

  it('gates the pair when both sides require review', async () => {
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    await setPolicy(bilal.userId, 'family_reviewed');
    expect(await required(alice.userId, bilal.userId)).toBe('pending_family_review');
  });

  it('is not callable by a member, so it cannot be used to probe a household', async () => {
    // Called as `authenticated` it would answer "is this person's family
    // strict?" about anybody, which is the one thing the counterpart is never
    // told.
    const [alice, bilal] = await pair();
    for (const actor of ['authenticated', 'anon'] as const) {
      await expect(
        db.as(
          actor,
          alice.authUserId,
          `select app.required_communication_state($1::uuid, $2::uuid)`,
          [alice.userId, bilal.userId],
        ),
        actor,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate at the birth of a match period
// ---------------------------------------------------------------------------

describe('a match is gated at birth, not defaulted', () => {
  it('opens directly when neither side requires review', async () => {
    const [alice, bilal] = await pair();
    expect((await matchOf(alice, bilal)).state).toBe('open');
  });

  it('is born `pending_family_review` when a side requires it', async () => {
    // The provenance this whole migration exists for. A match created here
    // under the old code would have been `open` forever, because invariant 5
    // forbids re-gating it later.
    const [alice, bilal] = await pair();
    await setPolicy(bilal.userId, 'family_reviewed');

    const { matchId, state } = await matchOf(alice, bilal);
    expect(state).toBe('pending_family_review');
    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('ignores a state the caller supplies explicitly', async () => {
    // The gate is the database's answer, not an argument. Service-role code
    // that passed `open` explicitly — by habit, or by copying the old route —
    // must not get it.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');

    const interests = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
       values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
      [alice.userId, bilal.userId],
    );
    const [a, b] = ordered(alice.userId, bilal.userId);
    const rows = await db.admin<{ communication_state: string }>(
      `insert into public.matches (user_a_id, user_b_id, interest_id, communication_state)
       values ($1::uuid, $2::uuid, $3::uuid, 'open')
       returning communication_state`,
      [a, b, interests[0]!.id],
    );
    expect(rows[0]!.communication_state).toBe('pending_family_review');
  });

  it('stamps communication_state_at at birth', async () => {
    const [alice, bilal] = await pair();
    const { matchId } = await matchOf(alice, bilal);
    const rows = await db.admin<{ n: number }>(
      `select count(*)::int as n from public.matches
        where id = $1::uuid and communication_state_at is not null`,
      [matchId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A LIVE match is never re-gated — ERD §21 invariant 5
// ---------------------------------------------------------------------------

describe('a live match is never re-gated by a settings change', () => {
  it('stays `open` after a participant turns review on', async () => {
    // Invariant 5, which is a safety rule and not a convenience one: silently
    // freezing a running conversation from a settings toggle is
    // indistinguishable from a bug, and for someone under pressure at home
    // indistinguishable from a punishment.
    const [alice, bilal] = await pair();
    const { matchId } = await matchOf(alice, bilal);
    expect(await stateOf(matchId)).toBe('open');

    await setPolicy(alice.userId, 'family_reviewed');
    expect(await stateOf(matchId)).toBe('open');

    // Not even an unrelated write to the row disturbs it.
    await db.admin(`update public.matches set interest_id = interest_id where id = $1::uuid`, [
      matchId,
    ]);
    expect(await stateOf(matchId)).toBe('open');
  });

  it('leaves a 6b approval transition alone', async () => {
    // The trigger must not fight the slice it exists for. Moving a live match
    // to `family_approved` is exactly what 6b does, and the trigger has no
    // opinion on it.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    const { matchId } = await matchOf(alice, bilal);
    expect(await stateOf(matchId)).toBe('pending_family_review');

    await db.admin(
      `update public.matches set communication_state = 'family_approved',
              communication_state_at = now() where id = $1::uuid`,
      [matchId],
    );
    expect(await stateOf(matchId)).toBe('family_approved');
  });

  it('does not touch the state when a match ends', async () => {
    // Ending is the member's decision about the relationship; the gate is the
    // family's decision about writing. Migration 0019 keeps them apart and
    // this trigger must not quietly rejoin them.
    const [alice, bilal] = await pair();
    const { matchId } = await matchOf(alice, bilal);
    await setPolicy(alice.userId, 'family_reviewed');

    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid
        where id = $1::uuid`,
      [matchId, alice.userId],
    );
    expect(await stateOf(matchId)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// unmatch → rematch is not a bypass
// ---------------------------------------------------------------------------

describe('unmatch → rematch cannot launder past the gate', () => {
  const unmatch = (matchId: string, by: string) =>
    db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid
        where id = $1::uuid`,
      [matchId, by],
    );

  /** What the accept route does on revival: clear the ending, nothing more. */
  const revive = (matchId: string) =>
    db.admin(
      `update public.matches
          set ended_at = null, ended_by_user_id = null, end_reason = null
        where id = $1::uuid`,
      [matchId],
    );

  it('re-gates a pair who ended it and came back', async () => {
    // THE BYPASS. One row per pair forever, so coming back revives the row.
    // The old route revived it at `open`, so a gated pair had only to unmatch
    // and rematch to escape a review they never had.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');

    const { matchId } = await matchOf(alice, bilal);
    expect(await stateOf(matchId)).toBe('pending_family_review');

    await unmatch(matchId, alice.userId);
    await revive(matchId);

    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('re-gates even a pair who were legitimately `open` before', async () => {
    // The harder case, and the one that makes this a gate rather than a
    // memory: they matched and talked under `direct`, ended it, and a side has
    // since turned review on. The new match period is a match "created
    // afterwards" in invariant 5's own words, so the new policy governs it.
    const [alice, bilal] = await pair();
    const { matchId } = await matchOf(alice, bilal);
    expect(await stateOf(matchId)).toBe('open');

    await unmatch(matchId, bilal.userId);
    await setPolicy(bilal.userId, 'family_reviewed');
    await revive(matchId);

    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('opens a revived match when review is no longer required', async () => {
    // The gate is recomputed, not remembered. A side who has turned review
    // off is not held to a decision they have withdrawn.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    const { matchId } = await matchOf(alice, bilal);

    await unmatch(matchId, alice.userId);
    await setPolicy(alice.userId, 'direct');
    await revive(matchId);

    expect(await stateOf(matchId)).toBe('open');
  });

  it('survives a revival that also names the state explicitly', async () => {
    // Belt and braces: a future caller that revives AND sets `'open'` in the
    // same statement — which is literally what the old route did — still
    // cannot win.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    const { matchId } = await matchOf(alice, bilal);
    await unmatch(matchId, alice.userId);

    await db.admin(
      `update public.matches
          set ended_at = null, ended_by_user_id = null, end_reason = null,
              communication_state = 'open', communication_state_at = now()
        where id = $1::uuid`,
      [matchId],
    );
    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('restamps communication_state_at for the new period', async () => {
    const [alice, bilal] = await pair();
    const { matchId } = await matchOf(alice, bilal);
    const before = await db.admin<{ at: Date }>(
      `select communication_state_at as at from public.matches where id = $1::uuid`,
      [matchId],
    );

    await unmatch(matchId, alice.userId);
    await revive(matchId);

    const after = await db.admin<{ at: Date }>(
      `select communication_state_at as at from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(new Date(after[0]!.at).getTime()).toBeGreaterThanOrEqual(
      new Date(before[0]!.at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// Blocks still outrank everything
// ---------------------------------------------------------------------------

describe('blocks are unaffected by the gate', () => {
  it('still outranks `match` in app.relationship()', async () => {
    // ERD §21 invariant 3. The gate is about whether a matched pair may write;
    // a block is about whether they are a pair at all, and it wins.
    const [alice, bilal] = await pair();
    await setPolicy(alice.userId, 'family_reviewed');
    await matchOf(alice, bilal);

    const relationship = async (a: string, b: string): Promise<string> => {
      const rows = await db.admin<{ v: string }>(
        `select app.relationship($1::uuid, $2::uuid) as v`,
        [a, b],
      );
      return rows[0]!.v;
    };
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');

    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );
    // Both directions: a block is bidirectional in effect regardless of who
    // raised it.
    expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');
    expect(await relationship(bilal.userId, alice.userId)).toBe('blocked');
  });
});
