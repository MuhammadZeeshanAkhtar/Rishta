import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/discovery/candidates';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Code review remediation, Phase 1 — through the real routes.
 *
 * One regression test (or more) per finding in the 2026-10-28 review that
 * Phase 1 covers: B1, B3, B4, B7, B9, B17. B8 is covered by photos.test.ts,
 * which runs every upload through the upgraded sharp and the new format check.
 *
 * The review's own advice was that B1 and B4 are CROSS-STEP bugs — each step
 * was correct in isolation, and 1,133 tests passed while the sequence was
 * broken. So those are tested here as sequences, in the order the review
 * described: reject THEN approve, defer THEN accept.
 *
 * WHAT THIS FILE CANNOT TEST, stated rather than faked. The PGlite harness
 * runs every transaction on one connection and does not serialise them, so
 * two "concurrent" requests share a transaction instead of contending for a
 * row lock. A Promise.all race here would pass whether or not the lock
 * existed. B17's lock, and the match lock added for B1, are therefore pinned
 * by their deterministic consequences below; proving the race itself needs a
 * multi-connection Postgres, which is recorded as an open testing gap (L12).
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(gender: 'male' | 'female', h: TestHarness = harness): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await h.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Member ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await h.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await h.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await h.raw.query(
    `insert into public.verification_status (user_id, email_verified_at)
     values ($1::uuid, now())`,
    [userId],
  );
  await h.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  await h.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const get = (url: string, auth: string, h: TestHarness = harness) =>
  h.app.inject({ method: 'GET', url, headers: authHeader(auth) });

const post = (url: string, auth: string, payload: Record<string, unknown> = {}) =>
  harness.app.inject({ method: 'POST', url, headers: authHeader(auth), payload });

const patchMe = (member: Member, payload: Record<string, unknown>) =>
  harness.app.inject({
    method: 'PATCH',
    url: '/me',
    headers: authHeader(member.authId),
    payload,
  });

const del = (url: string, auth: string) =>
  harness.app.inject({ method: 'DELETE', url, headers: authHeader(auth) });

async function sendInterest(from: Member, to: Member): Promise<string> {
  const response = await post('/interests', from.authId, { recipientUserId: to.userId });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

const respond = (member: Member, interestId: string, decision: string) =>
  post(`/interests/${interestId}/respond`, member.authId, { decision });

async function grantIncognito(member: Member, expiresAt: string | null = null): Promise<void> {
  await harness.raw.query(
    `insert into public.user_entitlements (user_id, entitlement_key, value, expires_at)
     values ($1::uuid, 'incognito', 'true'::jsonb, $2::timestamptz)
     on conflict (user_id, entitlement_key)
       do update set value = excluded.value, expires_at = excluded.expires_at`,
    [member.userId, expiresAt],
  );
}

/** Invite a delegate and have them accept, as the routes do it. */
async function link(owner: Member, delegate: Member): Promise<void> {
  seq += 1;
  const created = await post('/family/invitations', owner.authId, {
    inviteeContact: `review-p1-${seq}@example.com`,
    relationshipCode: 'father',
    tier: 'reviewer',
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id, token } = created.json() as { id: string; token: string };
  const accepted = await post(`/family/invitations/${id}/respond`, delegate.authId, {
    token,
    accept: true,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
}

const stateOf = async (matchId: string): Promise<string> => {
  const rows = await harness.raw.query<{ communication_state: string }>(
    `select communication_state from public.matches where id = $1::uuid`,
    [matchId],
  );
  return rows.rows[0]!.communication_state;
};

/** The ids in a viewer's recommended feed, generated fresh. */
async function feedOf(viewer: Member): Promise<string[]> {
  const response = await get('/discovery/sections/recommended', viewer.authId);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { items: { userId: string }[] }).items.map((i) => i.userId);
}

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// =============================================================================
// B1
// =============================================================================

describe('B1 — a family rejection cannot be overridden', () => {
  /** Two households that both require review, each with a reviewer. */
  async function bothGated(): Promise<{
    ownerA: Member;
    ownerB: Member;
    delegateA: Member;
    delegateB: Member;
    matchId: string;
  }> {
    const ownerA = await seedMember('female');
    const ownerB = await seedMember('male');
    const delegateA = await seedMember('male');
    const delegateB = await seedMember('female');
    await link(ownerA, delegateA);
    await link(ownerB, delegateB);
    expect((await patchMe(ownerA, { communicationPolicy: 'family_reviewed' })).statusCode).toBe(
      200,
    );
    expect((await patchMe(ownerB, { communicationPolicy: 'family_reviewed' })).statusCode).toBe(
      200,
    );

    const interestId = await sendInterest(ownerB, ownerA);
    const accepted = await respond(ownerA, interestId, 'accept');
    expect(accepted.statusCode, accepted.body).toBe(200);
    const matchId = (accepted.json() as { match: { id: string } }).match.id;
    expect(await stateOf(matchId)).toBe('pending_family_review');
    return { ownerA, ownerB, delegateA, delegateB, matchId };
  }

  it('refuses an approval that arrives AFTER the other family rejected — the reported order', async () => {
    const { delegateA, delegateB, matchId } = await bothGated();

    const rejected = await post(`/family/reviews/${matchId}/decide`, delegateB.authId, {
      action: 'reject',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await stateOf(matchId)).toBe('family_rejected');

    const approved = await post(`/family/reviews/${matchId}/decide`, delegateA.authId, {
      action: 'approve',
    });
    // Before the fix this answered 200 and moved the match to
    // family_approved: B's rejection was invisible to A's approval.
    expect(approved.statusCode, approved.body).toBe(409);
    expect(await stateOf(matchId)).toBe('family_rejected');

    // And no conversation opened against the rejection.
    const threads = await harness.raw.query(
      `select id from public.conversations where match_id = $1::uuid`,
      [matchId],
    );
    expect(threads.rows).toHaveLength(0);
  });

  it('keeps the match closed when the approval came FIRST and the rejection second', async () => {
    const { delegateA, delegateB, matchId } = await bothGated();

    expect(
      (await post(`/family/reviews/${matchId}/decide`, delegateA.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(200);
    // One approval is not everyone's approval.
    expect(await stateOf(matchId)).toBe('pending_family_review');

    expect(
      (await post(`/family/reviews/${matchId}/decide`, delegateB.authId, { action: 'reject' }))
        .statusCode,
    ).toBe(200);
    expect(await stateOf(matchId)).toBe('family_rejected');
  });

  it('still opens the match when BOTH families approve', async () => {
    const { delegateA, delegateB, matchId } = await bothGated();
    await post(`/family/reviews/${matchId}/decide`, delegateA.authId, { action: 'approve' });
    await post(`/family/reviews/${matchId}/decide`, delegateB.authId, { action: 'approve' });
    expect(await stateOf(matchId)).toBe('family_approved');
  });

  it('retires the OTHER side’s review once one family rejects', async () => {
    // Found in the Phase 1 review. Refusing decisions on a rejected match is
    // right, but it left the surviving review with no way out: it stayed in
    // the delegate's inbox answering 409, read "waiting for approval" on the
    // owner's screen, and after 72 hours warned the owner that their family
    // was stalling — on a match already closed.
    const { ownerA, delegateA, delegateB, matchId } = await bothGated();
    await post(`/family/reviews/${matchId}/decide`, delegateB.authId, { action: 'reject' });

    const inbox = (await get('/family/reviews', delegateA.authId)).json() as {
      items: { matchId: string }[];
    };
    expect(inbox.items.map((i) => i.matchId)).not.toContain(matchId);

    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '80 hours'
        where match_id = $1::uuid and owner_user_id = $2::uuid`,
      [matchId, ownerA.userId],
    );
    const mine = (await get('/family/my-reviews', ownerA.authId)).json() as {
      items: { matchId: string }[];
    };
    expect(mine.items.map((i) => i.matchId)).not.toContain(matchId);

    const warnings = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where user_id = $1::uuid and type = 'family_review_stalled'`,
      [ownerA.userId],
    );
    expect(Number(warnings.rows[0]!.n)).toBe(0);
  });

  it('still warns about a review that genuinely stalls on a LIVE match', async () => {
    // The guard above must not switch the R16 control off for the case it
    // exists for.
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate);
    await patchMe(owner, { communicationPolicy: 'family_reviewed' });
    const interestId = await sendInterest(suitor, owner);
    const matchId = (
      (await respond(owner, interestId, 'accept')).json() as { match: { id: string } }
    ).match.id;

    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '80 hours'
        where match_id = $1::uuid`,
      [matchId],
    );
    const mine = (await get('/family/my-reviews', owner.authId)).json() as {
      items: { matchId: string; overdue: boolean }[];
    };
    expect(mine.items.find((i) => i.matchId === matchId)?.overdue).toBe(true);

    const warnings = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where user_id = $1::uuid and type = 'family_review_stalled'`,
      [owner.userId],
    );
    expect(Number(warnings.rows[0]!.n)).toBe(1);

    // And it stays in the delegate's inbox, because it can still be decided.
    const inbox = (await get('/family/reviews', delegate.authId)).json() as {
      items: { matchId: string }[];
    };
    expect(inbox.items.map((i) => i.matchId)).toContain(matchId);
  });

  it('refuses a decision on a match whose approval was revoked', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate);
    await patchMe(owner, { communicationPolicy: 'family_reviewed' });
    const interestId = await sendInterest(suitor, owner);
    const matchId = (
      (await respond(owner, interestId, 'accept')).json() as { match: { id: string } }
    ).match.id;

    await post(`/family/reviews/${matchId}/decide`, delegate.authId, { action: 'approve' });
    expect((await post(`/family/reviews/${matchId}/revoke`, delegate.authId, {})).statusCode).toBe(
      200,
    );
    expect(await stateOf(matchId)).toBe('revoked');

    // A revoked review is not a second chance to approve through `decide`.
    expect(
      (await post(`/family/reviews/${matchId}/decide`, delegate.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(409);
    expect(await stateOf(matchId)).toBe('revoked');
  });
});

// =============================================================================
// B3
// =============================================================================

describe('B3 — incognito is a paid entitlement, enforced by the server', () => {
  it('refuses a free member switching incognito on', async () => {
    const free = await seedMember('female');
    const response = await patchMe(free, { incognito: true });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'entitlement_required' });

    const me = (await get('/me', free.authId)).json() as { incognito: boolean };
    expect(me.incognito).toBe(false);
  });

  it('allows it with the entitlement, and reports it', async () => {
    const paid = await seedMember('female');
    await grantIncognito(paid);
    expect((await patchMe(paid, { incognito: true })).statusCode).toBe(200);
    expect(((await get('/me', paid.authId)).json() as { incognito: boolean }).incognito).toBe(true);
  });

  it('reports incognito OFF once the entitlement lapses, and lets it be switched off', async () => {
    const lapsed = await seedMember('female');
    await grantIncognito(lapsed);
    await patchMe(lapsed, { incognito: true });
    await grantIncognito(lapsed, '2020-01-01T00:00:00Z');

    // Reporting the stored flag would tell them they are hidden when the
    // protection — the paid feature — is no longer being provided.
    expect(((await get('/me', lapsed.authId)).json() as { incognito: boolean }).incognito).toBe(
      false,
    );
    // And they are never trapped: switching off needs no entitlement.
    expect((await patchMe(lapsed, { incognito: false })).statusCode).toBe(200);
  });
});

describe('B3 — pause and incognito actually hide a member from discovery', () => {
  it('leaves a PAUSED member out of a freshly generated feed', async () => {
    const viewer = await seedMember('male');
    const paused = await seedMember('female');
    const visible = await seedMember('female');
    await patchMe(paused, { discoveryPaused: true });

    await generateCandidates(harness.db, viewer.userId);
    const feed = await feedOf(viewer);
    expect(feed).toContain(visible.userId);
    expect(feed).not.toContain(paused.userId);
  });

  it('drops a member who pauses AFTER the feed was generated, at read time', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await generateCandidates(harness.db, viewer.userId);
    expect(await feedOf(viewer)).toContain(target.userId);

    // Pausing must not wait for the next generation cooldown to take effect —
    // someone who just got engaged is hidden now, not in fifteen minutes.
    await patchMe(target, { discoveryPaused: true });
    expect(await feedOf(viewer)).not.toContain(target.userId);

    await patchMe(target, { discoveryPaused: false });
    expect(await feedOf(viewer)).toContain(target.userId);
  });

  it('keeps a paused member in their EXISTING matches', async () => {
    // Pausing hides you from browsing. It does not unmake relationships you
    // already have, which is why discovery got its own predicate rather than
    // can_view_profile() gaining the rule.
    const paused = await seedMember('female');
    const matched = await seedMember('male');
    const interestId = await sendInterest(matched, paused);
    expect((await respond(paused, interestId, 'accept')).statusCode).toBe(200);

    await patchMe(paused, { discoveryPaused: true });

    const matches = await get('/matches', matched.authId);
    expect(matches.statusCode).toBe(200);
    expect(matches.body).toContain(paused.userId);
  });

  it('hides an incognito member until they express interest in the viewer', async () => {
    const viewer = await seedMember('male');
    const incognito = await seedMember('female');
    await grantIncognito(incognito);
    expect((await patchMe(incognito, { incognito: true })).statusCode).toBe(200);

    await generateCandidates(harness.db, viewer.userId);
    expect(await feedOf(viewer)).not.toContain(incognito.userId);

    // The incognito member likes the viewer, which is the one thing that
    // makes them findable by that viewer.
    await sendInterest(incognito, viewer);
    await harness.raw.query(
      `delete from public.discovery_generation_runs where user_id = $1::uuid`,
      [viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);
    expect(await feedOf(viewer)).toContain(incognito.userId);

    // And still hidden from everyone else.
    const stranger = await seedMember('male');
    await generateCandidates(harness.db, stranger.userId);
    expect(await feedOf(stranger)).not.toContain(incognito.userId);
  });

  it('removes a paused member from other people’s shortlists', async () => {
    const viewer = await seedMember('male');
    const saved = await seedMember('female');
    const put = await harness.app.inject({
      method: 'PUT',
      url: `/discovery/shortlist/${saved.userId}`,
      headers: authHeader(viewer.authId),
    });
    expect([200, 204]).toContain(put.statusCode);

    const before = await get('/discovery/shortlist', viewer.authId);
    expect(before.body).toContain(saved.userId);

    await patchMe(saved, { discoveryPaused: true });
    const after = await get('/discovery/shortlist', viewer.authId);
    expect(after.body).not.toContain(saved.userId);
  });
});

// =============================================================================
// B4 and B17
// =============================================================================

describe('B4 — "Maybe later" defers a decision instead of killing it', () => {
  it('lets the recipient ACCEPT a deferred interest, and the match forms', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);

    expect((await respond(recipient, interestId, 'maybe_later')).statusCode).toBe(200);
    const accepted = await respond(recipient, interestId, 'accept');
    // Before the fix: 409 "already answered", forever.
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as { match: { id: string } | null }).match).not.toBeNull();
  });

  it('lets the recipient DECLINE a deferred interest', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);
    await respond(recipient, interestId, 'maybe_later');

    const declined = await respond(recipient, interestId, 'decline');
    expect(declined.statusCode).toBe(200);
    expect((declined.json() as { interest: { status: string } }).interest.status).toBe('declined');
  });

  it('refuses deferring something already deferred', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);
    await respond(recipient, interestId, 'maybe_later');
    expect((await respond(recipient, interestId, 'maybe_later')).statusCode).toBe(409);
  });

  it('lets the SENDER withdraw a deferred interest, and send again afterwards', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);
    await respond(recipient, interestId, 'maybe_later');

    expect((await del(`/interests/${interestId}`, sender.authId)).statusCode).toBe(204);
    // Withdrawn frees the active-pair index, so this is a fresh interest.
    const again = await post('/interests', sender.authId, { recipientUserId: recipient.userId });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('still refuses answering an interest that is already resolved', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);
    await respond(recipient, interestId, 'decline');
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(409);
  });
});

describe('B17 — a second Accept records nothing twice', () => {
  it('answers the repeat with 409 and leaves ONE event and ONE notification', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = await sendInterest(sender, recipient);

    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(200);
    expect((await respond(recipient, interestId, 'accept')).statusCode).toBe(409);

    const events = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.interest_events
        where interest_id = $1::uuid and event = 'accepted'`,
      [interestId],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);

    const notices = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where user_id = $1::uuid and type = 'interest_accepted'`,
      [sender.userId],
    );
    expect(Number(notices.rows[0]!.n)).toBe(1);
  });
});

// =============================================================================
// B7
// =============================================================================

describe('B7 — chat sends only text, and never a blank message', () => {
  async function thread(): Promise<{ alice: Member; id: string }> {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const interestId = await sendInterest(bilal, alice);
    const matchId = (
      (await respond(alice, interestId, 'accept')).json() as { match: { id: string } }
    ).match.id;
    const rows = await harness.raw.query<{ id: string }>(
      `select id from public.conversations where match_id = $1::uuid`,
      [matchId],
    );
    return { alice, id: rows.rows[0]!.id };
  }

  it('still sends ordinary text, stored as kind text', async () => {
    const { alice, id } = await thread();
    const sent = await post(`/conversations/${id}/messages`, alice.authId, { body: 'Salaam.' });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ kind: 'text' });
  });

  it('refuses a body of only newlines and tabs', async () => {
    // The database check was first written with btrim(), which strips only
    // spaces and let this through. Refused here by the route, and by
    // `messages_body_not_blank` for any caller that reaches the table.
    const { alice, id } = await thread();
    const sent = await post(`/conversations/${id}/messages`, alice.authId, {
      body: '\n\t\n',
    });
    expect(sent.statusCode).toBe(400);
  });
});

// =============================================================================
// B9
// =============================================================================

describe('B9 — the rate limiter keys on the member, not the network', () => {
  let limited: TestHarness;

  beforeAll(async () => {
    // A ceiling small enough to reach. Every inject() call arrives from the
    // same address, which is exactly the shared-NAT case the review described.
    limited = await createHarness({ RATE_LIMIT_PER_MINUTE: 3, RATE_LIMIT_SENDS_PER_MINUTE: 2 });
  }, 180_000);

  afterAll(async () => {
    await limited?.close();
  });

  it('gives two members behind the SAME address separate budgets', async () => {
    const first = await seedMember('female', limited);
    const second = await seedMember('male', limited);

    for (let i = 0; i < 3; i += 1) {
      expect((await get('/me', first.authId, limited)).statusCode).toBe(200);
    }
    expect((await get('/me', first.authId, limited)).statusCode).toBe(429);

    // Before the fix the limiter never saw the user, so this shared the first
    // member's exhausted bucket and was throttled for someone else's traffic.
    expect((await get('/me', second.authId, limited)).statusCode).toBe(200);
  });

  it('keys an unauthenticated caller by address', async () => {
    const anon = () =>
      limited.app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '203.0.113.7',
      });
    for (let i = 0; i < 3; i += 1) {
      expect((await anon()).statusCode).not.toBe(429);
    }
    expect((await anon()).statusCode).toBe(429);
  });

  it('does not let FORGED tokens spread across buckets', async () => {
    // Keyed on the VERIFIED subject. An invalid token fails verification and
    // falls back to its address, so rotating made-up subjects buys nothing.
    const forged = (n: number) =>
      limited.app.inject({
        method: 'GET',
        url: '/me',
        remoteAddress: '203.0.113.99',
        headers: { authorization: `Bearer forged-token-${n}` },
      });
    for (let i = 0; i < 3; i += 1) {
      expect((await forged(i)).statusCode).toBe(401);
    }
    expect((await forged(99)).statusCode).toBe(429);
  });

  it('applies the tighter ceiling to sends while browsing continues', async () => {
    const reporter = await seedMember('female', limited);
    const report = () =>
      limited.app.inject({
        method: 'POST',
        url: '/reports',
        headers: authHeader(reporter.authId),
        payload: { reportedUserId: '00000000-0000-4000-8000-000000000000', category: 'scam' },
      });

    expect((await report()).statusCode).not.toBe(429);
    expect((await report()).statusCode).not.toBe(429);
    expect((await report()).statusCode).toBe(429);

    // The general budget is separate: the same member can still read.
    expect((await get('/me', reporter.authId, limited)).statusCode).toBe(200);
  });
});
