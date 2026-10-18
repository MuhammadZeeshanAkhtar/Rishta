import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Match creation (verified) and unmatching (new).
 *
 * The interesting part of ending a match is not the ending — it is everything
 * that must stay true afterwards: one row per pair, a relationship that
 * actually clears, both sides seeing the same thing, and a path back if the
 * two of them change their minds.
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

const unmatch = (member: Member, matchId: string, reason?: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/matches/${matchId}/unmatch`,
    headers: authHeader(member.authId),
    payload: reason === undefined ? {} : { reason },
  });

const get = (url: string, auth?: string) =>
  harness.app.inject({ method: 'GET', url, ...(auth ? { headers: authHeader(auth) } : {}) });

const relationship = async (a: string, b: string): Promise<string> => {
  const rows = await harness.raw.query<{ v: string }>(
    `select app.relationship($1::uuid, $2::uuid) as v`,
    [a, b],
  );
  return rows.rows[0]!.v;
};

const matchRow = async (matchId: string) => {
  const rows = await harness.raw.query<{
    ended_at: string | null;
    ended_by_user_id: string | null;
    end_reason: string | null;
    communication_state: string;
  }>(
    `select ended_at, ended_by_user_id, end_reason, communication_state
       from public.matches where id = $1::uuid`,
    [matchId],
  );
  return rows.rows[0]!;
};

const matchEvents = async (matchId: string) => {
  const rows = await harness.raw.query<{ event: string; actor_user_id: string }>(
    `select event, actor_user_id from public.match_events
      where match_id = $1::uuid order by created_at, event`,
    [matchId],
  );
  return rows.rows;
};

const matchCount = async (a: string, b: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.matches
      where user_a_id = least($1::uuid, $2::uuid)
        and user_b_id = greatest($1::uuid, $2::uuid)`,
    [a, b],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

async function matched(): Promise<{ alice: Member; bilal: Member; matchId: string }> {
  const alice = await seedMember('female');
  const bilal = await seedMember('male');
  const interestId = (await send(alice, bilal.userId)).json().id as string;
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
// Match creation — verified, not rebuilt
// ---------------------------------------------------------------------------

describe('match creation (existing flow)', () => {
  it('creates exactly one match on acceptance', async () => {
    const { alice, bilal, matchId } = await matched();
    expect(matchId).toBeTruthy();
    expect(await matchCount(alice.userId, bilal.userId)).toBe(1);
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');
  });

  it('is idempotent under a repeated acceptance', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const interestId = (await send(alice, bilal.userId)).json().id as string;

    expect((await respond(bilal, interestId, 'accept')).statusCode).toBe(200);
    expect((await respond(bilal, interestId, 'accept')).statusCode).toBe(409);
    expect(await matchCount(alice.userId, bilal.userId)).toBe(1);
  });

  it('creates one match when both sides accept crossing interests at once', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const aToB = (await send(alice, bilal.userId)).json().id as string;
    const bToA = (await send(bilal, alice.userId)).json().id as string;

    const [first, second] = await Promise.all([
      respond(bilal, aToB, 'accept'),
      respond(alice, bToA, 'accept'),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().match.id).toBe(second.json().match.id);
    expect(await matchCount(alice.userId, bilal.userId)).toBe(1);
  });

  it('is visible to both participants', async () => {
    const { alice, bilal, matchId } = await matched();
    for (const member of [alice, bilal]) {
      expect((await get(`/matches/${matchId}`, member.authId)).statusCode, member.userId).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Unmatch
// ---------------------------------------------------------------------------

describe('POST /matches/:matchId/unmatch', () => {
  it('ends the match and answers 204', async () => {
    const { alice, matchId } = await matched();
    expect((await unmatch(alice, matchId)).statusCode).toBe(204);

    const row = await matchRow(matchId);
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by_user_id).toBe(alice.userId);
  });

  it('records the optional reason', async () => {
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId, 'Not the right time');
    expect((await matchRow(matchId)).end_reason).toBe('Not the right time');
  });

  it('works with no body at all', async () => {
    const { alice, matchId } = await matched();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/matches/${matchId}/unmatch`,
      headers: authHeader(alice.authId),
    });
    expect(response.statusCode).toBe(204);
    expect((await matchRow(matchId)).end_reason).toBeNull();
  });

  it('refuses an over-long reason', async () => {
    const { alice, matchId } = await matched();
    expect((await unmatch(alice, matchId, 'x'.repeat(301))).statusCode).toBe(400);
    expect((await matchRow(matchId)).ended_at).toBeNull();
  });

  it('leaves the communication state alone', async () => {
    // Ending is the member's decision about the relationship; the gate is the
    // family's decision about writing. Conflating them would make an unmatch
    // look like a family rejection in the event log.
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId);
    expect((await matchRow(matchId)).communication_state).toBe('open');
  });

  it('writes one `ended` event carrying the state at the time', async () => {
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId);

    const events = await matchEvents(matchId);
    expect(events.map((e) => e.event)).toEqual(['created', 'ended']);
    expect(events[1]!.actor_user_id).toBe(alice.userId);

    const rows = await harness.raw.query<{ from_state: string | null }>(
      `select from_state from public.match_events
        where match_id = $1::uuid and event = 'ended'`,
      [matchId],
    );
    expect(rows.rows[0]!.from_state).toBe('open');
  });

  it('either participant may end it', async () => {
    // Not just the one who accepted.
    const { bilal, matchId } = await matched();
    expect((await unmatch(bilal, matchId)).statusCode).toBe(204);
    expect((await matchRow(matchId)).ended_by_user_id).toBe(bilal.userId);
  });
});

describe('unmatch — who may not', () => {
  it('refuses an anonymous request', async () => {
    const { matchId } = await matched();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/matches/${matchId}/unmatch`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a non-participant, indistinguishably from absent', async () => {
    const { matchId } = await matched();
    const other = await seedMember('male');

    const response = await unmatch(other, matchId);
    // 404 not 403: a 403 would confirm the match exists.
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
    expect((await matchRow(matchId)).ended_at).toBeNull();
  });

  it('404s a match that does not exist, and 400s a malformed id', async () => {
    const member = await seedMember('male');
    expect((await unmatch(member, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await unmatch(member, 'nope')).statusCode).toBe(400);
  });

  it('still lets a participant end a match after being blocked', async () => {
    // A block must not trap someone in a match they want out of — that would
    // be the worst possible interaction between the two features.
    const { alice, bilal, matchId } = await matched();
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [bilal.userId, alice.userId],
    );
    expect((await unmatch(alice, matchId)).statusCode).toBe(204);
    expect((await matchRow(matchId)).ended_at).not.toBeNull();
  });
});

describe('unmatch — idempotency and concurrency', () => {
  it('is idempotent: a repeat answers 204 and changes nothing', async () => {
    // The contract defines 204/401/404 and no conflict, so ending something
    // already ended is the state the caller asked for.
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId);
    const first = await matchRow(matchId);

    expect((await unmatch(alice, matchId)).statusCode).toBe(204);
    expect((await unmatch(alice, matchId)).statusCode).toBe(204);

    const after = await matchRow(matchId);
    // `toEqual`, not `toBe`: the driver returns a fresh Date object each read,
    // so identity comparison would fail on two equal timestamps.
    expect(after.ended_at).toEqual(first.ended_at);
    expect(after.ended_by_user_id).toBe(first.ended_by_user_id);
  });

  it('writes no second `ended` event on a repeat', async () => {
    // The audit trail should show one ending, not one per retry.
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId);
    await unmatch(alice, matchId);
    await unmatch(alice, matchId);
    expect((await matchEvents(matchId)).filter((e) => e.event === 'ended')).toHaveLength(1);
  });

  it('records one ending when both participants unmatch at once', async () => {
    const { alice, bilal, matchId } = await matched();
    const responses = await Promise.all([unmatch(alice, matchId), unmatch(bilal, matchId)]);

    expect(responses.every((r) => r.statusCode === 204)).toBe(true);
    expect((await matchEvents(matchId)).filter((e) => e.event === 'ended')).toHaveLength(1);
    // And whoever won is recorded — one of them, not both, not neither.
    const row = await matchRow(matchId);
    expect([alice.userId, bilal.userId]).toContain(row.ended_by_user_id);
  });

  it('does not reopen an ended match', async () => {
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);
    await unmatch(bilal, matchId);
    expect((await matchRow(matchId)).ended_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What both sides see afterwards
// ---------------------------------------------------------------------------

describe('after unmatching', () => {
  it('clears the relationship for both participants', async () => {
    const { alice, bilal, matchId } = await matched();
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');

    await unmatch(alice, matchId);
    // The accepted interest is no longer pending either, so they fall all the
    // way back to strangers — no invented "unmatched" state.
    expect(await relationship(alice.userId, bilal.userId)).toBe('stranger');
    expect(await relationship(bilal.userId, alice.userId)).toBe('stranger');
  });

  it('drops out of both active match lists', async () => {
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);

    for (const member of [alice, bilal]) {
      const ids = (
        (await get('/matches', member.authId)).json().items as Array<{ id: string }>
      ).map((m) => m.id);
      expect(ids, member.userId).not.toContain(matchId);
    }
  });

  it('is still readable in detail by both, showing endedAt', async () => {
    // Both participants must see the correct post-unmatch state, and the one
    // who did not end it needs to be able to find out that it ended.
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);

    for (const member of [alice, bilal]) {
      const response = await get(`/matches/${matchId}`, member.authId);
      expect(response.statusCode, member.userId).toBe(200);
      expect(response.json().endedAt, member.userId).not.toBeNull();
    }
  });

  it('keeps the match hidden from non-participants', async () => {
    const { alice, matchId } = await matched();
    const other = await seedMember('male');
    await unmatch(alice, matchId);
    expect((await get(`/matches/${matchId}`, other.authId)).statusCode).toBe(404);
  });

  it('leaves the accepted interest accepted', async () => {
    // Unmatching ends the match, not the history of what was agreed.
    const { alice, matchId } = await matched();
    await unmatch(alice, matchId);

    const item = (await get('/interests?direction=sent', alice.authId)).json().items[0];
    expect(item.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Coming back
// ---------------------------------------------------------------------------

describe('a pair who unmatch and return', () => {
  it('reuses the one row rather than creating a second', async () => {
    // `matches_pair_key` is unique over the unordered pair with no partial
    // clause, so there is one row per pair forever. A fresh interest the other
    // way round reaches the accept path again, and the row must come back to
    // life rather than be returned ended.
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);
    expect(await relationship(alice.userId, bilal.userId)).toBe('stranger');

    // Bilal now asks Alice — a different sender/recipient ordering, so the
    // interests index permits it.
    const fresh = (await send(bilal, alice.userId)).json().id as string;
    const response = await respond(alice, fresh, 'accept');

    expect(response.statusCode).toBe(200);
    expect(response.json().match).not.toBeNull();
    expect(response.json().match.id).toBe(matchId);
    expect(await matchCount(alice.userId, bilal.userId)).toBe(1);
  });

  it('reports match again, not stranger', async () => {
    // The bug this guards: returning the ended row would report a successful
    // acceptance while the relationship said stranger.
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);

    const fresh = (await send(bilal, alice.userId)).json().id as string;
    await respond(alice, fresh, 'accept');

    expect(await relationship(alice.userId, bilal.userId)).toBe('match');
    expect((await matchRow(matchId)).ended_at).toBeNull();
    expect((await matchRow(matchId)).end_reason).toBeNull();
  });

  it('reappears in both active match lists', async () => {
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);
    const fresh = (await send(bilal, alice.userId)).json().id as string;
    await respond(alice, fresh, 'accept');

    for (const member of [alice, bilal]) {
      const ids = (
        (await get('/matches', member.authId)).json().items as Array<{ id: string }>
      ).map((m) => m.id);
      expect(ids, member.userId).toContain(matchId);
    }
  });

  it('leaves an event log that reads created, ended, created', async () => {
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);
    const fresh = (await send(bilal, alice.userId)).json().id as string;
    await respond(alice, fresh, 'accept');

    expect((await matchEvents(matchId)).map((e) => e.event).sort()).toEqual([
      'created',
      'created',
      'ended',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('nothing else is touched', () => {
  it('moves no quota', async () => {
    const { alice, matchId } = await matched();
    const used = async (userId: string): Promise<number> => {
      const rows = await harness.raw.query<{ count: number }>(
        `select count from public.usage_counters
          where user_id = $1::uuid and period_start = current_date`,
        [userId],
      );
      return rows.rows[0]?.count ?? 0;
    };
    const before = await used(alice.userId);
    await unmatch(alice, matchId);
    expect(await used(alice.userId)).toBe(before);
  });

  it('creates no conversation', async () => {
    // Notifications arrived in Slice 5, so that half is superseded — and
    // unmatching still writes none of them, which notifications.test.ts pins.
    // Conversations remain the chat slice's.
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name in ('conversations', 'messages')`,
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(0);
  });

  it('exposes no family-review surface', async () => {
    const { alice, matchId } = await matched();
    for (const [method, url] of [
      ['GET', `/matches/${matchId}/family-review`],
      ['POST', `/matches/${matchId}/family-review`],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: authHeader(alice.authId),
        payload: {},
      });
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});
