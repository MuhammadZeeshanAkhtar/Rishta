import { DELETION_GRACE_DAYS, deletionRequestSchema } from '@nikahmate/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance, type Queryable } from '../scripts/maintenance';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * Stage 2, Priority 3: the deletion workflow the app now offers, through the real
 * routes. The request, the pending state, cancelling, the safety hold, and what
 * happens when the grace period ends.
 *
 * WHAT IS NOT HERE: deletion itself. Nothing executes a request after its grace
 * period, and the last test pins that, so it cannot be assumed. That is a production
 * blocker: see docs/PRODUCTION_SECURITY.md.
 */

let harness: TestHarness;

const seedMember = async (status = 'active') => {
  const authId = randomAuthId();
  const users = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ('Member', 'female', date '1995-06-15', 'pk', $1, now()) returning id`,
    [status],
  );
  const userId = users.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(
    `insert into public.verification_status (user_id, email_verified_at) values ($1::uuid, now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.', 'ms_never_married', 'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
};

const call = (method: string, url: string, authId: string, payload?: unknown) =>
  harness.app.inject({
    method: method as 'GET',
    url,
    headers: authHeader(authId),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const statusOf = async (userId: string) =>
  (
    await harness.raw.query<{ status: string }>(
      `select status from public.users where id = $1::uuid`,
      [userId],
    )
  ).rows[0]!.status;

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
  await harness.raw.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('marital_status', 'ms_never_married', 1), ('religious_practice', 'rel_practising', 1)
    on conflict do nothing
  `);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('asking', () => {
  it('answers in the shape the app reads, scheduled for the end of the grace period', async () => {
    const member = await seedMember();
    const res = await call('POST', '/me/delete', member.authId);
    expect(res.statusCode).toBe(202);
    const body = deletionRequestSchema.parse(res.json());
    expect(body.status).toBe('pending');
    expect(body.heldReason).toBeNull();
    const days =
      (Date.parse(body.scheduledFor) - Date.parse(body.requestedAt)) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(DELETION_GRACE_DAYS);
  });

  it('hides the account at once, and the member can no longer use it', async () => {
    const member = await seedMember();
    const other = await seedMember();
    expect((await call('GET', `/profiles/${member.userId}`, other.authId)).statusCode).toBe(200);
    await call('POST', '/me/delete', member.authId);
    expect(await statusOf(member.userId)).toBe('pending_deletion');
    expect((await call('GET', `/profiles/${member.userId}`, other.authId)).statusCode).toBe(404);
    expect((await call('GET', '/discovery/sections', member.authId)).json().code).toBe(
      'account_restricted',
    );
  });

  it('the app can still read where the account stands', async () => {
    const member = await seedMember();
    await call('POST', '/me/delete', member.authId);
    const me = await call('GET', '/me', member.authId);
    expect(me.statusCode).toBe(200);
    expect(me.json().status).toBe('pending_deletion');
  });

  it('asking twice is a conflict, which the app treats as already asked', async () => {
    const member = await seedMember();
    await call('POST', '/me/delete', member.authId);
    expect((await call('POST', '/me/delete', member.authId)).statusCode).toBe(409);
  });

  it('a member still onboarding can ask', async () => {
    const authId = randomAuthId();
    await call('POST', '/account/bootstrap', authId, { locale: 'en', timezone: 'UTC' });
    expect((await call('POST', '/me/delete', authId)).statusCode).toBe(202);
    const me = await call('GET', '/me', authId);
    expect(me.json().status).toBe('pending_deletion');
    expect((await call('DELETE', '/me/delete', authId)).statusCode).toBe(204);
    expect((await call('GET', '/me', authId)).json().status).toBe('onboarding');
  });

  it('it only ever touches the caller’s own account', async () => {
    const member = await seedMember();
    const other = await seedMember();
    await call('POST', '/me/delete', member.authId);
    expect(await statusOf(other.userId)).toBe('active');
  });

  it('needs a signed-in caller', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/me/delete' });
    expect(res.statusCode).toBe(401);
  });
});

describe('a safety hold', () => {
  it.each(['suspended', 'banned'])('a %s account is held, in general terms', async (status) => {
    const member = await seedMember(status);
    const res = await call('POST', '/me/delete', member.authId);
    expect(res.statusCode).toBe(202);
    const body = deletionRequestSchema.parse(res.json());
    expect(body.status).toBe('held');
    expect(body.heldReason).toMatch(/safety review/);
  });

  it('an open report holds it, and does not say who reported or why', async () => {
    const member = await seedMember();
    const reporter = await seedMember();
    expect(
      (
        await call('POST', '/reports', reporter.authId, {
          reportedUserId: member.userId,
          category: 'other',
          description: 'Something a moderator should look at closely',
        })
      ).statusCode,
    ).toBe(201);
    const res = await call('POST', '/me/delete', member.authId);
    const body = deletionRequestSchema.parse(res.json());
    expect(body.status).toBe('held');
    expect(res.body).not.toContain(reporter.userId);
    expect(res.body).not.toContain('Something a moderator');
  });
});

describe('cancelling', () => {
  it.each([
    ['active', 'active'],
    ['deactivated', 'deactivated'],
    ['suspended', 'suspended'],
    ['banned', 'banned'],
  ])('a member who was %s returns to exactly that', async (before, after) => {
    const member = await seedMember(before);
    await call('POST', '/me/delete', member.authId);
    expect(await statusOf(member.userId)).toBe('pending_deletion');
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
    expect(await statusOf(member.userId)).toBe(after);
  });

  it('an active member is fully back, and visible again', async () => {
    const member = await seedMember();
    const other = await seedMember();
    await call('POST', '/me/delete', member.authId);
    await call('DELETE', '/me/delete', member.authId);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(200);
    expect((await call('GET', `/profiles/${member.userId}`, other.authId)).statusCode).toBe(200);
  });

  it('with nothing open there is nothing to cancel', async () => {
    const member = await seedMember();
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(404);
  });

  it('after cancelling the member can ask again', async () => {
    const member = await seedMember();
    await call('POST', '/me/delete', member.authId);
    await call('DELETE', '/me/delete', member.authId);
    expect((await call('POST', '/me/delete', member.authId)).statusCode).toBe(202);
  });
});

describe('when the grace period ends', () => {
  it('NOTHING DELETES THE ACCOUNT. Reported, not executed: a production blocker', async () => {
    const member = await seedMember();
    await call('POST', '/me/delete', member.authId);
    await harness.raw.query(
      `update public.account_deletion_requests
          set requested_at = now() - interval '31 days', scheduled_for = now() - interval '1 day'
        where user_id = $1::uuid`,
      [member.userId],
    );

    const queryable: Queryable = {
      query: <T>(sql: string, params?: unknown[]) => harness.raw.query<T>(sql, params as never[]),
    };
    const report = await runMaintenance(queryable, { apply: true });
    const due = report.results.find((r) => r.task.startsWith('deletion requests past'));
    expect(due?.mode).toBe('report');
    expect(due?.rows).toBeGreaterThanOrEqual(1);

    const still = await harness.raw.query<{ display_name: string; deleted_at: string | null }>(
      `select display_name, deleted_at from public.users where id = $1::uuid`,
      [member.userId],
    );
    expect(still.rows[0]).toEqual({ display_name: 'Member', deleted_at: null });
  });
});
