import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES, notificationPageSchema } from '@nikahmate/domain';
import { NOTIFICATION_PREFERENCE_TYPES } from '../src/routes/me';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Every notification the database accepts reaches a member as readable English.
 *
 * Two failures this guards, both invisible until such a row exists: a type
 * missing from the catalog shows the member its raw key, and a type missing
 * from the shared schema makes the client refuse the WHOLE inbox page.
 */

const catalog = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'),
    'utf8',
  ),
) as Record<string, unknown>;

function text(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      catalog,
    );
}

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('notification types', () => {
  it('the shared schema and the preferences list name the same types', () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual([...NOTIFICATION_PREFERENCE_TYPES].sort());
  });

  it('every type the database accepts parses in the inbox and has English text', async () => {
    const authId = randomAuthId();
    const rows = await harness.raw.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
       values ('Inbox Member', 'female', date '1995-06-15', 'pk', 'active', now()) returning id`,
    );
    const userId = rows.rows[0]!.id;
    await harness.raw.query(
      `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
      [userId, authId],
    );
    for (const type of NOTIFICATION_PREFERENCE_TYPES) {
      await harness.raw.query(
        `insert into public.notifications (user_id, type, payload, dedupe_key) values ($1::uuid, $2, '{}', $2)`,
        [userId, type],
      );
    }

    const response = await harness.app.inject({
      method: 'GET',
      url: '/notifications?limit=50',
      headers: authHeader(authId),
    });
    expect(response.statusCode, response.body).toBe(200);

    const page = notificationPageSchema.parse(response.json());
    expect(page.items.map((n) => n.type).sort()).toEqual([...NOTIFICATION_PREFERENCE_TYPES].sort());
    for (const item of page.items) {
      expect(typeof text(item.titleKey), item.titleKey).toBe('string');
      expect(typeof text(item.bodyKey), item.bodyKey).toBe('string');
    }
  });
});
