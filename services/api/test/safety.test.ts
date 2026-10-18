import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/discovery/candidates';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Blocking and reporting, through the real routes.
 *
 * The interesting part of a block is not the row — `blocks` and
 * `app.is_blocked()` have existed since migration 0011 and are already
 * covered by the RLS suite. It is everything that must become true the moment
 * the row appears: the pair vanish from each other's discovery, interests and
 * matches, in BOTH directions, and neither can tell which of them did it.
 *
 * And everything that must NOT happen: the match survives, either side can
 * still leave it, and the blocked party learns nothing.
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

const block = (member: Member, targetUserId: string, reasonCode?: string) =>
  harness.app.inject({
    method: 'PUT',
    url: `/blocks/${targetUserId}`,
    headers: authHeader(member.authId),
    payload: reasonCode === undefined ? {} : { reasonCode },
  });

const unblock = (member: Member, targetUserId: string) =>
  harness.app.inject({
    method: 'DELETE',
    url: `/blocks/${targetUserId}`,
    headers: authHeader(member.authId),
  });

const get = (url: string, auth?: string) =>
  harness.app.inject({ method: 'GET', url, ...(auth ? { headers: authHeader(auth) } : {}) });

const report = (member: Member, payload: Record<string, unknown>) =>
  harness.app.inject({
    method: 'POST',
    url: '/reports',
    headers: authHeader(member.authId),
    payload,
  });

const sendInterest = (sender: Member, recipientUserId: string) =>
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

const blockRows = async (blockerUserId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.blocks where blocker_user_id = $1::uuid`,
    [blockerUserId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const relationship = async (a: string, b: string): Promise<string> => {
  const rows = await harness.raw.query<{ v: string }>(
    `select app.relationship($1::uuid, $2::uuid) as v`,
    [a, b],
  );
  return rows.rows[0]!.v;
};

/** A matched pair, through the real interest flow. */
async function matched(): Promise<{ alice: Member; bilal: Member; matchId: string }> {
  const alice = await seedMember('female');
  const bilal = await seedMember('male');
  const interestId = (await sendInterest(alice, bilal.userId)).json().id as string;
  const matchId = (await respond(bilal, interestId, 'accept')).json().match.id as string;
  return { alice, bilal, matchId };
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
// PUT /blocks/:userId
// ---------------------------------------------------------------------------

describe('PUT /blocks/:userId', () => {
  it('blocks a member and answers 204', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    expect((await block(alice, bilal.userId)).statusCode).toBe(204);
    expect(await blockRows(alice.userId)).toBe(1);
  });

  it('records the optional reason code', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId, 'harassment');

    const rows = await harness.raw.query<{ reason_code: string | null }>(
      `select reason_code from public.blocks where blocker_user_id = $1::uuid`,
      [alice.userId],
    );
    expect(rows.rows[0]!.reason_code).toBe('harassment');
  });

  it('is idempotent — a repeat answers 204 and writes no second row', async () => {
    // A double tap must not look like a failure at the moment someone is
    // trying to get away from another person.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    expect((await block(alice, bilal.userId)).statusCode).toBe(204);
    expect((await block(alice, bilal.userId)).statusCode).toBe(204);
    expect((await block(alice, bilal.userId)).statusCode).toBe(204);
    expect(await blockRows(alice.userId)).toBe(1);
  });

  it('refuses a malformed user id', async () => {
    const alice = await seedMember('female');
    expect((await block(alice, 'nope')).statusCode).toBe(400);
  });

  it('refuses an invalid reason code shape', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    expect((await block(alice, bilal.userId, 'Not A Code!')).statusCode).toBe(400);
    expect(await blockRows(alice.userId)).toBe(0);
  });

  it('refuses a self-block as not-found', async () => {
    // Not 400: the caller learns nothing from the distinction, and the
    // database refuses it regardless (blocks_not_self).
    const alice = await seedMember('female');
    expect((await block(alice, alice.userId)).statusCode).toBe(404);
    expect(await blockRows(alice.userId)).toBe(0);
  });

  it('404s a user who does not exist', async () => {
    const alice = await seedMember('female');
    expect((await block(alice, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const bilal = await seedMember('male');
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/blocks/${bilal.userId}`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// What a block actually does
// ---------------------------------------------------------------------------

describe('a block takes effect in both directions', () => {
  it('reports `blocked` from both sides', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');
    // The direction the blocked party is on. One-directional checking is
    // called out in ERD §2.3 as the most likely policy bug in the schema.
    expect(await relationship(bilal.userId, alice.userId)).toBe('blocked');
  });

  it('hides each from the other in discovery', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    // Candidates FIRST, and asserted present before the block. Discovery
    // serves precomputed `match_candidates`, so a test that only checks
    // absence afterwards passes on an empty feed and proves nothing.
    await generateCandidates(harness.db, alice.userId);
    await generateCandidates(harness.db, bilal.userId);

    const idsFor = async (viewer: Member): Promise<string[]> => {
      const response = await get('/discovery/sections/recommended', viewer.authId);
      expect(response.statusCode).toBe(200);
      return (response.json().items as Array<{ userId: string }>).map((i) => i.userId);
    };

    expect(await idsFor(alice)).toContain(bilal.userId);
    expect(await idsFor(bilal)).toContain(alice.userId);

    await block(alice, bilal.userId);

    // Both directions, against the SAME precomputed rows — the candidate set
    // is a snapshot and the read has to re-apply the block rather than wait
    // for regeneration.
    expect(await idsFor(alice)).not.toContain(bilal.userId);
    expect(await idsFor(bilal)).not.toContain(alice.userId);
  });

  it('keeps the pair apart after candidates are regenerated', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    // The other half: a fresh generation must not reintroduce them either.
    await generateCandidates(harness.db, alice.userId);
    await generateCandidates(harness.db, bilal.userId);

    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.match_candidates
        where (user_id = $1::uuid and candidate_user_id = $2::uuid)
           or (user_id = $2::uuid and candidate_user_id = $1::uuid)`,
      [alice.userId, bilal.userId],
    );
    expect(rows.rows[0]!.n).toBe('0');
  });

  it('stops a new interest in either direction, as a 404', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    // The blocker.
    expect((await sendInterest(alice, bilal.userId)).statusCode).toBe(404);
    // And the blocked party, who must not be able to tell a block from a
    // deleted account.
    const response = await sendInterest(bilal, alice.userId);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('outranks a pending interest', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await sendInterest(alice, bilal.userId);
    expect(await relationship(alice.userId, bilal.userId)).toBe('interest_pending');

    await block(alice, bilal.userId);
    expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');
  });

  it('stops the recipient accepting an interest sent before the block', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const interestId = (await sendInterest(alice, bilal.userId)).json().id as string;

    await block(alice, bilal.userId);
    expect((await respond(bilal, interestId, 'accept')).statusCode).toBe(404);
  });

  it('drops the counterpart card from a pre-existing interest without hiding the row', async () => {
    // The member is still entitled to know they sent it; they are not
    // entitled to the card. A vanished interest with no explanation would be
    // worse than a card they cannot see.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await sendInterest(alice, bilal.userId);
    await block(bilal, alice.userId);

    const items = (await get('/interests?direction=sent', alice.authId)).json().items as Array<{
      counterpart: unknown;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.counterpart).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blocking a match — history survives, nobody is trapped
// ---------------------------------------------------------------------------

describe('blocking someone you matched with', () => {
  it('outranks `match`', async () => {
    const { alice, bilal } = await matched();
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');

    await block(alice, bilal.userId);
    expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');
    expect(await relationship(bilal.userId, alice.userId)).toBe('blocked');
  });

  it('does NOT delete or end the match', async () => {
    // Preserving history is the requirement. Ending it here would also take
    // the decision to unmatch away from the other party, who has been told
    // nothing.
    const { alice, bilal, matchId } = await matched();
    await block(alice, bilal.userId);

    const rows = await harness.raw.query<{ ended_at: string | null; n: string }>(
      `select ended_at, count(*) over ()::text as n from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.ended_at).toBeNull();
    expect(bilal.userId).toBeTruthy();
  });

  it('leaves communication_state untouched', async () => {
    // ERD §21 lists `blocked` as reachable from every state and exiting to
    // none, so writing it would make an unblock permanently un-writable. That
    // decision belongs to the slice that can act on it.
    const { alice, bilal, matchId } = await matched();
    await block(alice, bilal.userId);

    const rows = await harness.raw.query<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(rows.rows[0]!.communication_state).toBe('open');
  });

  it('still lets the BLOCKER leave the match', async () => {
    const { alice, bilal, matchId } = await matched();
    await block(alice, bilal.userId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/matches/${matchId}/unmatch`,
      headers: authHeader(alice.authId),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(bilal.userId).toBeTruthy();
  });

  it('still lets the BLOCKED party leave the match', async () => {
    // The worst possible interaction between the two features would be a
    // block that traps someone in a match they want out of.
    const { alice, bilal, matchId } = await matched();
    await block(alice, bilal.userId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/matches/${matchId}/unmatch`,
      headers: authHeader(bilal.authId),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// GET /blocks and DELETE /blocks/:userId
// ---------------------------------------------------------------------------

describe('GET /blocks', () => {
  it('lists who the caller blocked, with their name', async () => {
    // The name matters: a list of bare uuids cannot be acted on, so a block
    // you cannot identify is a block you cannot undo.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    const response = await get('/blocks', alice.authId);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ userId: string; displayName: string | null }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.userId).toBe(bilal.userId);
    expect(items[0]!.displayName).toBeTruthy();
  });

  it('is empty for the blocked party — the reverse direction is never listed', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    expect((await get('/blocks', bilal.authId)).json().items).toEqual([]);
  });

  it('shows one member nothing of another member’s blocks', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const chloe = await seedMember('female');
    await block(alice, bilal.userId);

    expect((await get('/blocks', chloe.authId)).json().items).toEqual([]);
  });

  it('refuses an anonymous request', async () => {
    expect((await get('/blocks')).statusCode).toBe(401);
  });

  it('pages without gaps or repeats', async () => {
    const alice = await seedMember('female');
    const targets: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const target = await seedMember('male');
      targets.push(target.userId);
      await block(alice, target.userId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url: string = `/blocks?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await get(url, alice.authId)).json() as {
        items: Array<{ userId: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      seen.push(...body.items.map((i) => i.userId));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...targets].sort());
  });

  it('rejects a malformed cursor', async () => {
    const alice = await seedMember('female');
    expect((await get('/blocks?cursor=notacursor', alice.authId)).statusCode).toBe(400);
  });
});

describe('DELETE /blocks/:userId', () => {
  it('unblocks and restores visibility both ways', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);
    expect(await relationship(alice.userId, bilal.userId)).toBe('blocked');

    expect((await unblock(alice, bilal.userId)).statusCode).toBe(204);
    expect(await relationship(alice.userId, bilal.userId)).toBe('stranger');
    expect(await relationship(bilal.userId, alice.userId)).toBe('stranger');
    expect(await blockRows(alice.userId)).toBe(0);
  });

  it('works even though the blocked member is invisible to the caller', async () => {
    // The mirror of the shortlist delete: requiring the target to be visible
    // in order to undo the block would make every block permanent.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    const visible = await harness.raw.query<{ ok: boolean }>(
      `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
      [alice.userId, bilal.userId],
    );
    expect(visible.rows[0]!.ok).toBe(false);
    expect((await unblock(alice, bilal.userId)).statusCode).toBe(204);
  });

  it('is idempotent and answers 204 for a block that never existed', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    expect((await unblock(alice, bilal.userId)).statusCode).toBe(204);
    await block(alice, bilal.userId);
    expect((await unblock(alice, bilal.userId)).statusCode).toBe(204);
    expect((await unblock(alice, bilal.userId)).statusCode).toBe(204);
  });

  it('cannot clear someone else’s block', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const chloe = await seedMember('female');
    await block(alice, bilal.userId);

    // 204 — the caller is told nothing, and nothing happens.
    expect((await unblock(chloe, bilal.userId)).statusCode).toBe(204);
    expect(await blockRows(alice.userId)).toBe(1);
  });

  it('refuses a malformed user id', async () => {
    const alice = await seedMember('female');
    expect((await unblock(alice, 'nope')).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /reports
// ---------------------------------------------------------------------------

describe('POST /reports', () => {
  it('files a report and returns it', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    const response = await report(alice, {
      reportedUserId: bilal.userId,
      category: 'harassment',
      description: 'Repeated unwanted messages in interest notes.',
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.category).toBe('harassment');
    expect(body.status).toBe('open');
    expect(body.outcomeKey).toBeNull();
    expect(body.resolvedAt).toBeNull();
    expect(body.id).toBeTruthy();
  });

  it.each([
    'scam',
    'harassment',
    'impersonation',
    'fake_profile',
    'inappropriate_content',
    'misrepresented_status',
    'other',
  ])('accepts the contract category %s', async (category) => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    expect((await report(alice, { reportedUserId: bilal.userId, category })).statusCode).toBe(201);
  });

  it.each(['underage', 'inappropriate_photos', 'scam_financial', 'spam', ''])(
    'rejects the non-contract category %s',
    async (category) => {
      // `underage` in particular is NOT in the contract enum, which is raised
      // as a product decision rather than silently mapped onto `other`.
      const alice = await seedMember('female');
      const bilal = await seedMember('male');
      expect((await report(alice, { reportedUserId: bilal.userId, category })).statusCode).toBe(
        400,
      );
    },
  );

  it('rejects a missing category and a missing target', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    expect((await report(alice, { reportedUserId: bilal.userId })).statusCode).toBe(400);
    expect((await report(alice, { category: 'scam' })).statusCode).toBe(400);
  });

  it('rejects a description over 2000 characters', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const response = await report(alice, {
      reportedUserId: bilal.userId,
      category: 'other',
      description: 'x'.repeat(2001),
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a self-report', async () => {
    const alice = await seedMember('female');
    const response = await report(alice, { reportedUserId: alice.userId, category: 'scam' });
    expect(response.statusCode).toBe(404);

    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.reports where reporter_user_id = $1::uuid`,
      [alice.userId],
    );
    expect(rows.rows[0]!.n).toBe('0');
  });

  it('404s a member who does not exist', async () => {
    const alice = await seedMember('female');
    const response = await report(alice, {
      reportedUserId: '00000000-0000-0000-0000-000000000000',
      category: 'scam',
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const bilal = await seedMember('male');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/reports',
      payload: { reportedUserId: bilal.userId, category: 'scam' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 409 for a second open report about the same member', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    expect(
      (await report(alice, { reportedUserId: bilal.userId, category: 'scam' })).statusCode,
    ).toBe(201);
    const second = await report(alice, { reportedUserId: bilal.userId, category: 'harassment' });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('conflict');
  });

  it('allows a second report once the first is resolved', async () => {
    // The partial index exists so that someone whose first report was
    // dismissed is not silenced when the same person harasses them again.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await report(alice, { reportedUserId: bilal.userId, category: 'scam' });

    await harness.raw.query(
      `update public.reports set status = 'dismissed', resolved_at = now()
        where reporter_user_id = $1::uuid`,
      [alice.userId],
    );

    const again = await report(alice, { reportedUserId: bilal.userId, category: 'harassment' });
    expect(again.statusCode).toBe(201);
  });

  it('lets two different members report the same person', async () => {
    const alice = await seedMember('female');
    const chloe = await seedMember('female');
    const bilal = await seedMember('male');

    expect(
      (await report(alice, { reportedUserId: bilal.userId, category: 'scam' })).statusCode,
    ).toBe(201);
    expect(
      (await report(chloe, { reportedUserId: bilal.userId, category: 'scam' })).statusCode,
    ).toBe(201);
  });

  it('still works after the reporter has blocked the member', async () => {
    // Block-then-report is the most likely sequence in the whole feature, and
    // a block makes the target invisible — so the caller's own block must not
    // be a reason to refuse.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(alice, bilal.userId);

    const response = await report(alice, {
      reportedUserId: bilal.userId,
      category: 'harassment',
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses a report about someone who blocked the caller', async () => {
    // Indistinguishable from an account that does not exist.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await block(bilal, alice.userId);

    const response = await report(alice, { reportedUserId: bilal.userId, category: 'scam' });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Report privacy
// ---------------------------------------------------------------------------

describe('reports are invisible to the reported member', () => {
  it('does not appear in the reported member’s own list', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await report(alice, { reportedUserId: bilal.userId, category: 'scam' });

    expect((await get('/me/reports', bilal.authId)).json().items).toEqual([]);
  });

  it('is unreachable through RLS even by direct query', async () => {
    // The route could be bypassed; the policy cannot. `reports` has exactly
    // one SELECT policy and it names the reporter.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await report(alice, { reportedUserId: bilal.userId, category: 'scam' });

    const rows = await harness.db.asUser(bilal.authId, (session) =>
      session.query(`select id from public.reports`),
    );
    expect(rows).toEqual([]);
  });

  it('is not member-writable at all', async () => {
    // `status` and `outcome_key` belong to the moderation pipeline. A member
    // who could insert directly could file a report pre-dismissed.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    await expect(
      harness.db.asUser(alice.authId, (session) =>
        session.query(
          `insert into public.reports (reporter_user_id, reported_user_id, category, status)
           values (app.current_user_id(), $1::uuid, 'scam', 'dismissed')`,
          [bilal.userId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('returns no description or target to the reporter either', async () => {
    // The contract's Report schema carries neither, and the reporter is told
    // the outcome rather than what happened to another person's account.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await report(alice, {
      reportedUserId: bilal.userId,
      category: 'scam',
      description: 'secret-detail-should-not-come-back',
    });

    const response = await get('/me/reports', alice.authId);
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain('secret-detail-should-not-come-back');
    expect(response.payload).not.toContain(bilal.userId);
  });
});

describe('GET /me/reports', () => {
  it('lists the caller’s own reports, newest first', async () => {
    const alice = await seedMember('female');
    const first = await seedMember('male');
    const second = await seedMember('male');
    await report(alice, { reportedUserId: first.userId, category: 'scam' });
    await report(alice, { reportedUserId: second.userId, category: 'harassment' });

    const items = (await get('/me/reports', alice.authId)).json().items as Array<{
      category: string;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.category).toBe('harassment');
  });

  it('surfaces the outcome once a moderator has set one', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await report(alice, { reportedUserId: bilal.userId, category: 'scam' });

    await harness.raw.query(
      `update public.reports
          set status = 'actioned', outcome_key = 'report.outcome.actioned', resolved_at = now()
        where reporter_user_id = $1::uuid`,
      [alice.userId],
    );

    const items = (await get('/me/reports', alice.authId)).json().items as Array<{
      status: string;
      outcomeKey: string | null;
      resolvedAt: string | null;
    }>;
    expect(items[0]!.status).toBe('actioned');
    expect(items[0]!.outcomeKey).toBe('report.outcome.actioned');
    expect(items[0]!.resolvedAt).not.toBeNull();
  });

  it('refuses an anonymous request', async () => {
    expect((await get('/me/reports')).statusCode).toBe(401);
  });
});
