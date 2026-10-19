import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Conversations — the policy boundary (Phase 7, ERD §11).
 *
 * One property dominates this suite, and the ERD named it before any of this
 * was built: **the read policy and the write policy answer different
 * questions.**
 *
 *   READ  = are you a participant?
 *   WRITE = are you a participant AND does the gate currently permit writing?
 *
 * Membership is necessary and not sufficient. Everything below is a way of
 * asking whether that distinction actually holds at the table, because a
 * route that enforced it correctly over a policy that did not would be one
 * PostgREST call away from letting a revoked family approval be ignored.
 */

let db: TestDb;

let alice: SeededUser;
let bilal: SeededUser;
let stranger: SeededUser;

let matchId: string;
let conversationId: string;

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Moves the match's gate, as a delegate's decision or a block would. */
async function setState(state: string): Promise<void> {
  await db.admin(`update public.matches set communication_state = $2 where id = $1::uuid`, [
    matchId,
    state,
  ]);
}

/** Attempts a member INSERT and reports whether the row landed. */
async function trySend(who: SeededUser, body: string): Promise<boolean> {
  try {
    const rows = await db.as(
      'authenticated',
      who.authUserId,
      `insert into public.messages (conversation_id, sender_user_id, body)
       values ($1::uuid, app.current_user_id(), $2)
       returning id`,
      [conversationId, body],
    );
    return rows.length === 1;
  } catch (error) {
    // A WITH CHECK failure RAISES rather than filtering the row away, which
    // is the one way an INSERT policy differs from a SELECT one. Anything
    // else is a real fault and must not be reported as "refused".
    const message = (error as Error).message;
    if (/violates row-level security policy/i.test(message)) return false;
    throw error;
  }
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
  stranger = await seedUser(db, { displayName: 'Stranger', gender: 'female' });

  const interest = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [bilal.userId, alice.userId],
  );

  const [a, b] = ordered(alice.userId, bilal.userId);
  const match = await db.admin<{ id: string; communication_state: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid)
     returning id, communication_state`,
    [a, b, interest[0]!.id],
  );
  matchId = match[0]!.id;

  // Neither side requires review, so the gate opens at birth and the trigger
  // should already have built the thread.
  if (match[0]!.communication_state !== 'open') {
    throw new Error(`seed: expected an open match, got ${match[0]!.communication_state}`);
  }

  const conversation = await db.admin<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [matchId],
  );
  if (!conversation[0]) {
    throw new Error('seed: the trigger did not create a conversation for an open match');
  }
  conversationId = conversation[0].id;

  // One real message, written with admin() so it PERSISTS. Everything the
  // suite asserts about surviving history reads this row; `trySend` below
  // goes through `db.as()`, which always rolls back, so it can prove the
  // policy accepted a write and can never leave one behind.
  await db.admin(
    `insert into public.messages (conversation_id, sender_user_id, body)
     values ($1::uuid, $2::uuid, 'Assalamu alaikum, seeded history.')`,
    [conversationId, alice.userId],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('the trigger builds the thread, so no route has to remember', () => {
  it('created the conversation when the gate opened', async () => {
    const rows = await db.admin<{ status: string }>(
      `select status from public.conversations where id = $1::uuid`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('active');
  });

  it('enrolled both principals and nobody else', async () => {
    const rows = await db.admin<{ user_id: string; role: string; can_write: boolean }>(
      `select user_id, role, can_write from public.conversation_participants
        where conversation_id = $1::uuid order by user_id`,
      [conversationId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      ordered(alice.userId, bilal.userId).slice().sort(),
    );
    for (const row of rows) {
      expect(row.role).toBe('principal');
      expect(row.can_write).toBe(true);
    }
  });

  it('started the thread at stage 1', async () => {
    const rows = await db.admin<{ current_stage: number }>(
      `select current_stage from public.conversation_stages where conversation_id = $1::uuid`,
      [conversationId],
    );
    expect(rows[0]!.current_stage).toBe(1);
  });

  it('does NOT create a thread for a match still awaiting review', async () => {
    // Putting the gate on the thread would mean creating a thread in order to
    // forbid it (ERD §11).
    const owner = await seedUser(db, { displayName: 'Gated', gender: 'female' });
    const suitor = await seedUser(db, { displayName: 'Suitor', gender: 'male' });
    await db.admin(
      `update public.user_settings set communication_policy = 'family_reviewed'
        where user_id = $1::uuid`,
      [owner.userId],
    );

    const interest = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
       values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
      [suitor.userId, owner.userId],
    );
    const [p, q] = ordered(owner.userId, suitor.userId);
    const gated = await db.admin<{ id: string; communication_state: string }>(
      `insert into public.matches (user_a_id, user_b_id, interest_id)
       values ($1::uuid, $2::uuid, $3::uuid) returning id, communication_state`,
      [p, q, interest[0]!.id],
    );
    expect(gated[0]!.communication_state).toBe('pending_family_review');

    const threads = await db.admin(
      `select id from public.conversations where match_id = $1::uuid`,
      [gated[0]!.id],
    );
    expect(threads).toEqual([]);

    // And it appears the moment the gate opens, without anyone asking.
    await db.admin(
      `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
      [gated[0]!.id],
    );
    const after = await db.admin<{ id: string; last_message_at: string | null }>(
      `select id, last_message_at from public.conversations where match_id = $1::uuid`,
      [gated[0]!.id],
    );
    expect(after).toHaveLength(1);
    // Null until something is said. That is what makes the exposed `active`
    // state DERIVABLE rather than a third thing that can disagree with
    // `messages` about whether a thread has traffic.
    expect(after[0]!.last_message_at).toBeNull();
  });
});

describe('reading is membership', () => {
  it('lets both participants read the thread', async () => {
    for (const who of [alice, bilal]) {
      const rows = await db.as(
        'authenticated',
        who.authUserId,
        `select id from public.conversations`,
      );
      expect(rows).toHaveLength(1);
    }
  });

  it('shows a stranger nothing — not the thread, not its members, not its stage', async () => {
    for (const table of [
      'public.conversations',
      'public.conversation_participants',
      'public.conversation_stages',
      'public.messages',
      'public.message_reads',
    ]) {
      const rows = await db.as('authenticated', stranger.authUserId, `select * from ${table}`);
      expect(rows, `${table} leaked to a stranger`).toEqual([]);
    }
  });

  it('refuses anon everywhere', async () => {
    await expect(db.as('anon', null, `select id from public.messages`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('keeps stage_transitions out of every member’s reach', async () => {
    // RLS `system` (ERD §11): a proposal is read through the API, which
    // decides what each side may see about it. No grant, so this is refused
    // before a policy is even consulted.
    await expect(
      db.as('authenticated', alice.authUserId, `select id from public.stage_transitions`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('writing is membership AND the gate', () => {
  it('lets a participant send while the gate is open', async () => {
    expect(await trySend(alice, 'Assalamu alaikum.')).toBe(true);
  });

  it('refuses a stranger, who is not a participant at all', async () => {
    expect(await trySend(stranger, 'Let me in.')).toBe(false);
  });

  it('refuses sending AS SOMEBODY ELSE', async () => {
    // The policy pins `sender_user_id` as well as membership, so a direct
    // Data API insert cannot put words in the counterpart's mouth.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.messages (conversation_id, sender_user_id, body)
         values ($1::uuid, $2::uuid, 'Bilal did not write this')
         returning id`,
        [conversationId, bilal.userId],
      ),
    ).rejects.toThrow(/violates row-level security policy/i);
  });

  it('CLOSES WRITES when a family approval is revoked, and keeps the thread readable', async () => {
    // The single most important behaviour in this file. A revocation must
    // stop the conversation continuing without deleting what two people
    // already said to each other.
    await setState('revoked');

    expect(await trySend(alice, 'Still there?')).toBe(false);
    expect(await trySend(bilal, 'Hello?')).toBe(false);

    const readable = await db.as(
      'authenticated',
      alice.authUserId,
      `select id from public.messages where conversation_id = $1::uuid`,
      [conversationId],
    );
    expect(readable.length, 'the history must survive a revocation').toBeGreaterThan(0);

    await setState('open');
    expect(await trySend(alice, 'Back again.')).toBe(true);
  });

  it('refuses while a review is still pending', async () => {
    await setState('pending_family_review');
    expect(await trySend(alice, 'Before approval')).toBe(false);
    await setState('open');
  });

  it('refuses after a family rejection', async () => {
    await setState('family_rejected');
    expect(await trySend(alice, 'After a no')).toBe(false);
    await setState('open');
  });

  it('permits writing under family_approved, which is an OPEN state', async () => {
    await setState('family_approved');
    expect(await trySend(alice, 'Approved by family.')).toBe(true);
    await setState('open');
  });

  it('refuses in the `blocked` state', async () => {
    await setState('blocked');
    expect(await trySend(alice, 'Blocked state')).toBe(false);
    await setState('open');
  });

  it('refuses once a BLOCK exists, whichever direction it points', async () => {
    // The gate column can say `open` while a block exists: `app.relationship()`
    // answers `blocked` above `match` without touching the match row, which is
    // deliberate (migration 0011). So the predicate checks the block itself.
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );

    expect(await trySend(alice, 'Blocked by them')).toBe(false);
    expect(await trySend(bilal, 'I blocked them')).toBe(false);

    await db.admin(`delete from public.blocks where blocker_user_id = $1::uuid`, [bilal.userId]);
    expect(await trySend(alice, 'Unblocked')).toBe(true);
  });

  it('refuses once the match has ENDED, even though the state still says open', async () => {
    // Migration 0019 warned about exactly this: "an ended match can still be
    // sitting in `open`", so the state alone is not a sufficient check.
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid where id = $1::uuid`,
      [matchId, alice.userId],
    );

    const state = await db.admin<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(state[0]!.communication_state).toBe('open');
    expect(await trySend(alice, 'After unmatching')).toBe(false);

    await db.admin(
      `update public.matches set ended_at = null, ended_by_user_id = null where id = $1::uuid`,
      [matchId],
    );
  });

  it('refuses a participant who has LEFT', async () => {
    await db.admin(
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, alice.userId],
    );
    expect(await trySend(alice, 'After leaving')).toBe(false);
    // And the counterpart is unaffected.
    expect(await trySend(bilal, 'Still here')).toBe(true);

    await db.admin(
      `update public.conversation_participants set left_at = null
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, alice.userId],
    );
  });

  it('refuses a participant whose can_write is false', async () => {
    // The M2 shape: a delegate who may watch and not speak. Reachable now so
    // the column is not retrofitted onto a live policy later.
    await db.admin(
      `update public.conversation_participants set can_write = false
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, alice.userId],
    );
    expect(await trySend(alice, 'Watching only')).toBe(false);

    // Still readable — that is the whole point of the distinction.
    const readable = await db.as(
      'authenticated',
      alice.authUserId,
      `select id from public.messages`,
    );
    expect(readable.length).toBeGreaterThan(0);

    await db.admin(
      `update public.conversation_participants set can_write = true
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, alice.userId],
    );
  });

  it('refuses when the participants have archived the thread', async () => {
    await db.admin(`update public.conversations set status = 'archived' where id = $1::uuid`, [
      conversationId,
    ]);
    expect(await trySend(alice, 'Into the archive')).toBe(false);
    await db.admin(`update public.conversations set status = 'active' where id = $1::uuid`, [
      conversationId,
    ]);
  });
});

describe('messages carry no member write path beyond the insert', () => {
  it('refuses a member UPDATE — editing is server state', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.messages set body = 'rewritten' where conversation_id = $1::uuid`,
        [conversationId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a member DELETE — report evidence depends on these rows', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.messages`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a member setting moderation_status or acted_by_user_id', async () => {
    // Not in the column grant. A member who could set `moderation_status`
    // would clear a flag on their own message; one who could set
    // `acted_by_user_id` would attribute their words to a delegate.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.messages
           (conversation_id, sender_user_id, body, moderation_status)
         values ($1::uuid, app.current_user_id(), 'clean please', 'clean')`,
        [conversationId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses an empty body at the database', async () => {
    await expect(
      db.admin(
        `insert into public.messages (conversation_id, sender_user_id, body)
         values ($1::uuid, $2::uuid, '')`,
        [conversationId, alice.userId],
      ),
    ).rejects.toThrow(/messages_body_len/);
  });

  it('maintains last_message_at without the API being asked to', async () => {
    const before = await db.admin<{ last_message_at: string | null }>(
      `select last_message_at from public.conversations where id = $1::uuid`,
      [conversationId],
    );
    expect(before[0]!.last_message_at).not.toBeNull();
  });
});

describe('stage advancement is mutual', () => {
  it('refuses accepting your own proposal', async () => {
    const proposal = await db.admin<{ id: string }>(
      `insert into public.stage_transitions
         (conversation_id, from_stage, to_stage, proposed_by_user_id)
       values ($1::uuid, 1, 2, $2::uuid) returning id`,
      [conversationId, alice.userId],
    );

    // The mutuality IS the control: one side must not be able to move a
    // conversation to a stage that unlocks more of the other person.
    await expect(
      db.admin(
        `update public.stage_transitions
            set status = 'accepted', responded_by_user_id = $2::uuid, responded_at = now()
          where id = $1::uuid`,
        [proposal[0]!.id, alice.userId],
      ),
    ).rejects.toThrow(/stage_transitions_not_self_accepted/);

    await db.admin(
      `update public.stage_transitions
          set status = 'accepted', responded_by_user_id = $2::uuid, responded_at = now()
        where id = $1::uuid`,
      [proposal[0]!.id, bilal.userId],
    );
  });

  it('refuses skipping a stage or going backwards', async () => {
    for (const [from, to] of [
      [2, 4],
      [2, 1],
    ]) {
      await expect(
        db.admin(
          `insert into public.stage_transitions
             (conversation_id, from_stage, to_stage, proposed_by_user_id)
           values ($1::uuid, $2::int, $3::int, $4::uuid)`,
          [conversationId, from, to, alice.userId],
        ),
      ).rejects.toThrow(/stage_transitions_forward/);
    }
  });

  it('allows only one live proposal at a time', async () => {
    await db.admin(
      `insert into public.stage_transitions
         (conversation_id, from_stage, to_stage, proposed_by_user_id)
       values ($1::uuid, 2, 3, $2::uuid)`,
      [conversationId, alice.userId],
    );

    await expect(
      db.admin(
        `insert into public.stage_transitions
           (conversation_id, from_stage, to_stage, proposed_by_user_id)
         values ($1::uuid, 2, 3, $2::uuid)`,
        [conversationId, bilal.userId],
      ),
    ).rejects.toThrow(/stage_transitions_one_pending|duplicate key/);
  });

  it('keeps the stage within 1 to 5', async () => {
    await expect(
      db.admin(
        `update public.conversation_stages set current_stage = 6 where conversation_id = $1::uuid`,
        [conversationId],
      ),
    ).rejects.toThrow(/conversation_stages_range/);
  });
});
