import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * The Family Safety gate, through the real interest and match routes.
 *
 * The companion DB suite proves the trigger. This one proves the thing that
 * actually matters: that the routes people reach cannot get around it. The
 * bypass being closed was a line of SQL in a route, so a test that only ever
 * calls the database directly would have missed it.
 *
 * NOT PHASE 6b. No delegate approves anything here. `communication_policy` is
 * set with raw SQL because no write path exists for it yet — deliberately, so
 * that nobody can choose a gate no delegate can open. What is under test is
 * the provenance of a match: the state it is born in, and the state it is
 * REBORN in after the pair end it and come back.
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
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const send = (sender: Member, recipientUserId: string, note?: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/interests',
    headers: authHeader(sender.authId),
    payload: note === undefined ? { recipientUserId } : { recipientUserId, note },
  });

const respond = (member: Member, interestId: string, decision: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/interests/${interestId}/respond`,
    headers: authHeader(member.authId),
    payload: { decision },
  });

const unmatch = (member: Member, matchId: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/matches/${matchId}/unmatch`,
    headers: authHeader(member.authId),
    payload: {},
  });

const get = (url: string, auth?: string) =>
  harness.app.inject({ method: 'GET', url, ...(auth ? { headers: authHeader(auth) } : {}) });

async function setPolicy(userId: string, policy: string): Promise<void> {
  await harness.raw.query(
    `update public.user_settings set communication_policy = $2::text where user_id = $1::uuid`,
    [userId, policy],
  );
}

async function stateOf(matchId: string): Promise<string> {
  const rows = await harness.raw.query<{ communication_state: string }>(
    `select communication_state from public.matches where id = $1::uuid`,
    [matchId],
  );
  return rows.rows[0]!.communication_state;
}

/** Accepts through the real route and returns what the route reported. */
async function match(sender: Member, recipient: Member) {
  const interestId = (await send(sender, recipient.userId)).json().id as string;
  const body = (await respond(recipient, interestId, 'accept')).json();
  return { interestId, match: body.match as { id: string; communicationState: string } };
}

beforeAll(async () => {
  harness = await createHarness();
  await harness.raw.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'),
      ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing;
  `);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------
// Provenance at match creation
// ---------------------------------------------------------------------------

describe('POST /interests/:id/respond — the state a match is born in', () => {
  it('opens directly today, because nothing can require review yet', async () => {
    // The default is `direct` and no write path exists for the policy, so this
    // is the only branch reachable through the API as it ships. Pinned so that
    // the safeguard is visibly a no-op for current users.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const { match: created } = await match(alice, bilal);
    expect(created.communicationState).toBe('open');
  });

  it('is born `pending_family_review` when a side requires it', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(bilal.userId, 'family_reviewed');

    const { match: created } = await match(alice, bilal);
    expect(created.communicationState).toBe('pending_family_review');
    expect(await stateOf(created.id)).toBe('pending_family_review');
  });

  it('reports the gated state to BOTH sides, not just the one who required it', async () => {
    // Neither side may act on an assumption. The contract is explicit: "Read
    // `match.communicationState` — never assume acceptance means chat."
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');
    const { match: created } = await match(alice, bilal);

    for (const member of [alice, bilal]) {
      const response = await get(`/matches/${created.id}`, member.authId);
      expect(response.statusCode, member.userId).toBe(200);
      expect(response.json().communicationState, member.userId).toBe('pending_family_review');
    }
  });

  it('records the real state in the `created` event, not a presumed one', async () => {
    // `match_events` is the state machine's history. A `created` event that
    // claimed `open` for a gated match would make the audit trail lie about
    // the one fact the gate exists to record.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(bilal.userId, 'family_reviewed');
    const { match: created } = await match(alice, bilal);

    const rows = await harness.raw.query<{ event: string; to_state: string | null }>(
      `select event, to_state from public.match_events
        where match_id = $1::uuid order by created_at`,
      [created.id],
    );
    expect(rows.rows).toEqual([{ event: 'created', to_state: 'pending_family_review' }]);
  });

  it('still leaves conversationId null — a gated match has no thread', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');
    const { match: created } = await match(alice, bilal);
    expect((created as { conversationId?: unknown }).conversationId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unmatch → rematch, through the routes
// ---------------------------------------------------------------------------

describe('unmatch → rematch is not a way around the gate', () => {
  it('re-gates a pair who unmatch and come back', async () => {
    // THE REGRESSION. The accept route used to revive the row with
    // `communication_state = 'open'` hard-coded, so a gated pair had only to
    // unmatch and rematch to arrive in a writable state with no review.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');

    const first = await match(alice, bilal);
    expect(first.match.communicationState).toBe('pending_family_review');
    expect((await unmatch(alice, first.match.id)).statusCode).toBe(204);

    // Bilal now asks Alice — the other ordering, so the interests index allows
    // a fresh interest, and the accept path revives the one match row.
    const freshId = (await send(bilal, alice.userId)).json().id as string;
    const second = (await respond(alice, freshId, 'accept')).json();

    expect(second.match.id).toBe(first.match.id);
    expect(second.match.communicationState).toBe('pending_family_review');
    expect(await stateOf(first.match.id)).toBe('pending_family_review');
  });

  it('gates a pair who were legitimately open before, if a side has since turned review on', async () => {
    // The new match period is a match "created afterwards" in the words of
    // ERD §21 invariant 5, so the current policy governs it. This is the case
    // that makes it a gate and not a memory.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    const first = await match(alice, bilal);
    expect(first.match.communicationState).toBe('open');
    await unmatch(bilal, first.match.id);

    await setPolicy(bilal.userId, 'family_reviewed');
    const freshId = (await send(bilal, alice.userId)).json().id as string;
    const second = (await respond(alice, freshId, 'accept')).json();

    expect(second.match.id).toBe(first.match.id);
    expect(second.match.communicationState).toBe('pending_family_review');
  });

  it('opens a revived match when the requirement has been withdrawn', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');

    const first = await match(alice, bilal);
    await unmatch(alice, first.match.id);
    await setPolicy(alice.userId, 'direct');

    const freshId = (await send(bilal, alice.userId)).json().id as string;
    const second = (await respond(alice, freshId, 'accept')).json();
    expect(second.match.communicationState).toBe('open');
  });

  it('leaves a live match alone when a participant changes their policy', async () => {
    // ERD §21 invariant 5 from the other side. Freezing a running match from a
    // settings toggle would be indistinguishable from a bug — and, for someone
    // under pressure at home, from a punishment.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const { match: created } = await match(alice, bilal);
    expect(created.communicationState).toBe('open');

    await setPolicy(alice.userId, 'family_reviewed');
    expect(await stateOf(created.id)).toBe('open');
    expect((await get(`/matches/${created.id}`, bilal.authId)).json().communicationState).toBe(
      'open',
    );
  });

  it('does not move the state when a match ends', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');
    const { match: created } = await match(alice, bilal);

    await unmatch(alice, created.id);
    // Ending is the member's decision about the relationship, not the family's
    // about writing. The gate reads exactly as it did.
    expect(await stateOf(created.id)).toBe('pending_family_review');
  });
});

// ---------------------------------------------------------------------------
// Blocks still outrank everything — ERD §21 invariant 3
// ---------------------------------------------------------------------------

describe('blocks outrank the gate', () => {
  const block = (blocker: Member, blockedUserId: string) =>
    harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [blocker.userId, blockedUserId],
    );

  it('refuses an interest to someone who blocked you, policy or not', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(bilal.userId, 'family_reviewed');
    await block(bilal, alice.userId);

    const response = await send(alice, bilal.userId);
    // 404, not 403: confirming the block would tell Alice she was blocked.
    expect(response.statusCode).toBe(404);
  });

  it('refuses to create a gated match once a block appears mid-flight', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');

    const interestId = (await send(alice, bilal.userId)).json().id as string;
    await block(alice, bilal.userId);

    expect((await respond(bilal, interestId, 'accept')).statusCode).toBe(404);
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.matches
        where user_a_id = least($1::uuid, $2::uuid)
          and user_b_id = greatest($1::uuid, $2::uuid)`,
      [alice.userId, bilal.userId],
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(0);
  });

  it('still lets a participant leave a gated match after being blocked', async () => {
    // A block must not trap someone in a match they want out of, and a pending
    // review must not either.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await setPolicy(alice.userId, 'family_reviewed');
    const { match: created } = await match(alice, bilal);

    await block(bilal, alice.userId);
    expect((await unmatch(alice, created.id)).statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// `interests.note` — the boundary that DOES hold
// ---------------------------------------------------------------------------

/**
 * The note is an intentional part of the contract: README §4.7 lists "Send
 * interest (both genders) with optional note" as an MVP feature, ERD §10
 * describes the column as "Optional message with the interest", and ADR 0011
 * gives a delegate `review_interest` so a family can read it. It is therefore
 * left exactly as it is, and the remaining question — whether a product that
 * forbids contact exchange should carry a free-text field at all — is a
 * product decision, reported rather than silently answered here.
 *
 * What these tests pin is the boundary that does exist, so that the one hole
 * does not quietly widen: the note reaches the two parties and nobody else,
 * it is capped, and it is nowhere in the discovery surface.
 */
describe('interests.note stays within the pair', () => {
  it('reaches the recipient, which is what the contract says it is for', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await send(alice, bilal.userId, 'Assalamu alaikum, I liked your profile.');

    const items = (await get('/interests?direction=received', bilal.authId)).json().items as Array<{
      note: string | null;
    }>;
    expect(items[0]!.note).toBe('Assalamu alaikum, I liked your profile.');
  });

  it('is capped at the 500 characters the contract specifies', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    expect((await send(alice, bilal.userId, 'x'.repeat(500))).statusCode).toBe(201);

    const chloe = await seedMember('male');
    expect((await send(alice, chloe.userId, 'x'.repeat(501))).statusCode).toBe(400);
  });

  it('is invisible to anyone outside the pair', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const other = await seedMember('male');
    const interestId = (await send(alice, bilal.userId, '+92 300 1234567')).json().id as string;

    // Not by detail read…
    expect((await get(`/interests/${interestId}`, other.authId)).statusCode).toBe(404);
    // …and not in a third party's own lists either.
    for (const direction of ['sent', 'received']) {
      const items = (await get(`/interests?direction=${direction}`, other.authId)).json()
        .items as unknown[];
      expect(items, direction).toEqual([]);
    }
  });

  it('is nowhere in the discovery surface', async () => {
    // The card allowlist is an enumerated projection, so free text cannot leak
    // into it by default. Asserted on the serialised payload rather than field
    // by field, so a newly added field carrying it would still be caught.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const plantedContact = 'reach-me-on-0300-1234567';
    await send(alice, bilal.userId, plantedContact);

    const response = await get('/discovery/sections/recommended', bilal.authId);
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain(plantedContact);
  });

  it('is not a channel a blocked sender keeps open', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await send(alice, bilal.userId, 'first');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );
    // No second note, and no withdrawal-and-resend either.
    expect((await send(alice, bilal.userId, 'second')).statusCode).toBe(404);
  });
});
