import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * GHSA-mrhx-c7xc-m3w5, through the real routes: an oversized array in a request
 * body is a 400 that names the array once, not one entry per element, and it
 * changes nothing. Every request-body array the API accepts is listed here; the
 * schema-level proof is packages/domain/src/collection-bounds.test.ts.
 */

const OVERSIZED = Array.from({ length: 5_000 }, () => 1);

let harness: TestHarness;
let authId: string;
let userId: string;

const send = (method: 'PATCH' | 'PUT', url: string, payload: Record<string, unknown>) =>
  harness.app.inject({ method, url, headers: authHeader(authId), payload });

beforeAll(async () => {
  harness = await createHarness();
  authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ('Bounds Member', 'female', date '1995-06-15', 'pk', 'active', now()) returning id`,
  );
  userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('oversized request arrays', () => {
  it.each([
    ['PATCH', '/me/profile', { languages: OVERSIZED }, 'languages'],
    ['PUT', '/me/preferences', { countryCodes: OVERSIZED }, 'countryCodes'],
    ['PATCH', '/me/preferences', { languageCodes: OVERSIZED }, 'languageCodes'],
    [
      'PUT',
      '/me/notification-preferences',
      { quietHoursStart: null, quietHoursEnd: null, types: OVERSIZED },
      'types',
    ],
  ] as const)('%s %s names the array once', async (method, url, body, field) => {
    const response = await send(method, url, body);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe('validation_failed');
    expect(Object.keys(response.json().fields)).toEqual([field]);
  });

  it.each([
    ['PUT', '/me/photos/order', { photoIds: OVERSIZED }],
    ['PATCH', `/family/members/${randomAuthId()}/permissions`, { permissions: OVERSIZED }],
  ] as const)('%s %s is refused', async (method, url, body) => {
    const response = await send(method, url, body);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('wrote nothing for the refused notification preferences', async () => {
    const rows = await harness.raw.query<{ n: number }>(
      `select count(*)::int as n from public.notification_preferences where user_id = $1::uuid`,
      [userId],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});
