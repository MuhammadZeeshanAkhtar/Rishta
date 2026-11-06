import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAMILY_JOIN_PATH,
  familyInviteQueryParams,
  parseFamilyInviteLink,
} from '@nikahmate/domain';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Code review remediation, Phase 2 — through the real routes.
 *
 *   B2   a family invitation can be accepted from its link, and the whole
 *        invite -> accept -> review -> decide flow works end to end
 *   B16  a stage proposal cannot be accepted once the thread has closed, by
 *        block, unmatch, family revocation or leaving
 *   B24  a member can block anyone they have an interest or match with, even
 *        when that person can no longer be viewed
 *   B25  leaving closes the conversation for both, and the leaver is not
 *        notified about it
 *   L9   an interest note cannot carry contact details
 *
 * The database half (migration 0028) is in packages/db review-phase2-rls.test.ts.
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
    [`Phase2 ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(
    `insert into public.verification_status (user_id, email_verified_at)
     values ($1::uuid, now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  auth: string,
  payload?: Record<string, unknown>,
) =>
  harness.app.inject({
    method,
    url,
    headers: authHeader(auth),
    ...(payload ? { payload } : {}),
  });

async function sendInterest(from: Member, to: Member): Promise<string> {
  const response = await call('POST', '/interests', from.authId, { recipientUserId: to.userId });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function accept(member: Member, interestId: string): Promise<string> {
  const response = await call('POST', `/interests/${interestId}/respond`, member.authId, {
    decision: 'accept',
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { match: { id: string } }).match.id;
}

async function conversationOf(matchId: string): Promise<string> {
  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [matchId],
  );
  return rows.rows[0]!.id;
}

/** An open thread between two fresh members. */
async function thread(): Promise<{
  alice: Member;
  bilal: Member;
  matchId: string;
  conversationId: string;
}> {
  const alice = await seedMember('female');
  const bilal = await seedMember('male');
  const matchId = await accept(alice, await sendInterest(bilal, alice));
  return { alice, bilal, matchId, conversationId: await conversationOf(matchId) };
}

/** Owner invites delegate and the delegate accepts FROM THE LINK, as the app does. */
async function linkDelegate(owner: Member, delegate: Member): Promise<void> {
  seq += 1;
  const created = await call('POST', '/family/invitations', owner.authId, {
    inviteeContact: `phase2-${seq}@example.com`,
    relationshipCode: 'father',
    tier: 'reviewer',
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id, token } = created.json() as { id: string; token: string };
  const query = familyInviteQueryParams({ invitationId: id, token });
  const ref = parseFamilyInviteLink(`nikahmate://${FAMILY_JOIN_PATH}?i=${query.i}&t=${query.t}`);
  expect(ref).not.toBeNull();
  const accepted = await call(
    'POST',
    `/family/invitations/${ref!.invitationId}/respond`,
    delegate.authId,
    {
      token: ref!.token,
      accept: true,
    },
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
}

const proposalStatuses = async (conversationId: string): Promise<string[]> =>
  (
    await harness.raw.query<{ status: string }>(
      `select status from public.stage_transitions where conversation_id = $1::uuid
        order by created_at`,
      [conversationId],
    )
  ).rows.map((r) => r.status);

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// =============================================================================
// B2
// =============================================================================

describe('B2 — a family invitation is accepted from its link', () => {
  it('runs invite -> accept from the link -> review -> decide, end to end', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');

    await linkDelegate(owner, delegate);
    const policy = await call('PATCH', '/me', owner.authId, {
      communicationPolicy: 'family_reviewed',
    });
    expect(policy.statusCode, policy.body).toBe(200);

    const matchId = await accept(owner, await sendInterest(suitor, owner));
    const state = await harness.raw.query<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(state.rows[0]!.communication_state).toBe('pending_family_review');

    const inbox = (await call('GET', '/family/reviews', delegate.authId)).json() as {
      items: { matchId: string }[];
    };
    expect(inbox.items.map((i) => i.matchId)).toContain(matchId);

    const decided = await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'approve',
    });
    expect(decided.statusCode, decided.body).toBe(200);

    // The point of the whole flow: the family's approval opens the thread.
    const conversationId = await conversationOf(matchId);
    const sent = await call('POST', `/conversations/${conversationId}/messages`, suitor.authId, {
      body: 'Assalamu alaikum.',
    });
    expect(sent.statusCode, sent.body).toBe(201);
  });

  it('cannot be accepted twice from the same link', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const created = await call('POST', '/family/invitations', owner.authId, {
      inviteeContact: 'twice@example.com',
      relationshipCode: 'mother',
      tier: 'observer',
    });
    const { id, token } = created.json() as { id: string; token: string };
    const ref = parseFamilyInviteLink(`https://app.example.org/family/join?i=${id}&t=${token}`)!;
    const first = await call(
      'POST',
      `/family/invitations/${ref.invitationId}/respond`,
      delegate.authId,
      {
        token: ref.token,
        accept: true,
      },
    );
    expect(first.statusCode).toBe(200);
    const again = await call(
      'POST',
      `/family/invitations/${ref.invitationId}/respond`,
      delegate.authId,
      {
        token: ref.token,
        accept: true,
      },
    );
    expect(again.statusCode).toBe(404);
  });

  it('can be declined from the link, after which it cannot be accepted', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const created = await call('POST', '/family/invitations', owner.authId, {
      inviteeContact: 'decline@example.com',
      relationshipCode: 'brother',
      tier: 'observer',
    });
    const { id, token } = created.json() as { id: string; token: string };
    const ref = parseFamilyInviteLink(`nikahmate://family/join?t=${token}&i=${id}`)!;
    const declined = await call(
      'POST',
      `/family/invitations/${ref.invitationId}/respond`,
      delegate.authId,
      {
        token: ref.token,
        accept: false,
      },
    );
    expect(declined.json()).toEqual({ status: 'declined' });
    const late = await call(
      'POST',
      `/family/invitations/${ref.invitationId}/respond`,
      delegate.authId,
      {
        token: ref.token,
        accept: true,
      },
    );
    expect(late.statusCode).toBe(404);
  });
});

// =============================================================================
// B16
// =============================================================================

describe('B16 — a stage proposal cannot be accepted after the thread closes', () => {
  async function proposed() {
    const t = await thread();
    const proposal = await call(
      'POST',
      `/conversations/${t.conversationId}/stage/propose`,
      t.bilal.authId,
    );
    expect(proposal.statusCode, proposal.body).toBe(201);
    return t;
  }

  async function expectRefusedAndCancelled(t: { alice: Member; conversationId: string }) {
    const respond = await call(
      'POST',
      `/conversations/${t.conversationId}/stage/respond`,
      t.alice.authId,
      {
        accept: true,
      },
    );
    expect(respond.statusCode, respond.body).toBe(409);
    expect(await proposalStatuses(t.conversationId)).toEqual(['cancelled']);
    const stage = await harness.raw.query<{ current_stage: number }>(
      `select current_stage from public.conversation_stages where conversation_id = $1::uuid`,
      [t.conversationId],
    );
    expect(stage.rows[0]!.current_stage).toBe(1);
  }

  it('still lets an open thread accept a proposal', async () => {
    const t = await proposed();
    const respond = await call(
      'POST',
      `/conversations/${t.conversationId}/stage/respond`,
      t.alice.authId,
      {
        accept: true,
      },
    );
    expect(respond.statusCode, respond.body).toBe(200);
    expect(respond.json()).toMatchObject({ currentStage: 2 });
  });

  it('after a block', async () => {
    const t = await proposed();
    expect((await call('PUT', `/blocks/${t.alice.userId}`, t.bilal.authId, {})).statusCode).toBe(
      204,
    );
    await expectRefusedAndCancelled(t);
  });

  it('after an unmatch', async () => {
    const t = await proposed();
    const ended = await call('POST', `/matches/${t.matchId}/unmatch`, t.bilal.authId, {});
    expect(ended.statusCode, ended.body).toBeLessThan(300);
    await expectRefusedAndCancelled(t);
  });

  it('after a family revocation', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await linkDelegate(owner, delegate);
    await call('PATCH', '/me', owner.authId, { communicationPolicy: 'family_reviewed' });
    const matchId = await accept(owner, await sendInterest(suitor, owner));
    await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, { action: 'approve' });
    const conversationId = await conversationOf(matchId);
    expect(
      (await call('POST', `/conversations/${conversationId}/stage/propose`, suitor.authId))
        .statusCode,
    ).toBe(201);

    const revoked = await call('POST', `/family/reviews/${matchId}/revoke`, delegate.authId, {});
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);
    await expectRefusedAndCancelled({ alice: owner, conversationId });
  });

  it('after the proposer leaves', async () => {
    const t = await proposed();
    expect(
      (await call('POST', `/conversations/${t.conversationId}/leave`, t.bilal.authId)).statusCode,
    ).toBe(204);
    await expectRefusedAndCancelled(t);
  });

  it('no longer reports a pending proposal on the closed thread', async () => {
    const t = await proposed();
    await call('PUT', `/blocks/${t.alice.userId}`, t.bilal.authId, {});
    const stage = await call('GET', `/conversations/${t.conversationId}/stage`, t.alice.authId);
    if (stage.statusCode === 200) {
      expect(stage.json()).toMatchObject({ pendingProposal: null });
    } else {
      // A blocked thread may not be readable at all; either way, nothing pending.
      expect(stage.statusCode).toBe(404);
    }
  });
});

// =============================================================================
// B24
// =============================================================================

describe('B24 — blocking someone you know, even when you cannot see them', () => {
  const blockRow = async (blocker: Member, blocked: Member): Promise<boolean> =>
    (
      await harness.raw.query<{ ok: boolean }>(
        `select exists (select 1 from public.blocks
          where blocker_user_id = $1::uuid and blocked_user_id = $2::uuid) as ok`,
        [blocker.userId, blocked.userId],
      )
    ).rows[0]!.ok;

  it('a match whose counterpart has since been suspended', async () => {
    const t = await thread();
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      t.bilal.userId,
    ]);
    const blocked = await call('PUT', `/blocks/${t.bilal.userId}`, t.alice.authId, {});
    expect(blocked.statusCode, blocked.body).toBe(204);
    expect(await blockRow(t.alice, t.bilal)).toBe(true);
  });

  it('from inside the conversation: the thread then reports the block', async () => {
    const t = await thread();
    await harness.raw.query(
      `update public.profiles set review_status = 'pending' where user_id = $1::uuid`,
      [t.bilal.userId],
    );
    expect((await call('PUT', `/blocks/${t.bilal.userId}`, t.alice.authId, {})).statusCode).toBe(
      204,
    );
    const detail = await call('GET', `/conversations/${t.conversationId}`, t.alice.authId);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ writeBlockedReason: 'blocked', canWrite: false });
  });

  it('a declined interest whose sender is no longer approved', async () => {
    const me = await seedMember('female');
    const them = await seedMember('male');
    const interestId = await sendInterest(them, me);
    await call('POST', `/interests/${interestId}/respond`, me.authId, { decision: 'decline' });
    await harness.raw.query(
      `update public.profiles set review_status = 'pending' where user_id = $1::uuid`,
      [them.userId],
    );
    expect((await call('PUT', `/blocks/${them.userId}`, me.authId, {})).statusCode).toBe(204);
  });

  it('still answers 404 for a hidden stranger, so it reveals nothing', async () => {
    const me = await seedMember('female');
    const stranger = await seedMember('male');
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      stranger.userId,
    ]);
    expect((await call('PUT', `/blocks/${stranger.userId}`, me.authId, {})).statusCode).toBe(404);
    expect(await blockRow(me, stranger)).toBe(false);
  });

  it('still lets a member block a visible stranger, as before', async () => {
    const me = await seedMember('female');
    const stranger = await seedMember('male');
    expect((await call('PUT', `/blocks/${stranger.userId}`, me.authId, {})).statusCode).toBe(204);
  });
});

// =============================================================================
// B25
// =============================================================================

describe('B25 — leaving closes the conversation for both', () => {
  const newMessageNotifications = async (member: Member): Promise<number> =>
    Number(
      (
        await harness.raw.query<{ n: string }>(
          `select count(*)::text as n from public.notifications
            where user_id = $1::uuid and type = 'new_message'`,
          [member.userId],
        )
      ).rows[0]!.n,
    );

  it('tells the one left behind, and refuses their messages', async () => {
    const t = await thread();
    expect(
      (await call('POST', `/conversations/${t.conversationId}/leave`, t.alice.authId)).statusCode,
    ).toBe(204);

    const theirs = await call('GET', `/conversations/${t.conversationId}`, t.bilal.authId);
    expect(theirs.json()).toMatchObject({
      writeBlockedReason: 'counterpart_left',
      canWrite: false,
    });
    const send = await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, {
      body: 'Are you still there?',
    });
    expect(send.statusCode).toBe(409);

    // The leaver no longer has the thread at all (unchanged behaviour: a
    // participant who left is filtered out of every thread read).
    const mine = await call('GET', `/conversations/${t.conversationId}`, t.alice.authId);
    expect(mine.statusCode).toBe(404);
  });

  it('shows the same reason in the conversation list', async () => {
    const t = await thread();
    await call('POST', `/conversations/${t.conversationId}/leave`, t.alice.authId);
    const list = (await call('GET', '/conversations', t.bilal.authId)).json() as {
      items: { id: string; writeBlockedReason: string | null }[];
    };
    expect(list.items.find((i) => i.id === t.conversationId)?.writeBlockedReason).toBe(
      'counterpart_left',
    );
  });

  it('raises no notification for the person who left', async () => {
    const t = await thread();
    const sent = await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, {
      body: 'Before leaving',
    });
    expect(sent.statusCode).toBe(201);
    const before = await newMessageNotifications(t.alice);
    expect(before).toBe(1);

    await call('POST', `/conversations/${t.conversationId}/leave`, t.alice.authId);
    await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, {
      body: 'After leaving',
    });
    await call('POST', `/conversations/${t.conversationId}/stage/propose`, t.bilal.authId);
    expect(await newMessageNotifications(t.alice)).toBe(before);
  });

  it('cannot be undone in this phase: there is no rejoin', async () => {
    const t = await thread();
    await call('POST', `/conversations/${t.conversationId}/leave`, t.alice.authId);
    // The thread is gone for the leaver, so neither leaving again nor writing
    // can reach it — and the one left behind stays refused.
    expect(
      (await call('POST', `/conversations/${t.conversationId}/leave`, t.alice.authId)).statusCode,
    ).toBe(404);
    const back = await call('POST', `/conversations/${t.conversationId}/messages`, t.alice.authId, {
      body: 'Back again',
    });
    expect(back.statusCode).toBe(404);
    const stillThere = await call(
      'POST',
      `/conversations/${t.conversationId}/messages`,
      t.bilal.authId,
      {
        body: 'Hello?',
      },
    );
    expect(stillThere.statusCode).toBe(409);
  });
});

// =============================================================================
// L9
// =============================================================================

describe('L9 — an interest note cannot carry contact details', () => {
  const sendWithNote = (from: Member, to: Member, note: string) =>
    call('POST', '/interests', from.authId, { recipientUserId: to.userId, note });

  it('accepts an ordinary note and stores it', async () => {
    const from = await seedMember('male');
    const to = await seedMember('female');
    const note = 'Assalamu alaikum. I completed my M.Com in 2019 and liked your values.';
    const sent = await sendWithNote(from, to, note);
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ note });
  });

  it.each([
    ['a phone number', 'Call me on 0300-1234567'],
    ['an email', 'Write to ali (at) gmail (dot) com'],
    ['a link', 'See www.alikhan.pk'],
    ['a handle', 'I am @ali_khan92'],
    ['a platform', 'Message me on WhatsApp please'],
    ['Urdu digits', 'نمبر ۰۳۰۰۱۲۳۴۵۶۷'],
  ])('refuses %s, writes nothing, and spends no quota', async (_label, note) => {
    const from = await seedMember('male');
    const to = await seedMember('female');
    const refused = await sendWithNote(from, to, note);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      code: 'validation_failed',
      fields: { note: 'contact_details_not_allowed' },
    });
    // The note is never echoed back.
    expect(refused.body).not.toContain(note);

    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.interests where sender_user_id = $1::uuid`,
      [from.userId],
    );
    expect(rows.rows[0]!.n).toBe('0');
    const quota = await harness.raw.query<{ n: string }>(
      `select coalesce(sum(count), 0)::text as n from public.usage_counters where user_id = $1::uuid`,
      [from.userId],
    );
    expect(quota.rows[0]!.n).toBe('0');

    // And rephrasing works.
    expect(
      (await sendWithNote(from, to, 'Assalamu alaikum, I liked your profile.')).statusCode,
    ).toBe(201);
  });
});
