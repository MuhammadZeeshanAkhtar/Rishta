import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  applyMigrations,
  createTestDb,
  seedReference,
  seedUser,
  type SeededUser,
  type TestDb,
} from './harness';

/**
 * Code review remediation, Phase 2 — the database half (migration 0028).
 *
 * Written against the tables, not the routes, because each of these was
 * reachable without a route: a member inserting into `blocks` through the
 * Data API, or writing a message after the other person left.
 *
 *   B16  a closing thread cancels its pending stage proposal — on block,
 *        unmatch, family revocation and leave — and nothing else moves
 *   B24  app.has_interacted_with answers for the caller, about any interest
 *        or match in any state
 *   B25  once anyone has left, nobody can write
 */

let db: TestDb;

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** An accepted interest, its match, and the conversation the trigger opens. */
async function threadOf(
  on: TestDb,
  sender: SeededUser,
  recipient: SeededUser,
): Promise<{ matchId: string; conversationId: string }> {
  const interest = await on.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [sender.userId, recipient.userId],
  );
  const [a, b] = ordered(sender.userId, recipient.userId);
  const match = await on.admin<{ id: string; communication_state: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid) returning id, communication_state`,
    [a, b, interest[0]!.id],
  );
  expect(match[0]!.communication_state).toBe('open');
  const conversation = await on.admin<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [match[0]!.id],
  );
  return { matchId: match[0]!.id, conversationId: conversation[0]!.id };
}

async function propose(on: TestDb, conversationId: string, by: SeededUser): Promise<string> {
  const rows = await on.admin<{ id: string }>(
    `insert into public.stage_transitions (conversation_id, from_stage, to_stage, proposed_by_user_id)
     values ($1::uuid, 1, 2, $2::uuid) returning id`,
    [conversationId, by.userId],
  );
  return rows[0]!.id;
}

async function proposal(
  on: TestDb,
  id: string,
): Promise<{ status: string; responded_by_user_id: string | null; responded_at: string | null }> {
  const rows = await on.admin<{
    status: string;
    responded_by_user_id: string | null;
    responded_at: string | null;
  }>(
    `select status, responded_by_user_id, responded_at from public.stage_transitions
      where id = $1::uuid`,
    [id],
  );
  return rows[0]!;
}

const stageOf = async (conversationId: string): Promise<number> =>
  (
    await db.admin<{ current_stage: number }>(
      `select current_stage from public.conversation_stages where conversation_id = $1::uuid`,
      [conversationId],
    )
  )[0]!.current_stage;

const canWrite = async (who: SeededUser, conversationId: string): Promise<boolean> =>
  (
    await db.admin<{ ok: boolean }>(`select app.can_write_message($1::uuid, $2::uuid) as ok`, [
      who.userId,
      conversationId,
    ])
  )[0]!.ok;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

// =============================================================================
// B16
// =============================================================================

describe('B16 — `cancelled` is a legal, responder-less status', () => {
  let conversationId: string;
  let alice: SeededUser;
  let bilal: SeededUser;

  beforeAll(async () => {
    alice = await seedUser(db, { displayName: 'Ladder Alice', gender: 'female' });
    bilal = await seedUser(db, { displayName: 'Ladder Bilal', gender: 'male' });
    ({ conversationId } = await threadOf(db, bilal, alice));
  });

  it('accepts cancelled with a time and no responder', async () => {
    const id = await propose(db, conversationId, alice);
    await db.admin(
      `update public.stage_transitions set status = 'cancelled', responded_at = now()
        where id = $1::uuid`,
      [id],
    );
    expect((await proposal(db, id)).status).toBe('cancelled');
  });

  it('refuses cancelled WITH a responder: nobody made that decision', async () => {
    const id = await propose(db, conversationId, alice);
    await expect(
      db.admin(
        `update public.stage_transitions
            set status = 'cancelled', responded_at = now(), responded_by_user_id = $2::uuid
          where id = $1::uuid`,
        [id, bilal.userId],
      ),
    ).rejects.toThrow(/stage_transitions_responded_consistent/);
    await db.admin(
      `update public.stage_transitions set status = 'cancelled', responded_at = now()
        where id = $1::uuid`,
      [id],
    );
  });

  it('refuses cancelled with no time', async () => {
    const id = await propose(db, conversationId, alice);
    await expect(
      db.admin(`update public.stage_transitions set status = 'cancelled' where id = $1::uuid`, [
        id,
      ]),
    ).rejects.toThrow(/stage_transitions_responded_consistent/);
    await db.admin(
      `update public.stage_transitions set status = 'cancelled', responded_at = now()
        where id = $1::uuid`,
      [id],
    );
  });

  it('keeps accepted and declined exactly as strict as before', async () => {
    const id = await propose(db, conversationId, alice);
    await expect(
      db.admin(
        `update public.stage_transitions set status = 'accepted', responded_at = now()
          where id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/stage_transitions_responded_consistent/);
    await db.admin(
      `update public.stage_transitions set status = 'cancelled', responded_at = now()
        where id = $1::uuid`,
      [id],
    );
  });
});

describe('B16 — every way a thread closes cancels its pending proposal', () => {
  async function fresh(label: string) {
    const alice = await seedUser(db, { displayName: `${label} Alice`, gender: 'female' });
    const bilal = await seedUser(db, { displayName: `${label} Bilal`, gender: 'male' });
    const thread = await threadOf(db, bilal, alice);
    const proposalId = await propose(db, thread.conversationId, alice);
    return { alice, bilal, ...thread, proposalId };
  }

  async function expectCancelled(proposalId: string, conversationId: string): Promise<void> {
    const p = await proposal(db, proposalId);
    expect(p.status).toBe('cancelled');
    expect(p.responded_by_user_id).toBeNull();
    expect(p.responded_at).not.toBeNull();
    // The ladder never moved: cancelling is not accepting.
    expect(await stageOf(conversationId)).toBe(1);
  }

  it('a block made by a MEMBER through the Data API', async () => {
    // The path no route sees — which is why cancellation lives in a trigger.
    const t = await fresh('Block');
    await db.as(
      'authenticated',
      t.bilal.authUserId,
      `insert into public.blocks (blocker_user_id, blocked_user_id)
       values (app.current_user_id(), $1::uuid)`,
      [t.alice.userId],
    );
    // `as` rolls its transaction back, so repeat as admin to persist it.
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [t.bilal.userId, t.alice.userId],
    );
    await expectCancelled(t.proposalId, t.conversationId);
  });

  it('a block works from the member insert alone, inside that transaction', async () => {
    const t = await fresh('BlockTx');
    const seen = await db.as<{ status: string }>(
      'authenticated',
      t.bilal.authUserId,
      `with b as (
         insert into public.blocks (blocker_user_id, blocked_user_id)
         values (app.current_user_id(), $1::uuid) returning 1
       )
       select (select count(*) from b)::text as status`,
      [t.alice.userId],
    );
    expect(seen[0]!.status).toBe('1');
    // Rolled back with the block: nothing changed outside that transaction.
    expect((await proposal(db, t.proposalId)).status).toBe('pending');
  });

  it('an unmatch', async () => {
    const t = await fresh('Unmatch');
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = user_a_id where id = $1::uuid`,
      [t.matchId],
    );
    await expectCancelled(t.proposalId, t.conversationId);
  });

  it('a family revocation', async () => {
    const t = await fresh('Revoke');
    await db.admin(
      `update public.matches set communication_state = 'revoked', communication_state_at = now()
        where id = $1::uuid`,
      [t.matchId],
    );
    await expectCancelled(t.proposalId, t.conversationId);
  });

  it('a participant leaving', async () => {
    const t = await fresh('Leave');
    await db.admin(
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [t.conversationId, t.bilal.userId],
    );
    await expectCancelled(t.proposalId, t.conversationId);
  });

  it('leaves other conversations, and answered proposals, untouched', async () => {
    const t = await fresh('Scope');
    const other = await fresh('Bystander');
    // An answered proposal in the closing thread is history, not pending.
    await db.admin(
      `update public.stage_transitions
          set status = 'declined', responded_at = now(), responded_by_user_id = $2::uuid
        where id = $1::uuid`,
      [t.proposalId, t.bilal.userId],
    );
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = user_a_id where id = $1::uuid`,
      [t.matchId],
    );
    expect((await proposal(db, t.proposalId)).status).toBe('declined');
    expect((await proposal(db, other.proposalId)).status).toBe('pending');
  });

  it('a revived match does not revive the proposal, and a new one can be made', async () => {
    const t = await fresh('Revive');
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = user_a_id where id = $1::uuid`,
      [t.matchId],
    );
    await db.admin(
      `update public.matches set ended_at = null, ended_by_user_id = null where id = $1::uuid`,
      [t.matchId],
    );
    expect((await proposal(db, t.proposalId)).status).toBe('cancelled');
    // The one-pending index no longer holds the old row, so a fresh proposal fits.
    const again = await propose(db, t.conversationId, t.alice);
    expect((await proposal(db, again)).status).toBe('pending');
  });

  it('is not a member capability: app.cancel_pending_stage_proposals is service-role only', async () => {
    const t = await fresh('Direct');
    await expect(
      db.as(
        'authenticated',
        t.alice.authUserId,
        `select app.cancel_pending_stage_proposals($1::uuid)`,
        [t.conversationId],
      ),
    ).rejects.toThrow(/permission denied/i);
    expect((await proposal(db, t.proposalId)).status).toBe('pending');
  });
});

// =============================================================================
// B25
// =============================================================================

describe('B25 — once anyone has left, nobody writes', () => {
  let alice: SeededUser;
  let bilal: SeededUser;
  let conversationId: string;

  const trySend = async (who: SeededUser, body: string): Promise<boolean> => {
    try {
      await db.as(
        'authenticated',
        who.authUserId,
        `insert into public.messages (conversation_id, sender_user_id, body)
         values ($1::uuid, app.current_user_id(), $2)`,
        [conversationId, body],
      );
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    alice = await seedUser(db, { displayName: 'Leave Alice', gender: 'female' });
    bilal = await seedUser(db, { displayName: 'Leave Bilal', gender: 'male' });
    ({ conversationId } = await threadOf(db, bilal, alice));
  });

  it('lets both write while both are present', async () => {
    expect(await canWrite(alice, conversationId)).toBe(true);
    expect(await canWrite(bilal, conversationId)).toBe(true);
    expect(await trySend(bilal, 'Assalamu alaikum')).toBe(true);
  });

  it('refuses BOTH once one has left — through the Data API as well', async () => {
    await db.admin(
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, alice.userId],
    );
    expect(await canWrite(alice, conversationId)).toBe(false);
    expect(await canWrite(bilal, conversationId)).toBe(false);
    expect(await trySend(alice, 'After leaving')).toBe(false);
    expect(await trySend(bilal, 'Into an empty room')).toBe(false);
  });
});

// =============================================================================
// B24
// =============================================================================

describe('B24 — app.has_interacted_with, for the caller only', () => {
  let me: SeededUser;
  const ask = async (caller: SeededUser | null, target: SeededUser): Promise<boolean> =>
    (
      await db.as<{ ok: boolean }>(
        caller ? 'authenticated' : 'anon',
        caller?.authUserId ?? null,
        `select app.has_interacted_with($1::uuid) as ok`,
        [target.userId],
      )
    )[0]!.ok;

  beforeAll(async () => {
    me = await seedUser(db, { displayName: 'Blocker', gender: 'female' });
  });

  it.each(['pending', 'declined', 'withdrawn'])(
    'is true after an interest that is %s, in either direction',
    async (status) => {
      const them = await seedUser(db, { displayName: `Interest ${status}`, gender: 'male' });
      await db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
         values ($1::uuid, $2::uuid, $3, case when $3 in ('pending', 'withdrawn') then null else now() end)`,
        [them.userId, me.userId, status],
      );
      expect(await ask(me, them)).toBe(true);
    },
  );

  it('is true after a match that has since ended', async () => {
    const them = await seedUser(db, { displayName: 'Ended Match', gender: 'male' });
    const { matchId } = await threadOf(db, them, me);
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = user_a_id where id = $1::uuid`,
      [matchId],
    );
    expect(await ask(me, them)).toBe(true);
  });

  it('is true even when the target is suspended — the point of B24', async () => {
    const them = await seedUser(db, { displayName: 'Suspended', gender: 'male' });
    await threadOf(db, them, me);
    await db.admin(`update public.users set status = 'suspended' where id = $1::uuid`, [
      them.userId,
    ]);
    expect(await ask(me, them)).toBe(true);
  });

  it('is false for a stranger, for oneself, and for a caller with no account', async () => {
    const stranger = await seedUser(db, { displayName: 'Stranger', gender: 'male' });
    expect(await ask(me, stranger)).toBe(false);
    expect(await ask(me, me)).toBe(false);
    await expect(ask(null, stranger)).rejects.toThrow(/permission denied/i);
  });

  it('describes only the CALLER: a third party learns nothing about two others', async () => {
    const a = await seedUser(db, { displayName: 'Third A', gender: 'female' });
    const b = await seedUser(db, { displayName: 'Third B', gender: 'male' });
    const outsider = await seedUser(db, { displayName: 'Outsider', gender: 'female' });
    await threadOf(db, b, a);
    // The outsider can only ask about their own relationship with b.
    expect(await ask(outsider, b)).toBe(false);
    expect(await ask(a, b)).toBe(true);
  });
});

// =============================================================================
// 0028 applied on top of data that already exists
// =============================================================================

describe('0028 cancels proposals already stranded before it existed', () => {
  it('cancels pending proposals in closed threads, and only those', async () => {
    // A database exactly as it stood at 0027, with real rows in it.
    const pg = new PGlite();
    await applyMigrations(pg, { through: '20261101000027' });
    const before: TestDb = {
      admin: async <T>(sql: string, params: unknown[] = []) =>
        (await pg.query<T>(sql, params as never[])).rows,
      as: () => Promise.reject(new Error('not used')),
      close: () => pg.close(),
    };
    try {
      await seedReference(before);
      const a = await seedUser(before, { displayName: 'Old A', gender: 'female' });
      const b = await seedUser(before, { displayName: 'Old B', gender: 'male' });
      const c = await seedUser(before, { displayName: 'Old C', gender: 'female' });
      const closed = await threadOf(before, b, a);
      const open = await threadOf(before, b, c);
      const stranded = await propose(before, closed.conversationId, a);
      const live = await propose(before, open.conversationId, c);
      // Closed BEFORE the triggers exist: nothing cancels it at this point.
      await before.admin(
        `update public.matches set ended_at = now(), ended_by_user_id = user_a_id where id = $1::uuid`,
        [closed.matchId],
      );
      expect((await proposal(before, stranded)).status).toBe('pending');

      const file = (await readdir(MIGRATIONS_DIR)).find((f) => f.startsWith('20261101000028'));
      await pg.exec(await readFile(join(MIGRATIONS_DIR, file!), 'utf8'));

      expect((await proposal(before, stranded)).status).toBe('cancelled');
      expect((await proposal(before, live)).status).toBe('pending');
    } finally {
      await before.close();
    }
  }, 180_000);
});
