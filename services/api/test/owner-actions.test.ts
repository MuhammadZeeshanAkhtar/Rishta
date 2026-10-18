import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/discovery/candidates';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Owner actions: shortlist and dismiss.
 *
 * Both are member-owned writes, so the questions that matter are "whose row is
 * it" and "what happens on the second tap". Everything here answers 204 and is
 * idempotent by construction, which is what makes a retry after a timeout safe
 * — and a double tap on a phone is the ordinary case, not the edge one.
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

const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, auth?: string) =>
  harness.app.inject({ method, url, ...(auth ? { headers: authHeader(auth) } : {}) });

const countRows = async (table: string, userId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where user_id = $1::uuid`,
    [userId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

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
// Shortlist
// ---------------------------------------------------------------------------

describe('PUT /discovery/shortlist/:userId', () => {
  it('saves a profile and answers 204', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    const response = await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);
    expect(response.statusCode).toBe(204);
    expect(await countRows('shortlists', viewer.userId)).toBe(1);
  });

  it('is idempotent under a double tap', async () => {
    // The ordinary case on a phone, not an edge case.
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
      ).toBe(204);
    }
    expect(await countRows('shortlists', viewer.userId)).toBe(1);
  });

  it('creates one row under concurrent requests', async () => {
    // Five at once, as a flaky connection retrying would produce.
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId),
      ),
    );
    expect(responses.every((r) => r.statusCode === 204)).toBe(true);
    expect(await countRows('shortlists', viewer.userId)).toBe(1);
  });

  it('refuses an anonymous request', async () => {
    const target = await seedMember('female');
    expect((await call('PUT', `/discovery/shortlist/${target.userId}`)).statusCode).toBe(401);
  });

  it('refuses saving yourself', async () => {
    const viewer = await seedMember('male');
    expect(
      (await call('PUT', `/discovery/shortlist/${viewer.userId}`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses a target who blocked the viewer, indistinguishably from absent', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );
    const response = await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);
    // 404 and not 403: a 403 would confirm the member exists.
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('refuses a target the viewer blocked', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [viewer.userId, target.userId],
    );
    expect(
      (await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses a suspended target', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      target.userId,
    ]);
    expect(
      (await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses an unapproved target', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await harness.raw.query(
      `update public.profiles set review_status = 'pending' where user_id = $1::uuid`,
      [target.userId],
    );
    expect(
      (await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses a target that does not exist', async () => {
    const viewer = await seedMember('male');
    expect(
      (
        await call(
          'PUT',
          '/discovery/shortlist/00000000-0000-0000-0000-000000000000',
          viewer.authId,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a malformed id', async () => {
    const viewer = await seedMember('male');
    expect((await call('PUT', '/discovery/shortlist/not-a-uuid', viewer.authId)).statusCode).toBe(
      400,
    );
  });
});

describe('DELETE /discovery/shortlist/:userId', () => {
  it('removes a saved profile', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);

    expect(
      (await call('DELETE', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(204);
    expect(await countRows('shortlists', viewer.userId)).toBe(0);
  });

  it('is idempotent when nothing was saved', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    expect(
      (await call('DELETE', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(204);
  });

  it('still removes someone who has since blocked the viewer', async () => {
    // Otherwise a block would pin a row in the viewer's own list that they can
    // see and cannot delete.
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );

    expect(
      (await call('DELETE', `/discovery/shortlist/${target.userId}`, viewer.authId)).statusCode,
    ).toBe(204);
    expect(await countRows('shortlists', viewer.userId)).toBe(0);
  });

  it('cannot remove another member saved profile', async () => {
    const owner = await seedMember('male');
    const other = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, owner.authId);

    // `other` asks to unsave the same target. RLS scopes the delete to their
    // own rows, so the owner's survives.
    expect(
      (await call('DELETE', `/discovery/shortlist/${target.userId}`, other.authId)).statusCode,
    ).toBe(204);
    expect(await countRows('shortlists', owner.userId)).toBe(1);
  });

  it('refuses an anonymous request', async () => {
    const target = await seedMember('female');
    expect((await call('DELETE', `/discovery/shortlist/${target.userId}`)).statusCode).toBe(401);
  });
});

describe('GET /discovery/shortlist', () => {
  it('returns the caller saved profiles as cards', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);

    const response = await call('GET', '/discovery/shortlist', viewer.authId);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ userId: string; isShortlisted: boolean }>;
    expect(items.map((i) => i.userId)).toEqual([target.userId]);
    expect(items[0]!.isShortlisted).toBe(true);
  });

  it('shows one member nothing of another member list', async () => {
    const owner = await seedMember('male');
    const other = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, owner.authId);

    const items = (await call('GET', '/discovery/shortlist', other.authId)).json().items;
    expect(items).toEqual([]);
  });

  it('drops a saved profile that has since blocked the viewer', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('PUT', `/discovery/shortlist/${target.userId}`, viewer.authId);
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );

    const items = (await call('GET', '/discovery/shortlist', viewer.authId)).json().items as Array<{
      userId: string;
    }>;
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('refuses an anonymous request', async () => {
    expect((await call('GET', '/discovery/shortlist')).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe('POST /discovery/:userId/dismiss', () => {
  it('dismisses a profile and answers 204', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    expect(
      (await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId)).statusCode,
    ).toBe(204);
    expect(await countRows('dismissed_profiles', viewer.userId)).toBe(1);
  });

  it('is idempotent', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId)).statusCode,
      ).toBe(204);
    }
    expect(await countRows('dismissed_profiles', viewer.userId)).toBe(1);
  });

  it('creates one row under concurrent requests', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId),
      ),
    );
    expect(await countRows('dismissed_profiles', viewer.userId)).toBe(1);
  });

  it('removes the profile from the feed immediately, without regeneration', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await generateCandidates(harness.db, viewer.userId);

    const before = (await call('GET', '/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(before.map((i) => i.userId)).toContain(target.userId);

    await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId);

    const after = (await call('GET', '/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(after.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('keeps the profile out after regeneration — dismissal is permanent', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId);
    await generateCandidates(harness.db, viewer.userId);

    const items = (await call('GET', '/discovery/sections/recommended', viewer.authId)).json()
      .items as Array<{ userId: string }>;
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('is invisible to the dismissed member', async () => {
    // A detectable dismissal is a rejection notice, which this product does
    // not send. The dismissed member's own feed is unaffected.
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId);
    await generateCandidates(harness.db, target.userId);

    const theirs = (await call('GET', '/discovery/sections/recommended', target.authId)).json()
      .items as Array<{ userId: string }>;
    expect(theirs.map((i) => i.userId)).toContain(viewer.userId);
  });

  it('refuses dismissing yourself', async () => {
    const viewer = await seedMember('male');
    expect(
      (await call('POST', `/discovery/${viewer.userId}/dismiss`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses a blocked target, in either direction', async () => {
    const viewer = await seedMember('male');
    const blockedByThem = await seedMember('female');
    const blockedByMe = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [blockedByThem.userId, viewer.userId],
    );
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [viewer.userId, blockedByMe.userId],
    );

    for (const target of [blockedByThem, blockedByMe]) {
      expect(
        (await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId)).statusCode,
      ).toBe(404);
    }
  });

  it('refuses a suspended target', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      target.userId,
    ]);
    expect(
      (await call('POST', `/discovery/${target.userId}/dismiss`, viewer.authId)).statusCode,
    ).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const target = await seedMember('female');
    expect((await call('POST', `/discovery/${target.userId}/dismiss`)).statusCode).toBe(401);
  });

  it('refuses a malformed id', async () => {
    const viewer = await seedMember('male');
    expect((await call('POST', '/discovery/not-a-uuid/dismiss', viewer.authId)).statusCode).toBe(
      400,
    );
  });
});
