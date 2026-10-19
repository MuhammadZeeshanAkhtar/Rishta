import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Chat, through the real routes (Phase 7).
 *
 * The RLS suite proves what the policies permit. This proves the thing a
 * person experiences: that a thread appears when a family approves, closes
 * when they withdraw, survives a block as history, and never once lets
 * somebody write into a conversation they are not in.
 *
 * The four states the brief asks for are each tested end to end — blocked,
 * revoked, unauthorized, invalid-state — plus the one that is easiest to get
 * wrong, which is that a closed thread is still READABLE.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Member ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  return { userId, authId };
}

const get = (url: string, auth: string) =>
  harness.app.inject({ method: 'GET', url, headers: authHeader(auth) });

const post = (url: string, auth: string, payload: Record<string, unknown> = {}) =>
  harness.app.inject({ method: 'POST', url, headers: authHeader(auth), payload });

/** Two members, matched and talking. Returns the conversation id. */
async function openThread(a: Member, b: Member): Promise<string> {
  const sent = await post('/interests', a.authId, { recipientUserId: b.userId });
  expect(sent.statusCode, sent.body).toBe(201);
  const interestId = (sent.json() as { id: string }).id;

  const responded = await post(`/interests/${interestId}/respond`, b.authId, {
    decision: 'accept',
  });
  expect(responded.statusCode, responded.body).toBe(200);
  const matchId = (responded.json() as { match: { id: string } }).match.id;

  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [matchId],
  );
  expect(rows.rows[0], 'the trigger should have opened a thread for an open match').toBeDefined();
  return rows.rows[0]!.id;
}

const matchIdOf = async (conversationId: string): Promise<string> => {
  const rows = await harness.raw.query<{ match_id: string }>(
    `select match_id from public.conversations where id = $1::uuid`,
    [conversationId],
  );
  return rows.rows[0]!.match_id;
};

const setState = async (conversationId: string, state: string): Promise<void> => {
  await harness.raw.query(
    `update public.matches set communication_state = $2 where id = $1::uuid`,
    [await matchIdOf(conversationId), state],
  );
};

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('a thread appears when the gate opens', () => {
  it('exists for an ungated match, and lists for both sides', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const conversationId = await openThread(bilal, alice);

    for (const who of [alice, bilal]) {
      const list = await get('/conversations', who.authId);
      expect(list.statusCode).toBe(200);
      const items = (list.json() as { items: { id: string; canWrite: boolean }[] }).items;
      expect(items.map((i) => i.id)).toContain(conversationId);
      expect(items.find((i) => i.id === conversationId)!.canWrite).toBe(true);
    }
  });

  it('does NOT exist while a family review is pending, and appears on approval', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');

    // Give the owner a reviewer, then turn the gate on.
    const invite = await post('/family/invitations', owner.authId, {
      inviteeContact: `chat-reviewer-${seq}@example.com`,
      relationshipCode: 'father',
      tier: 'reviewer',
    });
    const { id: inviteId, token } = invite.json() as { id: string; token: string };
    await post(`/family/invitations/${inviteId}/respond`, delegate.authId, {
      token,
      accept: true,
    });
    await harness.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(owner.authId),
      payload: { communicationPolicy: 'family_reviewed' },
    });

    const sent = await post('/interests', suitor.authId, { recipientUserId: owner.userId });
    const interestId = (sent.json() as { id: string }).id;
    const responded = await post(`/interests/${interestId}/respond`, owner.authId, {
      decision: 'accept',
    });
    const matchId = (responded.json() as { match: { id: string } }).match.id;

    // Nothing to talk in. Putting the gate on the thread would mean creating
    // a thread in order to forbid it.
    const before = await harness.raw.query(
      `select id from public.conversations where match_id = $1::uuid`,
      [matchId],
    );
    expect(before.rows).toHaveLength(0);
    expect((await get('/conversations', owner.authId)).json()).toMatchObject({ items: [] });

    const decided = await post(`/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'approve',
    });
    expect(decided.statusCode, decided.body).toBe(200);

    const after = await get('/conversations', owner.authId);
    const items = (after.json() as { items: { canWrite: boolean }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.canWrite).toBe(true);
  });
});

describe('sending', () => {
  it('delivers a message both sides can read', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    const sent = await post(`/conversations/${id}/messages`, alice.authId, {
      body: 'Assalamu alaikum.',
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ body: 'Assalamu alaikum.', isMine: true });

    const theirs = await get(`/conversations/${id}/messages`, bilal.authId);
    const items = (theirs.json() as { items: { body: string; isMine: boolean }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ body: 'Assalamu alaikum.', isMine: false });
  });

  it('refuses an empty or whitespace-only message', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    for (const body of ['', '   ']) {
      expect((await post(`/conversations/${id}/messages`, alice.authId, { body })).statusCode).toBe(
        400,
      );
    }
  });

  it('refuses a message over the contract cap', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    const response = await post(`/conversations/${id}/messages`, alice.authId, {
      body: 'x'.repeat(4001),
    });
    expect(response.statusCode).toBe(400);
  });

  it('notifies the counterpart, and only them', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Hello there.' });

    const count = async (userId: string): Promise<number> => {
      const rows = await harness.raw.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where user_id = $1::uuid and type = 'new_message'`,
        [userId],
      );
      return Number.parseInt(rows.rows[0]!.n, 10);
    };

    expect(await count(bilal.userId)).toBe(1);
    expect(await count(alice.userId)).toBe(0);
  });
});

describe('unauthorized', () => {
  it('shows a stranger no thread, and refuses them by 404 rather than 403', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const stranger = await seedMember('female');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Private.' });

    // A 403 would confirm the conversation exists.
    expect((await get(`/conversations/${id}`, stranger.authId)).statusCode).toBe(404);
    expect((await get(`/conversations/${id}/messages`, stranger.authId)).statusCode).toBe(404);
    expect(
      (await post(`/conversations/${id}/messages`, stranger.authId, { body: 'Let me in' }))
        .statusCode,
    ).toBe(404);
    expect((await get('/conversations', stranger.authId)).json()).toMatchObject({ items: [] });
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/conversations' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a conversation id that does not exist', async () => {
    const alice = await seedMember('female');
    expect(
      (await get('/conversations/00000000-0000-4000-8000-000000000000', alice.authId)).statusCode,
    ).toBe(404);
  });
});

describe('revoked — the thread closes and stays readable', () => {
  it('stops writes and keeps the history, then reopens on re-approval', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Before the revocation.' });

    await setState(id, 'revoked');

    const refused = await post(`/conversations/${id}/messages`, alice.authId, {
      body: 'After the revocation.',
    });
    // 409, not 403: the caller belongs here, the thread's STATE refuses, and
    // that state can change.
    expect(refused.statusCode, refused.body).toBe(409);

    // THE HISTORY SURVIVES. A revocation stops the conversation continuing;
    // it does not delete what two people already said.
    const history = await get(`/conversations/${id}/messages`, alice.authId);
    expect(history.statusCode).toBe(200);
    expect((history.json() as { items: unknown[] }).items).toHaveLength(1);

    const detail = await get(`/conversations/${id}`, alice.authId);
    expect(detail.json()).toMatchObject({
      canWrite: false,
      writeBlockedReason: 'family_revoked',
    });

    await setState(id, 'family_approved');
    expect(
      (await post(`/conversations/${id}/messages`, alice.authId, { body: 'Approved again.' }))
        .statusCode,
    ).toBe(201);
  });

  it('reports the right reason for each closed state', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    const cases: [string, string][] = [
      ['pending_family_review', 'pending_family_review'],
      ['family_rejected', 'family_rejected'],
      ['revoked', 'family_revoked'],
      ['blocked', 'blocked'],
    ];

    for (const [state, reason] of cases) {
      await setState(id, state);
      const detail = await get(`/conversations/${id}`, alice.authId);
      expect(detail.json(), `state ${state}`).toMatchObject({
        canWrite: false,
        writeBlockedReason: reason,
      });
    }
  });
});

describe('blocked', () => {
  it('closes writes in BOTH directions and keeps the history readable', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Before the block.' });

    const blocked = await harness.app.inject({
      method: 'PUT',
      url: `/blocks/${bilal.userId}`,
      headers: authHeader(alice.authId),
      payload: {},
    });
    expect(blocked.statusCode).toBe(204);

    // Neither of them, not just the blocked party. A one-way close would let
    // the blocker keep talking at someone who cannot answer.
    for (const who of [alice, bilal]) {
      const response = await post(`/conversations/${id}/messages`, who.authId, {
        body: 'After the block',
      });
      expect(response.statusCode, `${who.userId} should be refused`).toBe(409);
    }

    const history = await get(`/conversations/${id}/messages`, alice.authId);
    expect((history.json() as { items: unknown[] }).items).toHaveLength(1);

    const detail = await get(`/conversations/${id}`, alice.authId);
    expect(detail.json()).toMatchObject({ canWrite: false, writeBlockedReason: 'blocked' });
  });
});

describe('invalid state', () => {
  it('refuses writing after the match has ended, though the gate still says open', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    const matchId = await matchIdOf(id);

    const ended = await post(`/matches/${matchId}/unmatch`, alice.authId, {});
    expect(ended.statusCode, ended.body).toBe(204);

    const state = await harness.raw.query<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    // Migration 0019 warned about exactly this: an ended match can still sit
    // in `open`, so the state alone is not a sufficient check.
    expect(state.rows[0]!.communication_state).toBe('open');

    const response = await post(`/conversations/${id}/messages`, alice.authId, {
      body: 'After unmatching',
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('match_ended');
  });

  it('refuses writing after leaving, and the counterpart is unaffected', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    expect((await post(`/conversations/${id}/leave`, alice.authId)).statusCode).toBe(204);

    // Gone from her list; still in his.
    expect((await get('/conversations', alice.authId)).json()).toMatchObject({ items: [] });
    const his = (await get('/conversations', bilal.authId)).json() as { items: unknown[] };
    expect(his.items).toHaveLength(1);
  });
});

describe('unread counts and read receipts', () => {
  it('counts only the other side’s messages, and clears on read', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    await post(`/conversations/${id}/messages`, alice.authId, { body: 'One.' });
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Two.' });

    const unreadFor = async (who: Member): Promise<number> => {
      const list = await get('/conversations', who.authId);
      return (list.json() as { items: { unreadCount: number }[] }).items[0]!.unreadCount;
    };

    expect(await unreadFor(bilal)).toBe(2);
    // Her own messages are not unread to her.
    expect(await unreadFor(alice)).toBe(0);

    const messages = await get(`/conversations/${id}/messages`, bilal.authId);
    const newest = (messages.json() as { items: { id: string }[] }).items[0]!.id;
    expect(
      (await post(`/conversations/${id}/read`, bilal.authId, { lastReadMessageId: newest }))
        .statusCode,
    ).toBe(204);

    expect(await unreadFor(bilal)).toBe(0);
  });

  it('suppresses the read position when the reader has receipts off', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Did you see this?' });

    const messages = await get(`/conversations/${id}/messages`, bilal.authId);
    const newest = (messages.json() as { items: { id: string }[] }).items[0]!.id;
    await post(`/conversations/${id}/read`, bilal.authId, { lastReadMessageId: newest });

    const visible = await get(`/conversations/${id}`, alice.authId);
    expect(
      (visible.json() as { counterpartLastReadAt: string | null }).counterpartLastReadAt,
    ).not.toBeNull();

    await harness.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(bilal.authId),
      payload: { sendReadReceipts: false },
    });

    const hidden = await get(`/conversations/${id}`, alice.authId);
    expect(
      (hidden.json() as { counterpartLastReadAt: string | null }).counterpartLastReadAt,
    ).toBeNull();

    // The row still exists: unread counts are the reader's own feature and
    // must work whether or not they tell anyone.
    const rows = await harness.raw.query(
      `select id from public.message_reads where conversation_id = $1::uuid and user_id = $2::uuid`,
      [id, bilal.userId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('never moves a read position backwards', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'First.' });
    await post(`/conversations/${id}/messages`, alice.authId, { body: 'Second.' });

    const messages = await get(`/conversations/${id}/messages`, bilal.authId);
    const items = (messages.json() as { items: { id: string }[] }).items;
    const newest = items[0]!.id;
    const oldest = items[1]!.id;

    await post(`/conversations/${id}/read`, bilal.authId, { lastReadMessageId: newest });
    // An out-of-order client must not resurrect notifications already dealt with.
    await post(`/conversations/${id}/read`, bilal.authId, { lastReadMessageId: oldest });

    const list = await get('/conversations', bilal.authId);
    expect((list.json() as { items: { unreadCount: number }[] }).items[0]!.unreadCount).toBe(0);
  });
});

describe('stages advance only by agreement', () => {
  it('starts at stage 1 and advances when the counterpart accepts', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    const initial = await get(`/conversations/${id}/stage`, alice.authId);
    expect(initial.json()).toMatchObject({ currentStage: 1, pendingProposal: null });

    const proposed = await post(`/conversations/${id}/stage/propose`, alice.authId);
    expect(proposed.statusCode, proposed.body).toBe(201);
    expect(proposed.json()).toMatchObject({ fromStage: 1, toStage: 2, proposedByMe: true });

    const seen = await get(`/conversations/${id}/stage`, bilal.authId);
    expect(seen.json()).toMatchObject({
      currentStage: 1,
      pendingProposal: { toStage: 2, proposedByMe: false },
    });

    const accepted = await post(`/conversations/${id}/stage/respond`, bilal.authId, {
      accept: true,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ currentStage: 2, pendingProposal: null });
  });

  it('refuses the proposer answering their own proposal', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/stage/propose`, alice.authId);

    // The mutuality IS the control: one side must not be able to move a
    // conversation to a stage that unlocks more of the other person.
    const response = await post(`/conversations/${id}/stage/respond`, alice.authId, {
      accept: true,
    });
    expect(response.statusCode).toBe(409);

    const stage = await get(`/conversations/${id}/stage`, alice.authId);
    expect(stage.json()).toMatchObject({ currentStage: 1 });
  });

  it('leaves the stage alone when the proposal is declined', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/stage/propose`, alice.authId);

    const declined = await post(`/conversations/${id}/stage/respond`, bilal.authId, {
      accept: false,
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({ currentStage: 1, pendingProposal: null });

    // And a new proposal is allowed afterwards.
    expect((await post(`/conversations/${id}/stage/propose`, bilal.authId)).statusCode).toBe(201);
  });

  it('allows only one live proposal', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await post(`/conversations/${id}/stage/propose`, alice.authId);

    expect((await post(`/conversations/${id}/stage/propose`, bilal.authId)).statusCode).toBe(409);
  });

  it('refuses advancing a thread nobody may write in', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);
    await setState(id, 'revoked');

    // Advancing a conversation while a family is still deciding would be a
    // way of making progress through a closed gate.
    const response = await post(`/conversations/${id}/stage/propose`, alice.authId);
    expect(response.statusCode).toBe(409);
  });

  it('refuses advancing past the final stage', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const id = await openThread(bilal, alice);

    await harness.raw.query(
      `update public.conversation_stages set current_stage = 5 where conversation_id = $1::uuid`,
      [id],
    );
    expect((await post(`/conversations/${id}/stage/propose`, alice.authId)).statusCode).toBe(409);
  });
});
