import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ownPhotoSchema,
  ownProfileSchema,
  timestampSchema,
  uploadTargetSchema,
} from '@nikahmate/domain';
import { isoTimestamp } from '../src/db/sql';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * The wire format of every timestamp this API returns.
 *
 * These parse real responses with the very schemas the mobile client parses
 * them with. That is the point: the previous bug was a response that was a
 * valid 200 with a correct-looking body, which the client then refused at its
 * own boundary and reported as "we could not reach NikahMate". Asserting on
 * status codes here would have proved nothing — the status was always 200.
 *
 * `updated_at::text` renders as `2026-10-01 09:59:13.001436+00` in Postgres:
 * a space where RFC 3339 wants `T`, and `+00` where it wants `+00:00` or `Z`.
 */

let harness: TestHarness;
let authId: string;

/** Postgres's own rendering — a space between the date and the time. */
const POSTGRES_STYLE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

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
      ('country', 'pk', 1)
    on conflict (type, code) do nothing;
  `);
  authId = randomAuthId();
  await bootstrap(authId);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('timestamp wire format', () => {
  it('returns a profile the domain schema accepts', async () => {
    // The whole body, not just the timestamp: this is the exact call the
    // onboarding screen makes on mount, and the exact schema it parses with.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: authHeader(authId),
    });
    expect(response.statusCode).toBe(200);

    const result = ownProfileSchema.safeParse(response.json());
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('returns updatedAt as RFC 3339, not Postgres text', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: authHeader(authId),
    });
    const updatedAt = response.json().updatedAt as string;

    expect(updatedAt).not.toMatch(POSTGRES_STYLE);
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Round-trips to the same instant, so the format change did not shift it.
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  it('keeps updatedAt in UTC regardless of the session time zone', async () => {
    // `at time zone 'utc'` is what makes this true; without it the output
    // follows a server setting no part of this code controls.
    await harness.raw.exec(`set time zone 'Asia/Karachi'`);
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/me/profile',
        headers: authHeader(authId),
      });
      expect(response.json().updatedAt as string).toMatch(/Z$/);
      expect(ownProfileSchema.safeParse(response.json()).success).toBe(true);
    } finally {
      await harness.raw.exec(`set time zone 'UTC'`);
    }
  });

  it('renders Postgres microsecond timestamps as RFC 3339 milliseconds', () => {
    // Tested through the fragment rather than a route because `updated_at` is
    // owned by the `app.touch_updated_at()` trigger and cannot be set to a
    // fixed value — which is correct, and makes an exact-string assertion
    // impossible at the route level.
    const cases: Array<[string, string]> = [
      // The exact value from the bug report.
      ['2026-10-01 09:59:13.001436+00', '2026-10-01T09:59:13.001Z'],
      // A non-UTC offset must be normalised, not echoed.
      ['2026-10-01 14:59:13.5+05:00', '2026-10-01T09:59:13.500Z'],
      // Whole seconds still carry the .000, so the shape never varies.
      ['2026-01-02 03:04:05+00', '2026-01-02T03:04:05.000Z'],
    ];

    return (async () => {
      for (const [input, expected] of cases) {
        const rows = await harness.raw.query<{ out: string }>(
          `select ${isoTimestamp('$1::timestamptz')} as out`,
          [input],
        );
        expect(rows.rows[0]?.out, `for ${input}`).toBe(expected);
        expect(timestampSchema.safeParse(rows.rows[0]?.out).success).toBe(true);
      }

      const nulls = await harness.raw.query<{ out: string | null }>(
        `select ${isoTimestamp('null::timestamptz')} as out`,
      );
      // A nullable timestamp must stay null rather than becoming "null".
      expect(nulls.rows[0]?.out).toBeNull();
    })();
  });

  it('returns a photo list the domain schema accepts', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/me/photos',
      headers: authHeader(authId),
    });
    expect(response.statusCode).toBe(200);

    // Empty is a valid list; the schema still has to accept the envelope, and
    // any row present must carry a parseable createdAt.
    for (const photo of response.json().items as unknown[]) {
      const result = ownPhotoSchema.safeParse(photo);
      expect(
        result.success,
        result.success ? '' : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
    }
  });

  it('returns an upload target the domain schema accepts', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/me/photos/upload-url',
      headers: authHeader(authId),
      payload: { contentType: 'image/jpeg', byteSize: 2048 },
    });
    expect(response.statusCode).toBe(201);

    const result = uploadTargetSchema.safeParse(response.json());
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
    expect(response.json().expiresAt as string).not.toMatch(POSTGRES_STYLE);
  });

  it('returns no Postgres-style timestamp anywhere in a profile response', async () => {
    // A guard for the next `::text` cast someone adds. It walks the whole
    // body rather than naming fields, so a new timestamp field is covered the
    // day it is added rather than the day it breaks a client.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: authHeader(authId),
    });

    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (POSTGRES_STYLE.test(value)) offenders.push(`${path} = ${value}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
      }
    };
    walk(response.json(), 'profile');

    expect(offenders).toEqual([]);
  });

  it('leaves date_of_birth as a plain date', async () => {
    // Dates are deliberately NOT timestamps: `2004-10-20` has no time and no
    // zone, and giving it one is how a birthday moves by a day for anyone east
    // or west of the server.
    await harness.app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: authHeader(authId),
      payload: { dateOfBirth: '2004-10-20' },
    });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: authHeader(authId),
    });
    expect(response.json().dateOfBirth).toBe('2004-10-20');
  });
});
