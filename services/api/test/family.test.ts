import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Family Safety end to end, through the real routes (Phase 6b, ADR 0011, D12).
 *
 * The RLS suite already proves what each role can reach at the table. This
 * asks the question the routes own: does the gate actually open and close, and
 * does it refuse the things it must refuse?
 *
 * The scenarios that carry the safety model:
 *
 *   - a gated match produces a review a delegate can actually decide, and
 *     approving it is what opens the gate;
 *   - the OWNER cannot decide their own review, however they come at it;
 *   - a revoked delegate loses everything on the next request, not the next
 *     login, and an in-flight review is left pending rather than resolved;
 *   - a delegate can confirm the match they were asked about and cannot
 *     enumerate anything else;
 *   - a stalled review warns the owner once, and changes no decision.
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

const get = (url: string, auth: string) =>
  harness.app.inject({ method: 'GET', url, headers: authHeader(auth) });

const post = (url: string, auth: string, payload: Record<string, unknown> = {}) =>
  harness.app.inject({ method: 'POST', url, headers: authHeader(auth), payload });

const patch = (url: string, auth: string, payload: Record<string, unknown>) =>
  harness.app.inject({ method: 'PATCH', url, headers: authHeader(auth), payload });

const del = (url: string, auth: string) =>
  harness.app.inject({ method: 'DELETE', url, headers: authHeader(auth) });

/** Turns the owner's gate on, as the owner would. */
const setPolicy = (member: Member, communicationPolicy: string) =>
  harness.app.inject({
    method: 'PATCH',
    url: '/me',
    headers: authHeader(member.authId),
    payload: { communicationPolicy },
  });

/** Invite someone and have them accept, returning the relationship id. */
async function link(
  owner: Member,
  delegate: Member,
  tier: 'observer' | 'reviewer',
): Promise<string> {
  seq += 1;
  const created = await post('/family/invitations', owner.authId, {
    inviteeContact: `relative${seq}@example.com`,
    relationshipCode: 'father',
    tier,
  });
  expect(created.statusCode, created.body).toBe(201);
  const invite = created.json() as { id: string; token: string };

  const accepted = await post(`/family/invitations/${invite.id}/respond`, delegate.authId, {
    token: invite.token,
    accept: true,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);

  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.family_relationships
      where owner_user_id = $1::uuid and delegate_user_id = $2::uuid`,
    [owner.userId, delegate.userId],
  );
  return rows.rows[0]!.id;
}

/** Drives two members to a match, returning its id. */
async function matchUp(a: Member, b: Member): Promise<string> {
  const sent = await post('/interests', a.authId, { recipientUserId: b.userId });
  expect(sent.statusCode, sent.body).toBe(201);
  const interestId = (sent.json() as { id: string }).id;

  const responded = await harness.app.inject({
    method: 'POST',
    url: `/interests/${interestId}/respond`,
    headers: authHeader(b.authId),
    payload: { decision: 'accept' },
  });
  expect(responded.statusCode, responded.body).toBe(200);
  return (responded.json() as { match: { id: string } }).match.id;
}

const stateOf = async (matchId: string): Promise<string> => {
  const rows = await harness.raw.query<{ communication_state: string }>(
    `select communication_state from public.matches where id = $1::uuid`,
    [matchId],
  );
  return rows.rows[0]!.communication_state;
};

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('invitations', () => {
  it('returns the token exactly once, and never again', async () => {
    const owner = await seedMember('female');
    const created = await post('/family/invitations', owner.authId, {
      inviteeContact: 'once@example.com',
      relationshipCode: 'brother',
      tier: 'reviewer',
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { token?: string }).token).toBeTruthy();

    const listed = await get('/family/invitations', owner.authId);
    const items = (listed.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    // A token readable from a list is a token that leaks with the list.
    expect(items[0]).not.toHaveProperty('token');
  });

  it('stores the token hashed, never raw', async () => {
    const owner = await seedMember('female');
    const created = await post('/family/invitations', owner.authId, {
      inviteeContact: 'hashed@example.com',
      relationshipCode: 'father',
      tier: 'observer',
    });
    const { token } = created.json() as { token: string };

    const rows = await harness.raw.query<{ token_hash: string }>(
      `select token_hash from public.family_invitations where invitee_contact = 'hashed@example.com'`,
    );
    expect(rows.rows[0]!.token_hash).not.toBe(token);
    expect(rows.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a second pending invitation to the same contact', async () => {
    const owner = await seedMember('female');
    const payload = {
      inviteeContact: 'twice@example.com',
      relationshipCode: 'mother' as const,
      tier: 'observer' as const,
    };
    expect((await post('/family/invitations', owner.authId, payload)).statusCode).toBe(201);
    expect((await post('/family/invitations', owner.authId, payload)).statusCode).toBe(409);
  });

  it('answers a wrong token exactly as it answers a missing invitation', async () => {
    const owner = await seedMember('female');
    const other = await seedMember('male');
    const created = await post('/family/invitations', owner.authId, {
      inviteeContact: 'oracle@example.com',
      relationshipCode: 'father',
      tier: 'reviewer',
    });
    const { id } = created.json() as { id: string };

    const wrongToken = await post(`/family/invitations/${id}/respond`, other.authId, {
      token: 'definitely-not-the-right-token',
      accept: true,
    });
    const missingId = await post(
      `/family/invitations/00000000-0000-4000-8000-000000000000/respond`,
      other.authId,
      { token: 'definitely-not-the-right-token', accept: true },
    );

    // Identical. A distinguishable "wrong token" turns this into an oracle
    // for which invitation ids exist.
    expect(wrongToken.statusCode).toBe(404);
    expect(missingId.statusCode).toBe(404);
  });

  it('refuses an expired invitation and records it as expired', async () => {
    const owner = await seedMember('female');
    const relative = await seedMember('male');
    const created = await post('/family/invitations', owner.authId, {
      inviteeContact: 'stale@example.com',
      relationshipCode: 'guardian',
      tier: 'observer',
    });
    const { id, token } = created.json() as { id: string; token: string };

    await harness.raw.query(
      `update public.family_invitations set expires_at = now() - interval '1 day'
        where id = $1::uuid`,
      [id],
    );

    const answered = await post(`/family/invitations/${id}/respond`, relative.authId, {
      token,
      accept: true,
    });
    expect(answered.statusCode).toBe(409);

    const rows = await harness.raw.query<{ status: string }>(
      `select status from public.family_invitations where id = $1::uuid`,
      [id],
    );
    expect(rows.rows[0]!.status).toBe('expired');
  });

  it('refuses accepting your own invitation', async () => {
    const owner = await seedMember('female');
    const created = await post('/family/invitations', owner.authId, {
      inviteeContact: 'self@example.com',
      relationshipCode: 'other',
      tier: 'reviewer',
    });
    const { id, token } = created.json() as { id: string; token: string };

    // Otherwise an owner becomes their own delegate and can approve their own
    // match, which D12 row 2 exists to forbid.
    const answered = await post(`/family/invitations/${id}/respond`, owner.authId, {
      token,
      accept: true,
    });
    expect(answered.statusCode).toBe(400);
  });

  it('grants the tier preset on acceptance, in the same transaction', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    await link(owner, delegate, 'reviewer');

    const members = await get('/family/members', owner.authId);
    const items = (members.json() as { items: { permissions: string[] }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.permissions).toEqual(
      expect.arrayContaining(['approve_communication', 'view_profile']),
    );
  });
});

describe('permissions', () => {
  it('refuses a permission whose phase has not arrived', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const relationshipId = await link(owner, delegate, 'observer');

    // ERD §12: rejected with 400, never accepted and ignored. A grant that
    // silently does nothing is worse than a refusal.
    const response = await patch(`/family/members/${relationshipId}/permissions`, owner.authId, {
      permissions: ['view_profile', 'join_conversation'],
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('join_conversation');
  });

  it('replaces the whole set rather than merging', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const relationshipId = await link(owner, delegate, 'reviewer');

    const response = await patch(`/family/members/${relationshipId}/permissions`, owner.authId, {
      permissions: ['view_profile'],
    });
    expect(response.statusCode).toBe(200);

    const members = await get('/family/members', owner.authId);
    const items = (members.json() as { items: { permissions: string[] }[] }).items;
    expect(items[0]!.permissions).toEqual(['view_profile']);
  });

  it('refuses a stranger changing someone else’s grants', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const stranger = await seedMember('female');
    const relationshipId = await link(owner, delegate, 'reviewer');

    const response = await patch(`/family/members/${relationshipId}/permissions`, stranger.authId, {
      permissions: ['view_profile'],
    });
    // 404, never 403 — a 403 would confirm the relationship exists.
    expect(response.statusCode).toBe(404);
  });
});

describe('the gate opens only when a delegate opens it', () => {
  it('gates a match when the owner requires review, and names no reviewer to the counterpart', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    expect((await setPolicy(owner, 'family_reviewed')).statusCode).toBe(200);

    const matchId = await matchUp(suitor, owner);
    expect(await stateOf(matchId)).toBe('pending_family_review');

    // The counterpart learns a review is pending and nothing more.
    const theirMatch = await get(`/matches/${matchId}`, suitor.authId);
    expect(theirMatch.statusCode).toBe(200);
    const body = theirMatch.body;
    expect(body).not.toContain(delegate.userId);
  });

  it('creates a review the delegate can actually see', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const inbox = await get('/family/reviews', delegate.authId);
    expect(inbox.statusCode).toBe(200);
    const items = (inbox.json() as { items: { matchId: string }[] }).items;
    expect(items.map((i) => i.matchId)).toContain(matchId);
  });

  it('labels each review with its OWN owner when a delegate acts for several', async () => {
    // A6: one delegate may hold rows for several people. The inbox query used
    // to read the owner from the first row of the page and apply it to all of
    // them, which named the wrong person and resolved the counterpart from
    // the wrong side of the match.
    const delegate = await seedMember('male');
    const ownerA = await seedMember('female');
    const ownerB = await seedMember('female');
    const suitorA = await seedMember('male');
    const suitorB = await seedMember('male');

    await link(ownerA, delegate, 'reviewer');
    await link(ownerB, delegate, 'reviewer');
    await setPolicy(ownerA, 'family_reviewed');
    await setPolicy(ownerB, 'family_reviewed');

    const matchA = await matchUp(suitorA, ownerA);
    const matchB = await matchUp(suitorB, ownerB);

    const inbox = await get('/family/reviews', delegate.authId);
    expect(inbox.statusCode).toBe(200);
    const items = (
      inbox.json() as {
        items: { matchId: string; ownerUserId: string; ownerDisplayName: string | null }[];
      }
    ).items;

    const a = items.find((i) => i.matchId === matchA);
    const b = items.find((i) => i.matchId === matchB);
    expect(a, 'review for owner A missing').toBeDefined();
    expect(b, 'review for owner B missing').toBeDefined();

    expect(a!.ownerUserId).toBe(ownerA.userId);
    expect(b!.ownerUserId).toBe(ownerB.userId);
    // And the names follow the ids rather than the first row's.
    expect(a!.ownerDisplayName).not.toBe(b!.ownerDisplayName);
  });

  it('opens the gate on approval, and writes the transition', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    const relationshipId = await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const decided = await post(`/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'approve',
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await stateOf(matchId)).toBe('family_approved');

    // ERD §21 invariant 4: the transition carries who acted, in what capacity.
    const events = await harness.raw.query<{
      event: string;
      acted_by_user_id: string | null;
      relationship_id: string | null;
      from_state: string | null;
      to_state: string | null;
    }>(
      `select event, acted_by_user_id, relationship_id, from_state, to_state
         from public.match_events where match_id = $1::uuid and event = 'family_approved'`,
      [matchId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      acted_by_user_id: delegate.userId,
      relationship_id: relationshipId,
      from_state: 'pending_family_review',
      to_state: 'family_approved',
    });
  });

  it('closes the gate on rejection', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const decided = await post(`/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'reject',
      note: 'Not at this time.',
    });
    expect(decided.statusCode).toBe(200);
    expect(await stateOf(matchId)).toBe('family_rejected');
  });

  it('keeps request_more_info on the pending side of the gate', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const asked = await post(`/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'request_more_info',
      note: 'Which city is he in?',
    });
    expect(asked.statusCode).toBe(200);
    // A third outcome that silently behaved like approval would be the worst
    // possible default.
    expect(await stateOf(matchId)).toBe('pending_family_review');

    // And it does not consume the decision — approval still works afterwards.
    const approved = await post(`/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'approve',
    });
    expect(approved.statusCode).toBe(200);
    expect(await stateOf(matchId)).toBe('family_approved');
  });

  it('requires BOTH sides when both households ask for review', async () => {
    const owner = await seedMember('female');
    const ownerDelegate = await seedMember('male');
    const suitor = await seedMember('male');
    const suitorDelegate = await seedMember('female');

    await link(owner, ownerDelegate, 'reviewer');
    await link(suitor, suitorDelegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    await setPolicy(suitor, 'family_reviewed');

    const matchId = await matchUp(suitor, owner);
    expect(await stateOf(matchId)).toBe('pending_family_review');

    // One approval is not enough — the other household has not been heard.
    expect(
      (await post(`/family/reviews/${matchId}/decide`, ownerDelegate.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(200);
    expect(await stateOf(matchId)).toBe('pending_family_review');

    expect(
      (
        await post(`/family/reviews/${matchId}/decide`, suitorDelegate.authId, {
          action: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    expect(await stateOf(matchId)).toBe('family_approved');
  });

  it('refuses a second decision — the first stands (D12 row 4)', async () => {
    const owner = await seedMember('female');
    const first = await seedMember('male');
    const second = await seedMember('female');
    const suitor = await seedMember('male');
    await link(owner, first, 'reviewer');
    await link(owner, second, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    expect(
      (await post(`/family/reviews/${matchId}/decide`, first.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(`/family/reviews/${matchId}/decide`, second.authId, { action: 'reject' }))
        .statusCode,
    ).toBe(409);
    expect(await stateOf(matchId)).toBe('family_approved');
  });

  it('revokes an approval, closing writes without destroying the match', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    await post(`/family/reviews/${matchId}/decide`, delegate.authId, { action: 'approve' });
    const revoked = await post(`/family/reviews/${matchId}/revoke`, delegate.authId, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await stateOf(matchId)).toBe('revoked');

    const rows = await harness.raw.query<{ ended_at: string | null }>(
      `select ended_at from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(rows.rows[0]!.ended_at).toBeNull();
  });

  it('refuses revoking a review that was never approved', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    expect((await post(`/family/reviews/${matchId}/revoke`, delegate.authId, {})).statusCode).toBe(
      409,
    );
  });
});

describe('D12 row 2 — the owner cannot decide their own review', () => {
  it('refuses the owner deciding, through the route', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const attempt = await post(`/family/reviews/${matchId}/decide`, owner.authId, {
      action: 'approve',
    });
    // `can_review_match()` is false for them, so this is not found at all.
    expect(attempt.statusCode).toBe(404);
    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('refuses the COUNTERPART deciding', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    expect(
      (await post(`/family/reviews/${matchId}/decide`, suitor.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(404);
    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('refuses an observer who holds no approve_communication', async () => {
    const owner = await seedMember('female');
    const observer = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, observer, 'observer');
    // The owner needs SOMEONE who can decide, or the match would not gate.
    const reviewer = await seedMember('female');
    await link(owner, reviewer, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    expect(
      (await post(`/family/reviews/${matchId}/decide`, observer.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('revocation is instant, and leaves the review alone', () => {
  it('strips every right on the next request', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    const relationshipId = await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    expect((await get(`/family/reviews/${matchId}`, delegate.authId)).statusCode).toBe(200);

    expect((await del(`/family/members/${relationshipId}`, owner.authId)).statusCode).toBe(204);

    // Next request, not next login.
    expect((await get(`/family/reviews/${matchId}`, delegate.authId)).statusCode).toBe(404);
    expect(
      (await post(`/family/reviews/${matchId}/decide`, delegate.authId, { action: 'approve' }))
        .statusCode,
    ).toBe(404);
  });

  it('leaves an in-flight review PENDING rather than resolving it', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    const relationshipId = await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    await del(`/family/members/${relationshipId}`, owner.authId);

    // Clearing it to approved would let a revocation open a conversation
    // nobody approved; clearing it to rejected would let it close one.
    expect(await stateOf(matchId)).toBe('pending_family_review');
    const rows = await harness.raw.query<{ decision: string }>(
      `select decision from public.family_reviews where match_id = $1::uuid`,
      [matchId],
    );
    expect(rows.rows[0]!.decision).toBe('pending');
  });
});

describe('no directory', () => {
  it('lets a delegate open the match they were asked about', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    const packet = await get(`/family/reviews/${matchId}`, delegate.authId);
    expect(packet.statusCode).toBe(200);
    const body = packet.json() as { counterpart: Record<string, unknown> };
    expect(body.counterpart).toHaveProperty('displayName');
    expect(body.counterpart).toHaveProperty('age');
  });

  it('refuses a match the delegate was never asked about', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    await matchUp(suitor, owner);

    // A completely unrelated pair.
    const x = await seedMember('female');
    const y = await seedMember('male');
    const otherMatch = await matchUp(y, x);

    expect((await get(`/family/reviews/${otherMatch}`, delegate.authId)).statusCode).toBe(404);
  });

  it('never gives the delegate the counterpart’s contact details or exact location', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');

    await harness.raw.query(
      `insert into public.profile_sensitive (user_id, phone_e164, email, employer_name)
       values ($1::uuid, '+923001234567', 'suitor@example.com', 'Acme Corp')
       on conflict (user_id) do update
         set phone_e164 = excluded.phone_e164, email = excluded.email,
             employer_name = excluded.employer_name`,
      [suitor.userId],
    );

    const matchId = await matchUp(suitor, owner);
    const packet = await get(`/family/reviews/${matchId}`, delegate.authId);
    const body = packet.body;

    expect(body).not.toContain('+923001234567');
    expect(body).not.toContain('suitor@example.com');
    expect(body).not.toContain('Acme Corp');
    // Country, yes. City, no.
    expect(body).not.toContain('Lahore');
  });

  it('does not let a delegate read the owner’s other matches', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    // `/matches` is the member's own list, and a delegate is not a
    // participant in their principal's match.
    const theirs = await get('/matches', delegate.authId);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).not.toContain(matchId);
  });
});

describe('the access log is the owner’s', () => {
  it('records the delegate’s read, with the permission that authorised it', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    await get(`/family/reviews/${matchId}`, delegate.authId);

    const log = await get('/family/access-log', owner.authId);
    expect(log.statusCode).toBe(200);
    const items = (log.json() as { items: { action: string; permission: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({
      action: 'review.open',
      permission: 'approve_communication',
    });
  });

  it('shows the delegate nothing of it', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);
    await get(`/family/reviews/${matchId}`, delegate.authId);

    const theirs = await get('/family/access-log', delegate.authId);
    expect(theirs.statusCode).toBe(200);
    expect((theirs.json() as { items: unknown[] }).items).toEqual([]);
  });
});

describe('D12-g — the stalled review warning', () => {
  it('warns the owner once, and changes no decision', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    const matchId = await matchUp(suitor, owner);

    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '73 hours'
        where match_id = $1::uuid`,
      [matchId],
    );

    const first = await get('/family/my-reviews', owner.authId);
    expect(first.statusCode).toBe(200);
    const items = (first.json() as { items: { overdue: boolean }[] }).items;
    expect(items[0]!.overdue).toBe(true);

    const countWarnings = async (): Promise<number> => {
      const rows = await harness.raw.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where user_id = $1::uuid and type = 'family_review_stalled'`,
        [owner.userId],
      );
      return Number.parseInt(rows.rows[0]!.n, 10);
    };

    expect(await countWarnings()).toBe(1);

    // Twice more. `sla_notified_at` is what keeps it at one.
    await get('/family/my-reviews', owner.authId);
    await get('/family/my-reviews', owner.authId);
    expect(await countWarnings()).toBe(1);

    // And the review is untouched: silence is not consent.
    expect(await stateOf(matchId)).toBe('pending_family_review');
  });

  it('does not warn before the SLA has elapsed', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');
    await setPolicy(owner, 'family_reviewed');
    await matchUp(suitor, owner);

    await get('/family/my-reviews', owner.authId);
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where user_id = $1::uuid and type = 'family_review_stalled'`,
      [owner.userId],
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(0);
  });
});

describe('the owner keeps their own gate', () => {
  it('reports how many delegates can actually decide', async () => {
    const owner = await seedMember('female');
    const before = await get('/me', owner.authId);
    expect((before.json() as { familyReviewersCount: number }).familyReviewersCount).toBe(0);

    const delegate = await seedMember('male');
    await link(owner, delegate, 'reviewer');

    const after = await get('/me', owner.authId);
    // Zero while the policy is family_reviewed means every new match stalls,
    // which the app has to be able to say at the moment the policy is set.
    expect((after.json() as { familyReviewersCount: number }).familyReviewersCount).toBe(1);
  });

  it('never retroactively re-gates a live match', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await link(owner, delegate, 'reviewer');

    // Matched while the policy was `direct`.
    const matchId = await matchUp(suitor, owner);
    expect(await stateOf(matchId)).toBe('open');

    await setPolicy(owner, 'family_reviewed');

    // Silently freezing a running conversation from a settings toggle is
    // indistinguishable from a bug, and — under pressure at home —
    // indistinguishable from a punishment.
    expect(await stateOf(matchId)).toBe('open');
  });

  it('lets the owner turn the gate back off', async () => {
    const owner = await seedMember('female');
    await setPolicy(owner, 'family_reviewed');
    expect(
      ((await get('/me', owner.authId)).json() as { communicationPolicy: string })
        .communicationPolicy,
    ).toBe('family_reviewed');

    // The policy is the owner's and reversible by them. That is the first of
    // R16's four controls.
    expect((await setPolicy(owner, 'direct')).statusCode).toBe(200);
    expect(
      ((await get('/me', owner.authId)).json() as { communicationPolicy: string })
        .communicationPolicy,
    ).toBe('direct');
  });
});
