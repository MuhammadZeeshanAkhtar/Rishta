import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * `POST /interests/{id}/respond`, and the match an acceptance produces.
 *
 * Two properties carry this slice:
 *
 *   * **Only the recipient may answer.** A sender responding to their own
 *     interest would be self-matching by proxy.
 *   * **One match per pair, ever.** Two people who sent interests both ways
 *     can both reach the accept path, and the unique index — not a prior
 *     existence check — is what makes that safe.
 *
 * Accepting does NOT open a conversation. ADR 0011 separates the two and the
 * contract says so in as many words, so `conversationId` stays null.
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

const send = (sender: Member, recipientUserId: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/interests',
    headers: authHeader(sender.authId),
    payload: { recipientUserId },
  });

const respond = (member: Member, interestId: string, decision: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/interests/${interestId}/respond`,
    headers: authHeader(member.authId),
    payload: { decision },
  });

/** A sent, pending interest from a fresh pair. */
async function pending(): Promise<{ sender: Member; recipient: Member; interestId: string }> {
  const sender = await seedMember('male');
  const recipient = await seedMember('female');
  const interestId = (await send(sender, recipient.userId)).json().id as string;
  return { sender, recipient, interestId };
}

const relationship = async (a: string, b: string): Promise<string> => {
  const rows = await harness.raw.query<{ v: string }>(
    `select app.relationship($1::uuid, $2::uuid) as v`,
    [a, b],
  );
  return rows.rows[0]!.v;
};

const matchCount = async (a: string, b: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.matches
      where (user_a_id = $1::uuid and user_b_id = $2::uuid)
         or (user_a_id = $2::uuid and user_b_id = $1::uuid)`,
    [a, b],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const eventCount = async (interestId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.interest_events where interest_id = $1::uuid`,
    [interestId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const quotaUsed = async (userId: string): Promise<number> => {
  const rows = await harness.raw.query<{ count: number }>(
    `select count from public.usage_counters
      where user_id = $1::uuid and counter_key = 'daily_interests'
        and period_start = current_date`,
    [userId],
  );
  return rows.rows[0]?.count ?? 0;
};

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
// Accept
// ---------------------------------------------------------------------------

describe('accept', () => {
  it('records the acceptance and creates the match', async () => {
    const { sender, recipient, interestId } = await pending();
    const response = await respond(recipient, interestId, 'accept');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.interest.status).toBe('accepted');
    expect(body.interest.respondedAt).not.toBeNull();
    expect(body.match).not.toBeNull();
    expect(body.match.counterpartUserId).toBe(sender.userId);
    expect(await matchCount(sender.userId, recipient.userId)).toBe(1);
  });

  it('does NOT open a conversation', async () => {
    // ADR 0011: accepting creates a match, not a thread. The gate decides
    // separately, and the chat slice is what fills this in.
    const { interestId, recipient } = await pending();
    const body = (await respond(recipient, interestId, 'accept')).json();

    expect(body.match.conversationId).toBeNull();
    expect(body.match.communicationState).toBe('open');
    // Nothing can require family review yet, so nothing is pending one.
    expect(body.match.familyReview).toBeNull();
  });

  it('moves the relationship to match, both ways', async () => {
    const { sender, recipient, interestId } = await pending();
    expect(await relationship(sender.userId, recipient.userId)).toBe('interest_pending');

    await respond(recipient, interestId, 'accept');
    expect(await relationship(sender.userId, recipient.userId)).toBe('match');
    expect(await relationship(recipient.userId, sender.userId)).toBe('match');
  });

  it('writes the accepted event and the match created event', async () => {
    const { interestId, recipient } = await pending();
    await respond(recipient, interestId, 'accept');

    // `sent` from slice 1, plus `accepted`.
    expect(await eventCount(interestId)).toBe(2);

    const matchEvents = await harness.raw.query<{ event: string; to_state: string }>(
      `select e.event, e.to_state from public.match_events e
         join public.matches m on m.id = e.match_id
        where m.interest_id = $1::uuid`,
      [interestId],
    );
    expect(matchEvents.rows).toHaveLength(1);
    expect(matchEvents.rows[0]!.event).toBe('created');
    expect(matchEvents.rows[0]!.to_state).toBe('open');
  });

  it('records which interest created the match', async () => {
    const { interestId, recipient } = await pending();
    await respond(recipient, interestId, 'accept');

    const rows = await harness.raw.query<{ interest_id: string }>(
      `select interest_id from public.matches where interest_id = $1::uuid`,
      [interestId],
    );
    expect(rows.rows[0]!.interest_id).toBe(interestId);
  });

  it('stores the pair ordered', async () => {
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'accept');

    const rows = await harness.raw.query<{ user_a_id: string; user_b_id: string }>(
      `select user_a_id, user_b_id from public.matches where interest_id = $1::uuid`,
      [interestId],
    );
    const [a, b] = [rows.rows[0]!.user_a_id, rows.rows[0]!.user_b_id];
    expect(a < b).toBe(true);
    expect([a, b].sort()).toEqual([sender.userId, recipient.userId].sort());
  });
});

// ---------------------------------------------------------------------------
// Decline and maybe_later
// ---------------------------------------------------------------------------

describe('decline', () => {
  it('records the decline and creates no match', async () => {
    const { sender, recipient, interestId } = await pending();
    const response = await respond(recipient, interestId, 'decline');

    expect(response.statusCode).toBe(200);
    expect(response.json().interest.status).toBe('declined');
    expect(response.json().match).toBeNull();
    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
  });

  it('returns the relationship to stranger', async () => {
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'decline');
    expect(await relationship(sender.userId, recipient.userId)).toBe('stranger');
  });

  it('tells the sender nothing beyond the status', async () => {
    // "A decline tells the sender it was declined and nothing more — no
    // reason, no detail."
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'decline');

    const list = await harness.app.inject({
      method: 'GET',
      url: '/interests?direction=sent',
      headers: authHeader(sender.authId),
    });
    const item = (list.json().items as Array<Record<string, unknown>>)[0]!;
    expect(item.status).toBe('declined');
    for (const forbidden of ['reason', 'declineReason', 'message', 'detail']) {
      expect(item).not.toHaveProperty(forbidden);
    }
  });

  it('writes the declined event', async () => {
    const { interestId, recipient } = await pending();
    await respond(recipient, interestId, 'decline');

    const rows = await harness.raw.query<{ event: string }>(
      `select event from public.interest_events where interest_id = $1::uuid order by created_at`,
      [interestId],
    );
    expect(rows.rows.map((r) => r.event)).toEqual(['sent', 'declined']);
  });
});

describe('maybe_later', () => {
  it('parks the interest without matching', async () => {
    const { sender, recipient, interestId } = await pending();
    const response = await respond(recipient, interestId, 'maybe_later');

    expect(response.statusCode).toBe(200);
    expect(response.json().interest.status).toBe('maybe_later');
    expect(response.json().match).toBeNull();
    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
  });

  it('still blocks a duplicate send, because it remains revisitable', async () => {
    // Parked, not withdrawn — so the partial unique index still applies and
    // the sender cannot simply re-ask.
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'maybe_later');
    expect((await send(sender, recipient.userId)).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Who may respond
// ---------------------------------------------------------------------------

describe('authorisation', () => {
  it('refuses an anonymous request', async () => {
    const { interestId } = await pending();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/interests/${interestId}/respond`,
      payload: { decision: 'accept' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does NOT let the SENDER respond to their own interest', async () => {
    // Self-matching by proxy. Same 404 a stranger gets.
    const { sender, recipient, interestId } = await pending();
    expect((await respond(sender, interestId, 'accept')).statusCode).toBe(404);
    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
  });

  it('does NOT let an uninvolved member respond', async () => {
    const { interestId } = await pending();
    const other = await seedMember('female');
    expect((await respond(other, interestId, 'accept')).statusCode).toBe(404);
  });

  it('404s an interest that does not exist', async () => {
    const member = await seedMember('female');
    expect(
      (await respond(member, '00000000-0000-0000-0000-000000000000', 'accept')).statusCode,
    ).toBe(404);
  });

  it('400s a malformed interest id', async () => {
    const member = await seedMember('female');
    expect((await respond(member, 'not-a-uuid', 'accept')).statusCode).toBe(400);
  });

  it('400s a decision outside the contract enum', async () => {
    const { recipient, interestId } = await pending();
    for (const decision of ['ghost', 'ACCEPT', '', 'block']) {
      expect((await respond(recipient, interestId, decision)).statusCode, decision).toBe(400);
    }
  });

  it('refuses once the pair is blocked', async () => {
    const { sender, recipient, interestId } = await pending();
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [sender.userId, recipient.userId],
    );
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(404);
    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
  });

  it('refuses once the sender is suspended', async () => {
    const { sender, recipient, interestId } = await pending();
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      sender.userId,
    ]);
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(404);
  });

  it('refuses once the sender profile is no longer approved', async () => {
    const { sender, recipient, interestId } = await pending();
    await harness.raw.query(
      `update public.profiles set review_status = 'rejected' where user_id = $1::uuid`,
      [sender.userId],
    );
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(404);
  });

  it('refuses to answer a withdrawn interest', async () => {
    const { sender, recipient, interestId } = await pending();
    await harness.app.inject({
      method: 'DELETE',
      url: `/interests/${interestId}`,
      headers: authHeader(sender.authId),
    });
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and concurrency
// ---------------------------------------------------------------------------

describe('repeating a response', () => {
  it('refuses a second accept with the contract 409', async () => {
    const { recipient, interestId } = await pending();
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(200);

    const second = await respond(recipient, interestId, 'accept');
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('conflict');
  });

  it('writes no second event on a repeated accept', async () => {
    const { recipient, interestId } = await pending();
    await respond(recipient, interestId, 'accept');
    await respond(recipient, interestId, 'accept');
    expect(await eventCount(interestId)).toBe(2);
  });

  it('creates no second match on a repeated accept', async () => {
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'accept');
    await respond(recipient, interestId, 'accept');
    expect(await matchCount(sender.userId, recipient.userId)).toBe(1);
  });

  it('refuses a second decline', async () => {
    const { recipient, interestId } = await pending();
    await respond(recipient, interestId, 'decline');
    expect((await respond(recipient, interestId, 'decline')).statusCode).toBe(409);
  });

  it('refuses changing a decline into an accept', async () => {
    // One decision per interest. Reopening is sending a fresh one.
    const { sender, recipient, interestId } = await pending();
    await respond(recipient, interestId, 'decline');
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(409);
    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
  });
});

describe('concurrency', () => {
  it('creates one match when the same accept arrives five times at once', async () => {
    const { sender, recipient, interestId } = await pending();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => respond(recipient, interestId, 'accept')),
    );

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await matchCount(sender.userId, recipient.userId)).toBe(1);
    expect(await eventCount(interestId)).toBe(2);
  });

  it('creates one match when BOTH sides accept crossing interests', async () => {
    // The real race: A and B each sent an interest, and each accepts the
    // other's. Two accept paths, one pair — the unique index decides.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    const aToB = (await send(alice, bilal.userId)).json().id as string;
    const bToA = (await send(bilal, alice.userId)).json().id as string;

    const [first, second] = await Promise.all([
      respond(bilal, aToB, 'accept'),
      respond(alice, bToA, 'accept'),
    ]);

    // Both acceptances are valid — neither member is told their decision was
    // rejected because the other got there first.
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // But there is exactly one match, and both responses carry it.
    expect(await matchCount(alice.userId, bilal.userId)).toBe(1);
    expect(first.json().match.id).toBe(second.json().match.id);

    // And exactly one `created` event for it.
    const events = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.match_events e
         join public.matches m on m.id = e.match_id
        where m.user_a_id = least($1::uuid, $2::uuid)
          and m.user_b_id = greatest($1::uuid, $2::uuid)`,
      [alice.userId, bilal.userId],
    );
    expect(Number.parseInt(events.rows[0]!.n, 10)).toBe(1);
  });

  it('leaves no orphan match or event when a response is refused', async () => {
    // The whole transition is one transaction, so a refusal leaves nothing.
    const { sender, recipient, interestId } = await pending();
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [recipient.userId, sender.userId],
    );
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(404);

    expect(await matchCount(sender.userId, recipient.userId)).toBe(0);
    // Only the original `sent` event.
    expect(await eventCount(interestId)).toBe(1);
    const rows = await harness.raw.query<{ status: string; responded_at: string | null }>(
      `select status, responded_at from public.interests where id = $1::uuid`,
      [interestId],
    );
    expect(rows.rows[0]!.status).toBe('pending');
    expect(rows.rows[0]!.responded_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('quota is untouched by responding', () => {
  it('does not charge the recipient for accepting', async () => {
    const { recipient, interestId } = await pending();
    expect(await quotaUsed(recipient.userId)).toBe(0);
    await respond(recipient, interestId, 'accept');
    expect(await quotaUsed(recipient.userId)).toBe(0);
  });

  it('does not charge the recipient for declining', async () => {
    const { recipient, interestId } = await pending();
    await respond(recipient, interestId, 'decline');
    expect(await quotaUsed(recipient.userId)).toBe(0);
  });

  it('does not refund the sender on a decline', async () => {
    // A refund would make the limit bypassable by sending to someone certain
    // to decline.
    const { sender, recipient, interestId } = await pending();
    expect(await quotaUsed(sender.userId)).toBe(1);
    await respond(recipient, interestId, 'decline');
    expect(await quotaUsed(sender.userId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('later slices remain unbuilt', () => {
  it('creates no conversation anywhere', async () => {
    const { interestId, recipient } = await pending();
    await respond(recipient, interestId, 'accept');

    const tables = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name in ('conversations', 'messages')`,
    );
    expect(Number.parseInt(tables.rows[0]!.n, 10)).toBe(0);
  });

  it('exposes no match MUTATION surface', async () => {
    // Slice 3 added the match READS, so the earlier "no match endpoint"
    // assertion is superseded. What still holds is that nothing can END a
    // match or drive family review — both belong to later slices.
    const { recipient, interestId } = await pending();
    const body = (await respond(recipient, interestId, 'accept')).json();

    for (const [method, url] of [
      // `unmatch` arrived in Slice 4 and is covered by unmatch.test.ts. What
      // remains absent is a hard delete and anything family-review.
      ['DELETE', `/matches/${body.match.id}`],
      ['GET', `/matches/${body.match.id}/family-review`],
      ['POST', `/matches/${body.match.id}/family-review`],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: authHeader(recipient.authId),
        payload: {},
      });
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});
