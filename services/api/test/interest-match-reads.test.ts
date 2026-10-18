import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Interest and match READ APIs.
 *
 * Three things are worth proving here and the happy path is the least of them:
 *
 *   * **Whose rows are these.** Every list is confined by RLS rather than by a
 *     handler check, so the tests go at it from the wrong account.
 *   * **What a card discloses.** Interests and matches serve the SAME card
 *     discovery does — one serializer, so one set of privacy rules.
 *   * **Reads change nothing.** No quota, no state, no events, no matches.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(
  gender: 'male' | 'female',
  overrides: { cityName?: string; locationPrecision?: string } = {},
): Promise<Member> {
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
     values ($1::uuid, 'pk', $2::text)`,
    [userId, overrides.cityName ?? 'Lahore'],
  );
  if (overrides.locationPrecision) {
    await harness.raw.query(
      `insert into public.profile_field_visibility (user_id, field_key, visibility)
       values ($1::uuid, 'location_precision', $2::text)`,
      [userId, overrides.locationPrecision],
    );
  }
  return { userId, authId };
}

const get = (url: string, auth?: string) =>
  harness.app.inject({ method: 'GET', url, ...(auth ? { headers: authHeader(auth) } : {}) });

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

const relationship = async (a: string, b: string): Promise<string> => {
  const rows = await harness.raw.query<{ v: string }>(
    `select app.relationship($1::uuid, $2::uuid) as v`,
    [a, b],
  );
  return rows.rows[0]!.v;
};

/** A matched pair, plus the interest that made them. */
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
// Interest reads
// ---------------------------------------------------------------------------

describe('GET /interests', () => {
  it('lists outgoing interests with a counterpart card', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const body = (await get('/interests?direction=sent', sender.authId)).json();
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.direction).toBe('sent');
    expect(item.status).toBe('pending');
    expect(item.counterpart.userId).toBe(recipient.userId);
    expect(item.counterpart.displayName).toBeTruthy();
    expect(item.counterpart.age).toBeTypeOf('number');
  });

  it('lists incoming interests from the other side', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const body = (await get('/interests?direction=received', recipient.authId)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].direction).toBe('received');
    expect(body.items[0].counterpart.userId).toBe(sender.userId);
  });

  it('shows an uninvolved member nothing', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    await send(sender, recipient.userId);

    expect((await get('/interests?direction=received', other.authId)).json().items).toEqual([]);
    expect((await get('/interests?direction=sent', other.authId)).json().items).toEqual([]);
  });

  it('refuses an anonymous request', async () => {
    expect((await get('/interests?direction=sent')).statusCode).toBe(401);
  });

  it('requires a direction', async () => {
    const member = await seedMember('male');
    expect((await get('/interests', member.authId)).statusCode).toBe(400);
  });

  it('filters by a contract status and refuses one outside the enum', async () => {
    const sender = await seedMember('male');
    const a = await seedMember('female');
    const b = await seedMember('female');
    const first = (await send(sender, a.userId)).json().id as string;
    await send(sender, b.userId);
    await respond(a, first, 'decline');

    const pending = (await get('/interests?direction=sent&status=pending', sender.authId)).json();
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0].counterpart.userId).toBe(b.userId);

    const declined = (await get('/interests?direction=sent&status=declined', sender.authId)).json();
    expect(declined.items).toHaveLength(1);
    expect(declined.items[0].counterpart.userId).toBe(a.userId);

    expect((await get('/interests?direction=sent&status=ghosted', sender.authId)).statusCode).toBe(
      400,
    );
  });

  it('keeps a withdrawn interest visible to its sender', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await harness.app.inject({
      method: 'DELETE',
      url: `/interests/${id}`,
      headers: authHeader(sender.authId),
    });

    const body = (await get('/interests?direction=sent&status=withdrawn', sender.authId)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe('withdrawn');
  });

  it('keeps the row but drops the card when the counterpart blocks the viewer', async () => {
    // Removing the row entirely would make a member's own outgoing interest
    // vanish with no explanation; they are still entitled to know they sent it.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [recipient.userId, sender.userId],
    );

    const body = (await get('/interests?direction=sent', sender.authId)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].counterpart).toBeNull();
  });
});

describe('GET /interests/:interestId', () => {
  it('returns one interest with its card', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    const body = (await get(`/interests/${id}`, sender.authId)).json();
    expect(body.id).toBe(id);
    expect(body.counterpart.userId).toBe(recipient.userId);
  });

  it('is readable by the recipient too', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    const body = (await get(`/interests/${id}`, recipient.authId)).json();
    expect(body.direction).toBe('received');
    expect(body.counterpart.userId).toBe(sender.userId);
  });

  it('404s for an uninvolved member', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    const id = (await send(sender, recipient.userId)).json().id as string;

    expect((await get(`/interests/${id}`, other.authId)).statusCode).toBe(404);
  });

  it('404s an interest that does not exist, and 400s a malformed id', async () => {
    const member = await seedMember('male');
    expect(
      (await get('/interests/00000000-0000-0000-0000-000000000000', member.authId)).statusCode,
    ).toBe(404);
    expect((await get('/interests/nope', member.authId)).statusCode).toBe(400);
  });

  it('refuses an anonymous request', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    expect((await get(`/interests/${id}`)).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Match reads
// ---------------------------------------------------------------------------

describe('GET /matches', () => {
  it('returns the caller matches with the contract shape', async () => {
    const { alice, bilal, matchId } = await matched();

    const body = (await get('/matches', alice.authId)).json();
    const item = (body.items as Array<{ id: string }>).find((m) => m.id === matchId);
    expect(item).toBeDefined();

    const match = item as Record<string, unknown>;
    expect(match.communicationState).toBe('open');
    expect(match.conversationId).toBeNull();
    expect(match.familyReview).toBeNull();
    expect(match.endedAt).toBeNull();
    expect((match.counterpart as { userId: string }).userId).toBe(bilal.userId);
  });

  it('is visible to BOTH participants', async () => {
    const { alice, bilal, matchId } = await matched();
    for (const member of [alice, bilal]) {
      const ids = (
        (await get('/matches', member.authId)).json().items as Array<{ id: string }>
      ).map((m) => m.id);
      expect(ids, member.userId).toContain(matchId);
    }
  });

  it('shows an uninvolved member nothing of it', async () => {
    const { matchId } = await matched();
    const other = await seedMember('male');
    const ids = ((await get('/matches', other.authId)).json().items as Array<{ id: string }>).map(
      (m) => m.id,
    );
    expect(ids).not.toContain(matchId);
  });

  it('leaks no internal column', async () => {
    const { alice } = await matched();
    const item = (await get('/matches', alice.authId)).json().items[0] as Record<string, unknown>;
    for (const forbidden of [
      'interestId',
      'interest_id',
      'endedByUserId',
      'endReason',
      'communicationStateAt',
      'userAId',
      'userBId',
    ]) {
      expect(item, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it('omits an ended match, because the contract lists ACTIVE matches', async () => {
    const { alice, matchId } = await matched();
    await harness.raw.query(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid
        where id = $1::uuid`,
      [matchId, alice.userId],
    );

    const ids = ((await get('/matches', alice.authId)).json().items as Array<{ id: string }>).map(
      (m) => m.id,
    );
    expect(ids).not.toContain(matchId);
  });

  it('refuses an anonymous request', async () => {
    expect((await get('/matches')).statusCode).toBe(401);
  });
});

describe('GET /matches/:matchId', () => {
  it('returns one match to a participant', async () => {
    const { alice, bilal, matchId } = await matched();
    const body = (await get(`/matches/${matchId}`, alice.authId)).json();
    expect(body.id).toBe(matchId);
    expect(body.counterpart.userId).toBe(bilal.userId);
  });

  it('404s for an uninvolved member', async () => {
    // Absent rather than forbidden: a 403 would confirm the match exists.
    const { matchId } = await matched();
    const other = await seedMember('male');
    const response = await get(`/matches/${matchId}`, other.authId);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('404s a match that does not exist, and 400s a malformed id', async () => {
    const member = await seedMember('male');
    expect(
      (await get('/matches/00000000-0000-0000-0000-000000000000', member.authId)).statusCode,
    ).toBe(404);
    expect((await get('/matches/nope', member.authId)).statusCode).toBe(400);
  });

  it('refuses an anonymous request', async () => {
    const { matchId } = await matched();
    expect((await get(`/matches/${matchId}`)).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The card is the Phase 5 card
// ---------------------------------------------------------------------------

describe('counterpart privacy', () => {
  it('exposes exactly the card fields, and no profile internals', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const card = (await get('/interests?direction=sent', sender.authId)).json().items[0]
      .counterpart as Record<string, unknown>;

    expect(Object.keys(card).sort()).toEqual(
      [
        'age',
        'cityName',
        'compatibilityScore',
        'countryCode',
        'displayName',
        'distanceBand',
        'isShortlisted',
        'primaryPhoto',
        'topReasons',
        'userId',
        'verification',
      ].sort(),
    );
    for (const forbidden of [
      'dateOfBirth',
      'date_of_birth',
      'reviewStatus',
      'aboutMe',
      'sensitive',
      'email',
      'phoneE164',
    ]) {
      expect(card, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it('honours the counterpart location precision', async () => {
    const sender = await seedMember('male');
    const coarse = await seedMember('female', {
      cityName: 'Islamabad',
      locationPrecision: 'country',
    });
    await send(sender, coarse.userId);

    const card = (await get('/interests?direction=sent', sender.authId)).json().items[0]
      .counterpart as Record<string, unknown>;
    expect(card.cityName).toBeNull();
    expect(card.countryCode).toBe('pk');
  });

  it('serves the same card shape on a match as on an interest', async () => {
    // One serializer. If these ever diverge, a privacy rule has been fixed in
    // one place and left wrong in the other.
    const { alice } = await matched();
    const matchCard = (await get('/matches', alice.authId)).json().items[0].counterpart;
    const interestCard = (await get('/interests?direction=sent', alice.authId)).json().items[0]
      .counterpart;
    expect(Object.keys(matchCard).sort()).toEqual(Object.keys(interestCard).sort());
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('walks the interest list without gaps or repeats', async () => {
    const sender = await seedMember('male');
    for (let i = 0; i < 5; i += 1) {
      await harness.raw.query(
        `insert into public.usage_counters (user_id, counter_key, period_start, count)
         values ($1::uuid, 'daily_interests', current_date, 0)
         on conflict (user_id, counter_key, period_start) do update set count = 0`,
        [sender.userId],
      );
      await send(sender, (await seedMember('female')).userId);
    }

    const all = (
      (await get('/interests?direction=sent&limit=50', sender.authId)).json().items as Array<{
        id: string;
      }>
    ).map((i) => i.id);
    expect(all.length).toBe(5);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body: { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null } = (
        await get(`/interests?direction=sent&limit=2${suffix}`, sender.authId)
      ).json();
      walked.push(...body.items.map((i) => i.id));
      cursor = body.hasMore ? body.nextCursor : null;
      if (!body.hasMore) expect(body.nextCursor).toBeNull();
      pages += 1;
      expect(pages, 'cursor walk did not terminate').toBeLessThan(20);
    } while (cursor);

    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('returns an empty page honestly', async () => {
    const member = await seedMember('male');
    const body = (await get('/interests?direction=received', member.authId)).json();
    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor and an out-of-range limit', async () => {
    const member = await seedMember('male');
    expect((await get('/interests?direction=sent&cursor=garbage', member.authId)).statusCode).toBe(
      400,
    );
    expect((await get('/interests?direction=sent&limit=0', member.authId)).statusCode).toBe(400);
    expect((await get('/interests?direction=sent&limit=51', member.authId)).statusCode).toBe(400);
    expect((await get('/matches?limit=99', member.authId)).statusCode).toBe(400);
    expect((await get('/matches?cursor=garbage', member.authId)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Relationship consistency
// ---------------------------------------------------------------------------

describe('the API agrees with app.relationship()', () => {
  it('reports interest_pending while an interest is pending', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const item = (await get('/interests?direction=sent', sender.authId)).json().items[0];
    expect(item.status).toBe('pending');
    expect(await relationship(sender.userId, recipient.userId)).toBe('interest_pending');
  });

  it('reports match once accepted, and the match read agrees', async () => {
    const { alice, bilal, matchId } = await matched();
    expect(await relationship(alice.userId, bilal.userId)).toBe('match');

    const body = (await get(`/matches/${matchId}`, alice.authId)).json();
    expect(body.endedAt).toBeNull();

    const interest = (await get('/interests?direction=sent', alice.authId)).json().items[0];
    expect(interest.status).toBe('accepted');
  });

  it('reports stranger once declined, with the interest still listed', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await respond(recipient, id, 'decline');

    expect(await relationship(sender.userId, recipient.userId)).toBe('stranger');
    const item = (await get('/interests?direction=sent', sender.authId)).json().items[0];
    expect(item.status).toBe('declined');
  });

  it('reports stranger once withdrawn', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await harness.app.inject({
      method: 'DELETE',
      url: `/interests/${id}`,
      headers: authHeader(sender.authId),
    });
    expect(await relationship(sender.userId, recipient.userId)).toBe('stranger');
  });
});

// ---------------------------------------------------------------------------
// Reads are side-effect free
// ---------------------------------------------------------------------------

describe('reads change nothing', () => {
  it('leaves quota, state, events and matches untouched', async () => {
    const { alice, bilal, matchId } = await matched();

    const snapshot = async () => {
      const rows = await harness.raw.query<{
        quota: number | null;
        interests: string;
        events: string;
        matches: string;
        status: string;
      }>(
        `select
           (select count from public.usage_counters
             where user_id = $1::uuid and period_start = current_date) as quota,
           (select count(*)::text from public.interests) as interests,
           (select count(*)::text from public.interest_events) as events,
           (select count(*)::text from public.matches) as matches,
           (select status from public.interests where sender_user_id = $1::uuid limit 1) as status`,
        [alice.userId],
      );
      return rows.rows[0]!;
    };

    const before = await snapshot();

    // Every read endpoint in this slice, twice.
    for (let i = 0; i < 2; i += 1) {
      await get('/interests?direction=sent', alice.authId);
      await get('/interests?direction=received', bilal.authId);
      await get('/matches', alice.authId);
      await get(`/matches/${matchId}`, bilal.authId);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('writes no match_events', async () => {
    const { alice, matchId } = await matched();
    const count = async (): Promise<number> => {
      const rows = await harness.raw.query<{ n: string }>(
        `select count(*)::text as n from public.match_events where match_id = $1::uuid`,
        [matchId],
      );
      return Number.parseInt(rows.rows[0]!.n, 10);
    };
    const before = await count();
    await get('/matches', alice.authId);
    await get(`/matches/${matchId}`, alice.authId);
    expect(await count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('later slices remain unbuilt', () => {
  it('exposes no family-review surface', async () => {
    // Unmatch arrived in Slice 4, so that half of this assertion is
    // superseded. Family review is still Phase 6b.
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
