import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPATIBILITY_DIMENSIONS, ENGINE_VERSION } from '@nikahmate/domain';
import { generateCandidates } from '../src/discovery/candidates';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Discovery and compatibility, end to end.
 *
 * These endpoints serve precomputed data, so the interesting failures are not
 * "is the list right" but "whose list is it" and "is it still true". A
 * precomputed set is a snapshot: someone who blocked the viewer after the last
 * generation is still sitting in `match_candidates`, and the read has to drop
 * them. Most of what follows is that case and its relatives.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(overrides: {
  gender: 'male' | 'female';
  reviewStatus?: string;
  religiousPractice?: string;
  cityName?: string;
  locationPrecision?: string;
}): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Member ${seq}`, overrides.gender],
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
     values ($1::uuid, $2::text, 'ms_never_married', $3::text, $4::text)`,
    [
      userId,
      `A sufficiently long about-me for member ${seq}.`,
      overrides.religiousPractice ?? 'rel_practising',
      overrides.reviewStatus ?? 'approved',
    ],
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
  harness.app.inject({
    method: 'GET',
    url,
    ...(auth ? { headers: authHeader(auth) } : {}),
  });

beforeAll(async () => {
  harness = await createHarness();
  await harness.raw.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'),
      ('religious_practice', 'rel_practising'),
      ('religious_practice', 'rel_occasionally')
    on conflict (type, code) do nothing;
  `);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('GET /discovery/sections/recommended', () => {
  it('returns the viewer generated candidates', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const response = await get('/discovery/sections/recommended', viewer.authId);
    expect(response.statusCode).toBe(200);
    const ids = (response.json().items as Array<{ userId: string }>).map((i) => i.userId);
    expect(ids).toContain(target.userId);
  });

  it('refuses an anonymous request', async () => {
    const response = await get('/discovery/sections/recommended');
    expect(response.statusCode).toBe(401);
  });

  it('never returns the viewer themselves', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const ids = (
      (await get('/discovery/sections/recommended', viewer.authId)).json().items as Array<{
        userId: string;
      }>
    ).map((i) => i.userId);
    expect(ids).not.toContain(viewer.userId);
  });

  it('shows one viewer nothing from another viewer feed', async () => {
    // Two viewers, each with their own generated set. RLS confines the read to
    // the caller's rows; this proves the endpoint does not widen it.
    //
    // NARROWED IN PHASE 7a, not weakened. This used to assert that Bilal's
    // feed was EMPTY, which worked only because nothing generated a set for
    // him — the endpoint now generates on a cold read, so an empty feed is no
    // longer the observable consequence of the rule.
    //
    // The rule itself is unchanged and is now asserted directly: every row
    // behind Bilal's feed must be keyed to Bilal. That is the invariant the
    // old assertion was a proxy for, and it cannot pass by accident.
    const alice = await seedMember({ gender: 'female' });
    const bilal = await seedMember({ gender: 'male' });
    await generateCandidates(harness.db, alice.userId);

    const aliceBatch = await harness.raw.query<{ batch_id: string }>(
      `select distinct batch_id from public.match_candidates where user_id = $1::uuid`,
      [alice.userId],
    );

    const theirs = await get('/discovery/sections/recommended', bilal.authId);
    expect(theirs.statusCode).toBe(200);
    const ids = (theirs.json().items as Array<{ userId: string }>).map((i) => i.userId);

    // Nothing Bilal sees may come from a batch generated for Alice.
    const bilalRows = await harness.raw.query<{ user_id: string; batch_id: string }>(
      `select user_id, batch_id from public.match_candidates
        where user_id = $1::uuid and candidate_user_id = any($2::uuid[])`,
      [bilal.userId, ids],
    );
    expect(bilalRows.rows.length).toBe(ids.length);
    for (const row of bilalRows.rows) {
      expect(row.user_id).toBe(bilal.userId);
      expect(aliceBatch.rows.map((r) => r.batch_id)).not.toContain(row.batch_id);
    }
  });

  it('orders by the persisted rank', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female', religiousPractice: 'rel_practising' });
    await seedMember({ gender: 'female', religiousPractice: 'rel_occasionally' });
    await harness.raw.query(
      `insert into public.partner_preferences (user_id, religious_practice_codes)
       values ($1::uuid, array['rel_practising'])
       on conflict (user_id) do update set religious_practice_codes = excluded.religious_practice_codes`,
      [viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);

    const items = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string; compatibilityScore: number | null }>;
    const ranks = await harness.raw.query<{ candidate_user_id: string }>(
      `select candidate_user_id from public.match_candidates
        where user_id = $1::uuid and section_key = 'recommended' order by rank`,
      [viewer.userId],
    );
    expect(items.map((i) => i.userId)).toEqual(ranks.rows.map((r) => r.candidate_user_id));
  });

  it('drops a candidate who blocked the viewer AFTER generation', async () => {
    // The freshness guarantee. The precomputed row is still there; the read
    // must not serve it.
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const before = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(before.map((i) => i.userId)).toContain(target.userId);

    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );
    // Deliberately NOT regenerating.
    const after = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(after.map((i) => i.userId)).not.toContain(target.userId);

    // And the stale row is genuinely still in the table, so the filtering is
    // the read's doing rather than a side effect of something else.
    const stale = await harness.raw.query(
      `select id from public.match_candidates
        where user_id = $1::uuid and candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );
    expect(stale.rows).toHaveLength(1);
  });

  it('drops a candidate the viewer blocked after generation', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [viewer.userId, target.userId],
    );

    const after = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(after.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('drops a candidate whose profile stopped being approved', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    await harness.raw.query(
      `update public.profiles set review_status = 'rejected' where user_id = $1::uuid`,
      [target.userId],
    );

    const after = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(after.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('drops a candidate whose account stopped being active', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      target.userId,
    ]);

    const after = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(after.map((i) => i.userId)).not.toContain(target.userId);
  });
});

describe('the card', () => {
  it('honours the candidate location precision', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const open = await seedMember({ gender: 'female', cityName: 'Karachi' });
    const coarse = await seedMember({
      gender: 'female',
      cityName: 'Islamabad',
      locationPrecision: 'country',
    });
    await generateCandidates(harness.db, viewer.userId);

    const items = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string; cityName: string | null; countryCode: string | null }>;

    expect(items.find((i) => i.userId === open.userId)?.cityName).toBe('Karachi');
    // `country` precision means "do not show my city" — the country survives.
    expect(items.find((i) => i.userId === coarse.userId)?.cityName).toBeNull();
    expect(items.find((i) => i.userId === coarse.userId)?.countryCode).toBe('pk');
  });

  it('leaks no private profile field', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const items = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<Record<string, unknown>>;
    const card = items[0]!;
    // The compact card and nothing else. aboutMe, sensitive contact details,
    // review status and moderation state must not be reachable here.
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
    for (const forbidden of ['aboutMe', 'sensitive', 'reviewStatus', 'email', 'phoneE164']) {
      expect(card).not.toHaveProperty(forbidden);
    }
  });

  it('carries explanation KEYS rather than prose', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const items = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ topReasons: string[] }>;
    for (const reason of items.flatMap((i) => i.topReasons)) {
      expect(reason).toMatch(/^compatibility\.[a-z]+$/);
      expect(reason).not.toContain(' ');
    }
  });

  it('reports no distance band, because there are no coordinates to band', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const items = (await get('/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ distanceBand: unknown }>;
    expect(items.every((i) => i.distanceBand === null)).toBe(true);
  });
});

describe('pagination', () => {
  it('pages with an opaque cursor, without gaps or repeats', async () => {
    // Earlier tests in this file seed members too, and generation picks up
    // everyone eligible — so this asserts the PROPERTIES of the walk rather
    // than a fixed count, which would silently depend on test order.
    const viewer = await seedMember({ gender: 'male' });
    for (let i = 0; i < 3; i += 1) await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const all = (
      (await get('/discovery/sections/recommended?limit=50', viewer.authId)).json().items as Array<{
        userId: string;
      }>
    ).map((i) => i.userId);
    expect(all.length).toBeGreaterThan(2);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      // Annotated because `cursor` is reassigned from `body` below, and TS
      // cannot infer a type that depends on itself through the loop.
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const url: string = `/discovery/sections/recommended?limit=2${suffix}`;
      const body: {
        items: Array<{ userId: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      } = (await get(url, viewer.authId)).json();
      walked.push(...body.items.map((i) => i.userId));
      cursor = body.hasMore ? body.nextCursor : null;
      // A page that claims more must hand back a cursor to get it.
      if (body.hasMore) expect(body.nextCursor).toBeTypeOf('string');
      else expect(body.nextCursor).toBeNull();
      pages += 1;
      expect(pages, 'cursor walk did not terminate').toBeLessThan(50);
    } while (cursor);

    // Same members, same order, no duplicates — the walk reconstructs the feed.
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const response = await get(
      '/discovery/sections/recommended?cursor=not-a-real-cursor',
      viewer.authId,
    );
    expect(response.statusCode).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    const viewer = await seedMember({ gender: 'male' });
    expect((await get('/discovery/sections/recommended?limit=0', viewer.authId)).statusCode).toBe(
      400,
    );
    expect((await get('/discovery/sections/recommended?limit=99', viewer.authId)).statusCode).toBe(
      400,
    );
  });
});

describe('sections', () => {
  it('lists the sections it can actually serve', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const response = await get('/discovery/sections', viewer.authId);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ key: string; totalCount: number; preview: [] }>;
    expect(items.map((i) => i.key)).toEqual(['recommended']);
    expect(items[0]!.totalCount).toBeGreaterThan(0);
    expect(items[0]!.preview.length).toBeGreaterThan(0);
  });

  it('404s a contract section that nothing generates yet', async () => {
    // Explicitly unsupported rather than an empty page: an empty page reads as
    // "nobody matches you", which is a different and untrue statement.
    const viewer = await seedMember({ gender: 'male' });
    for (const key of ['highly_compatible', 'verified', 'same_country']) {
      const response = await get(`/discovery/sections/${key}`, viewer.authId);
      expect(response.statusCode, key).toBe(404);
    }
  });

  it('404s `nearby`, which cannot be computed at all', async () => {
    // No coordinates exist, so a band would have to be invented.
    const viewer = await seedMember({ gender: 'male' });
    expect((await get('/discovery/sections/nearby', viewer.authId)).statusCode).toBe(404);
  });

  it('404s a section key that is not in the contract', async () => {
    const viewer = await seedMember({ gender: 'male' });
    expect((await get('/discovery/sections/made_up', viewer.authId)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('GET /compatibility/:userId', () => {
  it('returns the persisted score, version and dimensions', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const response = await get(`/compatibility/${target.userId}`, viewer.authId);
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.userId).toBe(target.userId);
    expect(body.engineVersion).toBe(ENGINE_VERSION);
    expect(body.overall).toBeGreaterThanOrEqual(0);
    expect(body.overall).toBeLessThanOrEqual(100);
    expect(body.dimensions).toHaveLength(11);
    expect((body.dimensions as Array<{ key: string }>).map((d) => d.key).sort()).toEqual(
      [...COMPATIBILITY_DIMENSIONS].sort(),
    );
  });

  it('matches the stored row exactly, rather than recomputing', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    // Move the stored value. A handler that recomputed would overwrite this
    // answer with a fresh one; a handler that reads returns what is there.
    await harness.raw.query(
      `update public.compatibility_scores set overall = 42.25
        where viewer_user_id = $1::uuid and candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );
    const body = (await get(`/compatibility/${target.userId}`, viewer.authId)).json();
    expect(body.overall).toBe(42.25);
  });

  it('refuses an anonymous request', async () => {
    const target = await seedMember({ gender: 'female' });
    expect((await get(`/compatibility/${target.userId}`)).statusCode).toBe(401);
  });

  it('does NOT expose the compatibility computed ABOUT the caller', async () => {
    // The row exists, keyed the other way. It is not the candidate's to read.
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const response = await get(`/compatibility/${viewer.userId}`, target.authId);
    expect(response.statusCode).toBe(404);
  });

  it('404s a pair that was never scored', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const stranger = await seedMember({ gender: 'female' });
    const response = await get(`/compatibility/${stranger.userId}`, viewer.authId);
    expect(response.statusCode).toBe(404);
  });

  it('404s once a block exists, with no hint that the score ever existed', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    expect((await get(`/compatibility/${target.userId}`, viewer.authId)).statusCode).toBe(200);

    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );
    const after = await get(`/compatibility/${target.userId}`, viewer.authId);
    // 404 and not 403: a 403 would confirm the other member exists, which is
    // precisely what the blocked party must not learn.
    expect(after.statusCode).toBe(404);
    expect(after.json().code).toBe('not_found');
  });

  it('404s the caller asking about themselves', async () => {
    const viewer = await seedMember({ gender: 'male' });
    expect((await get(`/compatibility/${viewer.userId}`, viewer.authId)).statusCode).toBe(404);
  });

  it('400s a malformed user id', async () => {
    const viewer = await seedMember({ gender: 'male' });
    expect((await get('/compatibility/not-a-uuid', viewer.authId)).statusCode).toBe(400);
  });
});

describe('GET /compatibility/:userId/explanation', () => {
  it('returns keys and facts, never prose', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const response = await get(`/compatibility/${target.userId}/explanation`, viewer.authId);
    expect(response.statusCode).toBe(200);
    const body = response.json();

    const entries = [...body.reasons, ...body.differences] as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.messageKey).toMatch(/^compatibility\.[a-z]+$/);
      // No rendered sentence anywhere in the payload.
      expect(entry).not.toHaveProperty('text');
      expect(entry.facts).toBeTypeOf('object');
    }
  });

  it('keeps every reason traceable to a stored fact', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await harness.raw.query(
      `insert into public.partner_preferences (user_id, religious_practice_codes)
       values ($1::uuid, array['rel_practising'])
       on conflict (user_id) do update set religious_practice_codes = excluded.religious_practice_codes`,
      [viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);

    const body = (await get(`/compatibility/${target.userId}/explanation`, viewer.authId)).json();
    const religious = [...body.reasons, ...body.differences].find(
      (e: { dimension: string }) => e.dimension === 'religious',
    );
    expect(religious.facts.candidatePractice).toBe('rel_practising');
    expect(religious.facts.preferredPractice).toEqual(['rel_practising']);
  });

  it('shows differences alongside positives rather than only the good news', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female', religiousPractice: 'rel_occasionally' });
    await harness.raw.query(
      `insert into public.partner_preferences (user_id, religious_practice_codes)
       values ($1::uuid, array['rel_practising'])
       on conflict (user_id) do update set religious_practice_codes = excluded.religious_practice_codes`,
      [viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);

    const body = (await get(`/compatibility/${target.userId}/explanation`, viewer.authId)).json();
    expect(body.differences.length).toBeGreaterThan(0);
    expect((body.differences as Array<{ dimension: string }>).map((d) => d.dimension)).toContain(
      'religious',
    );
  });

  it('omits a dimension that had nothing to compare', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const body = (await get(`/compatibility/${target.userId}/explanation`, viewer.authId)).json();
    const dimensions = [...body.reasons, ...body.differences].map(
      (e: { dimension: string }) => e.dimension,
    );
    // `family` has no reference data, so it is stored with a null sub_score
    // and must not appear as a reason at all.
    expect(dimensions).not.toContain('family');
  });

  it('refuses an anonymous request', async () => {
    const target = await seedMember({ gender: 'female' });
    expect((await get(`/compatibility/${target.userId}/explanation`)).statusCode).toBe(401);
  });

  it('does NOT expose the explanation computed about the caller', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    expect(
      (await get(`/compatibility/${viewer.userId}/explanation`, target.authId)).statusCode,
    ).toBe(404);
  });
});

describe('GET /compatibility/dimensions', () => {
  it('describes the model without needing an account', async () => {
    // The dimension list is the model, not anyone's data.
    const response = await get('/compatibility/dimensions');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.engineVersion).toBe(ENGINE_VERSION);
    expect(body.items).toHaveLength(11);
    expect((body.items as Array<{ key: string }>).map((i) => i.key)).not.toContain('personality');
  });

  it('is not shadowed by the :userId route', async () => {
    const response = await get('/compatibility/dimensions');
    expect(response.statusCode).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// No write surface
// ---------------------------------------------------------------------------

describe('there is no write surface', () => {
  it('exposes no endpoint that writes candidates or scores', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });

    for (const [method, url] of [
      ['POST', '/discovery/sections/recommended'],
      ['POST', '/match-candidates'],
      ['POST', `/compatibility/${target.userId}`],
      ['PUT', `/compatibility/${target.userId}`],
      ['PATCH', `/compatibility/${target.userId}`],
      ['DELETE', `/compatibility/${target.userId}`],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: authHeader(viewer.authId),
        payload: {},
      });
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});
