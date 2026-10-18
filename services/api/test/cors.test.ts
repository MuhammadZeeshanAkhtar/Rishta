import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

/**
 * CORS, and the country list that went missing because of its absence.
 *
 * The API had no CORS support at all, which made every reference list fail in
 * any browser — the Expo web build included. It presented as an empty Country
 * dropdown in onboarding rather than as "cannot reach the server", because the
 * selector shows an empty list while the request fails behind it.
 *
 * These are regression tests for both halves: that a browser can read the
 * reference lists, and that the country list is actually populated.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
  // The seed migration provides the real 69; this is enough to prove the
  // endpoint returns what it is given, independent of seed size.
  await harness.raw.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('country', 'pk', 1), ('country', 'gb', 2), ('country', 'ca', 3)
    on conflict (type, code) do nothing;
  `);
  const items = await harness.raw.query<{ id: string; code: string }>(
    `select id, code from public.reference_items where type = 'country'`,
  );
  for (const item of items.rows) {
    await harness.raw.query(
      `insert into public.reference_translations (reference_item_id, locale, label)
       values ($1, 'en', $2)
       on conflict (reference_item_id, locale) do nothing`,
      [item.id, `Country ${item.code}`],
    );
  }
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

describe('CORS', () => {
  it('answers a browser preflight for a reference list', async () => {
    // Without this the browser never sends the real request, and the list is
    // empty with nothing in the response to explain why.
    const response = await harness.app.inject({
      method: 'OPTIONS',
      url: '/reference/country',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });

  it('allows a localhost origin on any port in development', async () => {
    // Metro and `expo export` pick a port per run; pinning one would mean
    // editing config to look at your own app.
    for (const origin of ['http://localhost:8099', 'http://127.0.0.1:19006']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/reference/country',
        headers: { origin },
      });
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('does NOT echo an origin that was never allowed', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/reference/country',
      headers: { origin: 'https://evil.example' },
    });
    // The request still succeeds server-side; the browser is what blocks it,
    // because no allow-origin header comes back.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a request with no Origin at all', async () => {
    // A native app sends none. CORS must not get in its way.
    const response = await harness.app.inject({ method: 'GET', url: '/reference/country' });
    expect(response.statusCode).toBe(200);
  });

  it('permits the headers the client actually sends', async () => {
    const response = await harness.app.inject({
      method: 'OPTIONS',
      url: '/me/profile',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    const allowed = String(response.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
  });
});

describe('country reference list', () => {
  it('returns the countries, not an empty list', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/reference/country' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.type).toBe('country');
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.map((i: { code: string }) => i.code)).toContain('pk');
  });

  it('returns lower-case codes, which is what the profile FK requires', async () => {
    // An upper-case code here would fail on insert with a foreign-key
    // violation rather than a validation error — the confusing kind.
    const response = await harness.app.inject({ method: 'GET', url: '/reference/country' });
    for (const item of response.json().items as Array<{ code: string }>) {
      expect(item.code).toBe(item.code.toLowerCase());
    }
  });

  it('serves an English label for every country', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/reference/country?locale=en',
    });
    const pk = (response.json().items as Array<{ code: string; label: string }>).find(
      (i) => i.code === 'pk',
    );
    expect(pk?.label).toBeTruthy();
    expect(pk?.label).not.toBe('pk');
  });

  it('never returns a label that is just the code', async () => {
    // The route falls back to the code when a translation is missing, which
    // renders as `edu_bachelors` in a dropdown rather than a country name.
    const response = await harness.app.inject({ method: 'GET', url: '/reference/country' });
    for (const item of response.json().items as Array<{ code: string; label: string }>) {
      expect(item.label).not.toBe(item.code);
    }
  });

  it('falls back to English when an unsupported locale is asked for', async () => {
    // Urdu was removed. A client still sending `locale=ur` must get readable
    // English, not an empty list or a row of raw codes.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/reference/country?locale=ur',
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ code: string; label: string }>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.label).not.toBe(item.code);
  });

  it('keeps every other reference type working', async () => {
    // The fix must not single out country.
    for (const type of ['marital_status', 'religious_practice', 'language', 'sect']) {
      const response = await harness.app.inject({ method: 'GET', url: `/reference/${type}` });
      expect(response.statusCode, `${type} failed`).toBe(200);
      expect(response.json().type).toBe(type);
    }
  });
});
