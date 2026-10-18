import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Profile and preferences endpoints, against a real Postgres with the real
 * policies applied.
 *
 * The questions worth asking of these routes are not "does a PATCH change a
 * field" but "can a member reach past their own row", "can they approve
 * themselves", and "does submitting an incomplete profile say which field is
 * missing". Those are what these cover.
 */

let harness: TestHarness;
let authId: string;
let otherAuthId: string;

async function bootstrap(auth: string): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/account/bootstrap',
    headers: authHeader(auth),
    payload: { locale: 'en', timezone: 'Asia/Karachi' },
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`bootstrap failed: ${response.statusCode} ${response.body}`);
  }
}

beforeAll(async () => {
  harness = await createHarness();

  await harness.raw.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('country', 'pk', 1),
      ('country', 'gb', 2),
      ('marital_status', 'ms_never_married', 1),
      ('religious_practice', 'rel_practising', 1),
      ('education_level', 'edu_bachelors', 1),
      ('profession', 'prof_engineer', 1),
      ('marriage_timeline', 'mt_within_a_year', 1),
      ('language', 'urdu', 1),
      ('language', 'english', 2),
      ('sect', 'sect_sunni', 1)
    on conflict (type, code) do nothing;
  `);

  authId = randomAuthId();
  otherAuthId = randomAuthId();
  await bootstrap(authId);
  await bootstrap(otherAuthId);
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

const get = (url: string, auth = authId) =>
  harness.app.inject({ method: 'GET', url, headers: authHeader(auth) });

const patch = (url: string, payload: Record<string, unknown>, auth = authId) =>
  harness.app.inject({ method: 'PATCH', url, headers: authHeader(auth), payload });

describe('GET /me/profile', () => {
  it('creates an empty profile on first read rather than 404ing', async () => {
    // Someone who has just verified their email has no profile row yet. A 404
    // here would mean the app has to special-case its own first screen.
    const response = await get('/me/profile');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reviewStatus).toBe('draft');
    expect(body.completionScore).toBe(0);
    expect(body.languages).toEqual([]);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/me/profile' });
    expect(response.statusCode).toBe(401);
  });

  it('includes the owner sensitive block, read through the service role', async () => {
    const response = await get('/me/profile');
    expect(response.json().sensitive).toEqual({
      phoneE164: null,
      email: null,
      employerName: null,
      workplaceCity: null,
    });
    // profile_sensitive has zero policies, so this read cannot happen any
    // other way — and it is enumerated.
    expect(harness.serviceUses).toContain('profile.read_own_sensitive');
  });
});

describe('PATCH /me/profile', () => {
  it('saves a partial update and leaves other fields alone', async () => {
    const first = await patch('/me/profile', { aboutMe: 'Looking for a practising partner.' });
    expect(first.statusCode).toBe(200);
    expect(first.json().aboutMe).toBe('Looking for a practising partner.');

    const second = await patch('/me/profile', { maritalStatusCode: 'ms_never_married' });
    expect(second.statusCode).toBe(200);
    // The earlier value survives — this is a patch, not a replace.
    expect(second.json().aboutMe).toBe('Looking for a practising partner.');
    expect(second.json().maritalStatusCode).toBe('ms_never_married');
  });

  it('accepts a country code in either case and stores it lower-case', async () => {
    // reference_items requires lower case, so an upper-case value would fail
    // on the composite FK rather than in validation.
    const response = await patch('/me/profile', { location: { countryCode: 'PK' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().location.countryCode).toBe('pk');
  });

  it('stores arrays and deduplicates them', async () => {
    const response = await patch('/me/profile', { languages: ['urdu', 'english', 'urdu'] });
    expect(response.statusCode).toBe(200);
    expect(response.json().languages.sort()).toEqual(['english', 'urdu']);
  });

  it('rejects a reference code of the wrong shape', async () => {
    const response = await patch('/me/profile', { maritalStatusCode: 'Not A Code' });
    expect(response.statusCode).toBe(400);
    expect(response.json().fields).toHaveProperty('maritalStatusCode');
  });

  it('rejects a height outside the plausible range', async () => {
    expect((await patch('/me/profile', { heightCm: 40 })).statusCode).toBe(400);
    expect((await patch('/me/profile', { heightCm: 400 })).statusCode).toBe(400);
  });

  it('rejects contradictory children answers', async () => {
    const response = await patch('/me/profile', { hasChildren: false, childrenCount: 3 });
    expect(response.statusCode).toBe(400);
  });

  it('ignores an attempt to set review status', async () => {
    // Not in the update schema, so it is stripped before any SQL is built —
    // and the column carries no grant either, which is the real control.
    const response = await patch('/me/profile', {
      reviewStatus: 'approved',
      completionScore: 100,
      aboutMe: 'Still just a draft, thank you.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().reviewStatus).toBe('draft');
    expect(response.json().completionScore).toBeLessThan(100);
  });

  it('does not let one member reach another member profile', async () => {
    await patch('/me/profile', { aboutMe: 'Mine alone.' }, authId);
    const theirs = await get('/me/profile', otherAuthId);
    expect(theirs.statusCode).toBe(200);
    // RLS scopes the read. The other account sees its own empty profile, not
    // the one just written.
    expect(theirs.json().aboutMe).toBeNull();
  });
});

describe('GET /me/profile/completion', () => {
  it('names what is missing rather than only scoring', async () => {
    const response = await get('/me/profile/completion', otherAuthId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.missingRequired).toContain('aboutMe');
    expect(body.missingRequired).toContain('religiousPracticeCode');
    expect(body.isDiscoverable).toBe(false);
    // Most valuable next step first, so the UI can lead with it.
    expect(body.suggestedNext.length).toBeGreaterThan(0);
  });

  it('rises as the profile fills in', async () => {
    const before = (await get('/me/profile/completion')).json().score;
    await patch('/me/profile', { religiousPracticeCode: 'rel_practising' });
    const after = (await get('/me/profile/completion')).json().score;
    expect(after).toBeGreaterThan(before);
  });
});

describe('POST /me/profile/submit', () => {
  const submit = (auth = authId) =>
    harness.app.inject({
      method: 'POST',
      url: '/me/profile/submit',
      headers: authHeader(auth),
    });

  it('refuses an incomplete profile and says which fields are missing', async () => {
    const response = await submit(otherAuthId);
    expect(response.statusCode).toBe(400);
    // Named fields, so the app can send someone back to the right step.
    expect(Object.keys(response.json().fields ?? {}).length).toBeGreaterThan(0);
  });

  it('accepts a complete profile and approves it through the Phase 5 stub', async () => {
    // `users` identity is written during onboarding; set it directly here so
    // this test is about submission, not about the identity endpoint.
    await harness.raw.query(
      `update public.users
       set display_name = 'Complete User', gender = 'male',
           date_of_birth = date '1995-06-15', country_code = 'pk'
       where id = (select user_id from public.user_auth_links where auth_user_id = $1)`,
      [authId],
    );
    await patch('/me/profile', {
      aboutMe: 'A serious, practising Muslim seeking marriage in the next year.',
      maritalStatusCode: 'ms_never_married',
      religiousPracticeCode: 'rel_practising',
      location: { countryCode: 'pk', cityName: 'Lahore' },
    });

    const response = await submit();
    expect(response.statusCode).toBe(202);
    // TEMPORARY, and deliberately asserted so removing the stub fails loudly
    // here rather than silently emptying Discover. Phase 8 replaces this with
    // the moderation queue and this expectation returns to 'pending'.
    expect(response.json().reviewStatus).toBe('approved');
    expect(harness.serviceUses).toContain('profile.submit_for_review');
  });

  it('ends onboarding, so the session gate lets the app in', async () => {
    // The whole point of submitting. `stateFor()` in the app returns 'ready'
    // only when BOTH of these hold; with either missing it returns
    // 'onboarding' and the router sends the person back to step 1 — after a
    // submission that returned 202. The two are written in one transaction
    // for exactly that reason.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/me',
      headers: authHeader(authId),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().profileCompleted).toBe(true);
    expect(me.json().status).toBe('active');
  });

  it('clears the resume pointer so onboarding does not reopen', async () => {
    const rows = await harness.raw.query<{ onboarding_step: string | null }>(
      `select onboarding_step from public.users
        where id = (select user_id from public.user_auth_links where auth_user_id = $1::uuid)`,
      [authId],
    );
    expect(rows.rows[0]?.onboarding_step).toBeNull();
  });

  it('refuses a second submission of an already-submitted profile', async () => {
    // The guard must cover `approved` too, or the stub would make every
    // resubmission a silent no-op that still returns 202.
    const response = await submit();
    expect(response.statusCode).toBe(409);
  });

  it('does not reinstate an account that is not in onboarding', async () => {
    // A suspended member who resubmits must not promote themselves back to
    // active. `status` only ever moves forward out of onboarding.
    const userId = (
      await harness.raw.query<{ user_id: string }>(
        `select user_id from public.user_auth_links where auth_user_id = $1::uuid`,
        [authId],
      )
    ).rows[0]!.user_id;

    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      userId,
    ]);
    await harness.raw.query(
      `update public.profiles set review_status = 'draft' where user_id = $1::uuid`,
      [userId],
    );

    const response = await submit();
    expect(response.statusCode).toBe(202);

    const rows = await harness.raw.query<{ status: string }>(
      `select status from public.users where id = $1::uuid`,
      [userId],
    );
    expect(rows.rows[0]?.status).toBe('suspended');

    // Put it back so later tests see the state they expect.
    await harness.raw.query(`update public.users set status = 'active' where id = $1::uuid`, [
      userId,
    ]);
  });

  it('reports discoverability from the stored review status, not a guess', async () => {
    // Was "pending is not approved". With the Phase 5 auto-approval stub the
    // profile really is approved, and the honest assertion is that
    // `isDiscoverable` agrees with `reviewStatus` rather than either being
    // hardcoded. That holds before and after Phase 8 removes the stub.
    const completion = (await get('/me/profile/completion')).json();
    expect(completion.reviewStatus).toBe('approved');
    expect(completion.isDiscoverable).toBe(completion.reviewStatus === 'approved');
  });
});

describe('preferences', () => {
  // `await`ed inside rather than returning inject's chainable directly: the
  // chain type is a union that loses `statusCode` at some call sites.
  const put = async (
    payload: Record<string, unknown>,
    auth = authId,
  ): Promise<LightMyRequestResponse> =>
    await harness.app.inject({
      method: 'PUT',
      url: '/me/preferences',
      headers: authHeader(auth),
      payload,
    });

  it('creates defaults on first read', async () => {
    const response = await get('/me/preferences');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The A2 guard: someone who states a sect preference still sees profiles
    // that left it blank, unless they deliberately opt out.
    expect(body.excludeUnstatedSect).toBe(false);
    expect(body.countryCodes).toEqual([]);
  });

  it('saves an update and returns the stored state', async () => {
    const response = await put({
      ageMin: 25,
      ageMax: 35,
      countryCodes: ['pk', 'GB'],
      maritalStatusCodes: ['ms_never_married'],
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ageMin).toBe(25);
    expect(body.countryCodes.sort()).toEqual(['gb', 'pk']);
  });

  it('rejects an inverted age range', async () => {
    const response = await put({ ageMin: 40, ageMax: 30 });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an age below the product floor', async () => {
    const response = await put({ ageMin: 16 });
    expect(response.statusCode).toBe(400);
  });

  it('keeps one member preferences out of another member view', async () => {
    const theirs = await get('/me/preferences', otherAuthId);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().ageMin).toBeNull();
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/me/preferences' });
    expect(response.statusCode).toBe(401);
  });
});
