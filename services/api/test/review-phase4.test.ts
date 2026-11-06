import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Code review remediation, Phase 4 — L10 endpoints, through the real routes.
 *
 * Every operation here is specified in docs/openapi.yaml; the tables behind
 * the new ones come from migration 0030 (ERD §3, §9, §15). Each block checks
 * the authorization edge (another member's data, a hidden member, a missing
 * entitlement), validation, and the rule the operation exists to enforce.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(gender: 'male' | 'female', status = 'active'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1::text, $2::text, date '1995-06-15', 'pk', $3, now()) returning id`,
    [`Phase4 ${seq}`, gender, status],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(
    `insert into public.user_settings (user_id, timezone) values ($1::uuid, 'Asia/Karachi')`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.verification_status (user_id, email_verified_at) values ($1::uuid, now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  auth: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  harness.app.inject({
    method,
    url,
    headers: { ...(auth ? authHeader(auth) : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await harness.raw.query<T>(sql, params)).rows[0]!;

async function grant(member: Member, key: string): Promise<void> {
  await harness.raw.query(
    `insert into public.user_entitlements (user_id, entitlement_key, value) values ($1::uuid, $2, 'true'::jsonb)`,
    [member.userId, key],
  );
}

async function matchOf(a: Member, b: Member): Promise<string> {
  const sent = await call('POST', '/interests', b.authId, { recipientUserId: a.userId });
  expect(sent.statusCode, sent.body).toBe(201);
  const accepted = await call('POST', `/interests/${sent.json().id}/respond`, a.authId, {
    decision: 'accept',
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return accepted.json().match.id as string;
}

async function linkDelegate(owner: Member, delegate: Member): Promise<void> {
  seq += 1;
  const created = await call('POST', '/family/invitations', owner.authId, {
    inviteeContact: `phase4-${seq}@example.com`,
    relationshipCode: 'father',
    tier: 'reviewer',
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id, token } = created.json() as { id: string; token: string };
  const accepted = await call('POST', `/family/invitations/${id}/respond`, delegate.authId, {
    token,
    accept: true,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
}

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// =============================================================================
// Entitlements, quotas, usage, verification
// =============================================================================

describe('GET /me/entitlements, /me/quotas, /me/usage, /me/verification', () => {
  it('reports the free plan, and a grant with its source', async () => {
    const member = await seedMember('female');
    await grant(member, 'who_viewed_me');
    const body = (await call('GET', '/me/entitlements', member.authId)).json();
    expect(body.planKey).toBe('free');
    const byKey = Object.fromEntries((body.items as { key: string }[]).map((i) => [i.key, i]));
    expect(byKey.daily_interests).toMatchObject({ value: 5, source: 'plan', expiresAt: null });
    expect(byKey.who_viewed_me).toMatchObject({ value: true, source: 'grant' });
  });

  it('counts today’s interests in the member’s own day and says when it resets', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    expect(
      (await call('POST', '/interests', sender.authId, { recipientUserId: recipient.userId }))
        .statusCode,
    ).toBe(201);
    for (const url of ['/me/quotas', '/me/usage']) {
      const item = (await call('GET', url, sender.authId)).json().items[0];
      expect(item).toMatchObject({ key: 'daily_interests', used: 1, limit: 5, remaining: 4 });
      const expected = await one<{ at: string }>(
        `select to_char(((now() at time zone 'Asia/Karachi')::date + 1)::timestamp at time zone 'Asia/Karachi'
                 at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
      );
      expect(item.resetsAt).toBe(expected.at);
    }
  });

  it('reports verification as booleans, never timestamps', async () => {
    const member = await seedMember('female');
    const body = (await call('GET', '/me/verification', member.authId)).json();
    expect(body).toEqual({
      emailVerified: true,
      phoneVerified: false,
      selfieVerified: false,
      idVerified: false,
      profileReviewed: false,
    });
  });

  it('requires sign-in', async () => {
    for (const url of ['/me/entitlements', '/me/quotas', '/me/usage', '/me/verification']) {
      expect((await call('GET', url, null)).statusCode).toBe(401);
    }
  });
});

// =============================================================================
// Security events and devices
// =============================================================================

describe('GET /me/security-events', () => {
  it('pages the caller’s own events, newest first, with no repeats', async () => {
    const member = await seedMember('female');
    const other = await seedMember('male');
    for (const [user, type, minutes] of [
      [member, 'sign_in', 30],
      [member, 'new_device', 20],
      [member, 'password_change', 10],
      [other, 'sign_in', 5],
    ] as const) {
      await harness.raw.query(
        `insert into public.security_events (user_id, event_type, approximate_country, created_at)
         values ($1::uuid, $2, 'pk', now() - make_interval(mins => $3::int))`,
        [user.userId, type, minutes],
      );
    }
    const first = (await call('GET', '/me/security-events?limit=2', member.authId)).json();
    expect(first.items.map((e: { eventType: string }) => e.eventType)).toEqual([
      'password_change',
      'new_device',
    ]);
    expect(first.items[0].approximateLocation).toBe('PK');
    const second = (
      await call(
        'GET',
        `/me/security-events?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        member.authId,
      )
    ).json();
    expect(second.items.map((e: { eventType: string }) => e.eventType)).toEqual(['sign_in']);
    expect(second.hasMore).toBe(false);
  });
});

describe('GET/DELETE /me/devices', () => {
  async function device(member: Member, deviceId: string): Promise<string> {
    return (
      await one<{ id: string }>(
        `insert into public.user_devices (user_id, device_id, platform, app_version)
         values ($1::uuid, $2, 'android', '1.0.0') returning id`,
        [member.userId, deviceId],
      )
    ).id;
  }

  it('lists live devices and marks the one making the request', async () => {
    const member = await seedMember('female');
    await device(member, 'phone-a');
    await device(member, 'phone-b');
    const body = (
      await call('GET', '/me/devices', member.authId, undefined, { 'x-device-id': 'phone-b' })
    ).json();
    expect(body.items).toHaveLength(2);
    expect(body.items.filter((d: { isCurrent: boolean }) => d.isCurrent)).toHaveLength(1);
  });

  it('revokes a device: gone from the list, its push token stopped, the event recorded', async () => {
    const member = await seedMember('female');
    const id = await device(member, 'phone-c');
    expect(
      (
        await call('POST', '/me/push-tokens', member.authId, {
          deviceId: 'phone-c',
          token: 'ExpoToken[abc12345]',
          platform: 'android',
        })
      ).statusCode,
    ).toBe(204);

    expect((await call('DELETE', `/me/devices/${id}`, member.authId)).statusCode).toBe(204);
    expect((await call('GET', '/me/devices', member.authId)).json().items).toEqual([]);
    const token = await one<{ invalidated: boolean }>(
      `select invalidated_at is not null as invalidated from public.push_tokens where user_id = $1::uuid`,
      [member.userId],
    );
    expect(token.invalidated).toBe(true);
    const events = await one<{ n: string }>(
      `select count(*)::text as n from public.security_events where user_id = $1::uuid and event_type = 'device_revoked'`,
      [member.userId],
    );
    expect(events.n).toBe('1');
    // Once only, and never someone else's.
    expect((await call('DELETE', `/me/devices/${id}`, member.authId)).statusCode).toBe(404);
    const stranger = await seedMember('male');
    const theirs = await device(stranger, 'their-phone');
    expect((await call('DELETE', `/me/devices/${theirs}`, member.authId)).statusCode).toBe(404);
  });
});

// =============================================================================
// Deactivate, reactivate, delete
// =============================================================================

describe('POST /me/deactivate, /me/reactivate', () => {
  it('hides a member and brings them back', async () => {
    const viewer = await seedMember('male');
    const member = await seedMember('female');
    expect((await call('POST', '/me/deactivate', member.authId)).statusCode).toBe(204);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(404);
    expect((await call('POST', '/me/reactivate', member.authId)).statusCode).toBe(204);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(200);
  });

  it('never lets a suspended member pass through deactivation to lift the suspension', async () => {
    const member = await seedMember('female', 'suspended');
    expect((await call('POST', '/me/deactivate', member.authId)).statusCode).toBe(409);
    expect((await call('POST', '/me/reactivate', member.authId)).statusCode).toBe(409);
    const status = await one<{ status: string }>(
      `select status from public.users where id = $1::uuid`,
      [member.userId],
    );
    expect(status.status).toBe('suspended');
  });
});

describe('POST/DELETE /me/delete', () => {
  it('schedules deletion after 30 days, hides the member, and can be cancelled', async () => {
    const viewer = await seedMember('male');
    const member = await seedMember('female');
    const requested = await call('POST', '/me/delete', member.authId);
    expect(requested.statusCode, requested.body).toBe(202);
    const body = requested.json();
    expect(body).toMatchObject({ status: 'pending', heldReason: null });
    const days = (Date.parse(body.scheduledFor) - Date.parse(body.requestedAt)) / 86_400_000;
    expect(days).toBeCloseTo(30, 3);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(404);
    expect((await call('POST', '/me/delete', member.authId)).statusCode).toBe(409);

    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(200);
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(404);
  });

  it('holds the request while a report about the member is open, in general terms', async () => {
    const reporter = await seedMember('male');
    const member = await seedMember('female');
    const filed = await call('POST', '/reports', reporter.authId, {
      reportedUserId: member.userId,
      category: 'harassment',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const body = (await call('POST', '/me/delete', member.authId)).json();
    expect(body.status).toBe('held');
    expect(body.heldReason).toMatch(/safety review/);
    expect(body.heldReason).not.toMatch(/harass|report/i);
  });

  it('restores the PREVIOUS status on cancel — a suspended member stays suspended', async () => {
    const member = await seedMember('female', 'suspended');
    expect((await call('POST', '/me/delete', member.authId)).json().status).toBe('held');
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
    const status = await one<{ status: string }>(
      `select status from public.users where id = $1::uuid`,
      [member.userId],
    );
    expect(status.status).toBe('suspended');
  });
});

// =============================================================================
// Notification preferences and push tokens
// =============================================================================

describe('/me/notification-preferences', () => {
  it('silences an in-app type for EVERY sender, through the database', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const matchId = await matchOf(alice, bilal);
    const conversation = await one<{ id: string }>(
      `select id from public.conversations where match_id = $1::uuid`,
      [matchId],
    );

    const put = await call('PUT', '/me/notification-preferences', alice.authId, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      types: [{ type: 'new_message', push: false, inApp: false }],
    });
    expect(put.statusCode, put.body).toBe(200);
    const saved = put.json();
    expect(saved).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    expect(saved.types.find((t: { type: string }) => t.type === 'new_message')).toEqual({
      type: 'new_message',
      push: false,
      inApp: false,
    });
    expect(saved.types.find((t: { type: string }) => t.type === 'new_match')).toMatchObject({
      inApp: true,
    });

    expect(
      (
        await call('POST', `/conversations/${conversation.id}/messages`, bilal.authId, {
          body: 'Salaam',
        })
      ).statusCode,
    ).toBe(201);
    const inbox = await one<{ n: string }>(
      `select count(*)::text as n from public.notifications where user_id = $1::uuid and type = 'new_message'`,
      [alice.userId],
    );
    expect(inbox.n).toBe('0');
  });

  it.each([
    [
      'security alerts turned off in-app',
      {
        quietHoursStart: null,
        quietHoursEnd: null,
        types: [{ type: 'security_alert', push: true, inApp: false }],
      },
    ],
    ['half a quiet-hours window', { quietHoursStart: '22:00', quietHoursEnd: null, types: [] }],
    [
      'a type twice',
      {
        quietHoursStart: null,
        quietHoursEnd: null,
        types: [
          { type: 'new_match', push: true, inApp: true },
          { type: 'new_match', push: false, inApp: true },
        ],
      },
    ],
    [
      'an unknown type',
      {
        quietHoursStart: null,
        quietHoursEnd: null,
        types: [{ type: 'marketing', push: true, inApp: true }],
      },
    ],
    ['a malformed time', { quietHoursStart: '25:00', quietHoursEnd: '07:00', types: [] }],
  ])('refuses %s', async (_label, payload) => {
    const member = await seedMember('female');
    expect(
      (await call('PUT', '/me/notification-preferences', member.authId, payload)).statusCode,
    ).toBe(400);
  });
});

describe('/me/push-tokens', () => {
  it('registers, re-registers in place, and unregisters idempotently', async () => {
    const member = await seedMember('female');
    const body = { deviceId: 'phone-x', token: 'ExpoToken[first0001]', platform: 'ios' };
    expect((await call('POST', '/me/push-tokens', member.authId, body)).statusCode).toBe(204);
    expect(
      (
        await call('POST', '/me/push-tokens', member.authId, {
          ...body,
          token: 'ExpoToken[second002]',
        })
      ).statusCode,
    ).toBe(204);
    const row = await one<{ n: string; token: string }>(
      `select count(*)::text as n, max(token) as token from public.push_tokens where user_id = $1::uuid`,
      [member.userId],
    );
    expect(row).toEqual({ n: '1', token: 'ExpoToken[second002]' });
    expect((await call('DELETE', '/me/push-tokens/phone-x', member.authId)).statusCode).toBe(204);
    expect((await call('DELETE', '/me/push-tokens/phone-x', member.authId)).statusCode).toBe(204);
  });

  it('refuses a malformed registration', async () => {
    const member = await seedMember('female');
    expect(
      (
        await call('POST', '/me/push-tokens', member.authId, {
          deviceId: 'd',
          token: 'x',
          platform: 'windows',
        })
      ).statusCode,
    ).toBe(400);
  });
});

// =============================================================================
// Profile views, preview
// =============================================================================

describe('POST /profiles/{userId}/view and GET /me/profile-views', () => {
  it('records a view once per window, and only of a profile the viewer may see', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    expect((await call('POST', `/profiles/${target.userId}/view`, viewer.authId)).statusCode).toBe(
      204,
    );
    expect((await call('POST', `/profiles/${target.userId}/view`, viewer.authId)).statusCode).toBe(
      204,
    );
    const rows = await one<{ n: string }>(
      `select count(*)::text as n from public.profile_views where viewer_user_id = $1::uuid`,
      [viewer.userId],
    );
    expect(rows.n).toBe('1');
    const hidden = await seedMember('female', 'suspended');
    expect((await call('POST', `/profiles/${hidden.userId}/view`, viewer.authId)).statusCode).toBe(
      404,
    );
    expect((await call('POST', `/profiles/${viewer.userId}/view`, viewer.authId)).statusCode).toBe(
      404,
    );
  });

  it('is entitlement-gated, and hides incognito and blocked viewers', async () => {
    const me = await seedMember('female');
    const plain = await seedMember('male');
    const incognito = await seedMember('male');
    const blocked = await seedMember('male');
    await grant(incognito, 'incognito');
    await harness.raw.query(
      `update public.user_settings set incognito = true where user_id = $1::uuid`,
      [incognito.userId],
    );
    for (const v of [plain, incognito, blocked]) {
      expect((await call('POST', `/profiles/${me.userId}/view`, v.authId)).statusCode).toBe(204);
    }
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [me.userId, blocked.userId],
    );

    const refused = await call('GET', '/me/profile-views', me.authId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('entitlement_required');

    await grant(me, 'who_viewed_me');
    const page = (await call('GET', '/me/profile-views', me.authId)).json();
    expect((page.items as { userId: string }[]).map((c) => c.userId)).toEqual([plain.userId]);
  });
});

describe('GET /me/profile/preview', () => {
  it('shows exactly what each relationship would see', async () => {
    const member = await seedMember('female');
    await harness.raw.query(
      `insert into public.profile_field_visibility (user_id, field_key, visibility) values ($1::uuid, 'about_me', 'matched_only')`,
      [member.userId],
    );
    const asStranger = (await call('GET', '/me/profile/preview?as=stranger', member.authId)).json();
    expect(asStranger).not.toHaveProperty('aboutMe');
    expect(asStranger.viewerRelationship).toBe('stranger');
    for (const as of ['match', 'wali']) {
      const view = (await call('GET', `/me/profile/preview?as=${as}`, member.authId)).json();
      expect(view.aboutMe).toBe('A sufficiently long about-me for this member.');
    }
    expect((await call('GET', '/me/profile/preview?as=moderator', member.authId)).statusCode).toBe(
      400,
    );
  });
});

// =============================================================================
// Preferences, impact, recompute
// =============================================================================

describe('PATCH /me/preferences and GET /me/preferences/impact', () => {
  it('applies only the fields sent', async () => {
    const member = await seedMember('male');
    expect(
      (await call('PUT', '/me/preferences', member.authId, { ageMin: 22, ageMax: 30 })).statusCode,
    ).toBe(200);
    const patched = await call('PATCH', '/me/preferences', member.authId, { ageMax: 35 });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ ageMin: 22, ageMax: 35 });
  });

  it('counts the pool with and without each hard criterion', async () => {
    const viewer = await seedMember('male');
    const practising = await seedMember('female');
    const other = await seedMember('female');
    await harness.raw.query(
      `update public.profiles set religious_practice_code = 'rel_moderately_practising' where user_id = $1::uuid`,
      [other.userId],
    );
    void practising;
    await harness.raw.query(
      `insert into public.partner_preferences (user_id, religious_practice_codes) values ($1::uuid, array['rel_practising'])
       on conflict (user_id) do update set religious_practice_codes = excluded.religious_practice_codes`,
      [viewer.userId],
    );
    await harness.raw.query(
      `insert into public.preference_rules (user_id, criterion, is_hard, weight) values ($1::uuid, 'religious', true, 1)`,
      [viewer.userId],
    );
    const impact = (await call('GET', '/me/preferences/impact', viewer.authId)).json();
    expect(impact.withoutHardFilters).toBeGreaterThan(impact.matchingProfiles);
    const religious = (
      impact.narrowestCriteria as { criterion: string; excludedCount: number }[]
    ).find((c) => c.criterion === 'religious');
    expect(religious?.excludedCount).toBe(impact.withoutHardFilters - impact.matchingProfiles);
    expect(impact.capped).toBe(false);
  });
});

describe('POST /compatibility/recompute', () => {
  it('recomputes now, then refuses a second run within a minute', async () => {
    const member = await seedMember('male');
    const first = await call('POST', '/compatibility/recompute', member.authId);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ status: 'completed' });
    const second = await call('POST', '/compatibility/recompute', member.authId);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
  });
});

// =============================================================================
// Family review: GET/POST /matches/{matchId}/family-review
// =============================================================================

describe('/matches/{matchId}/family-review', () => {
  async function gatedMatch() {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    await linkDelegate(owner, delegate);
    expect(
      (await call('PATCH', '/me', owner.authId, { communicationPolicy: 'family_reviewed' }))
        .statusCode,
    ).toBe(200);
    const matchId = await matchOf(owner, suitor);
    return { owner, delegate, suitor, matchId };
  }

  it('shows the owner their own side in full, and the counterpart only a flag', async () => {
    const { owner, delegate, suitor, matchId } = await gatedMatch();
    await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'reject',
      note: 'Not now.',
    });

    const mine = (await call('GET', `/matches/${matchId}/family-review`, owner.authId)).json();
    expect(mine).toMatchObject({ state: 'rejected', mySideRequiresReview: true, note: 'Not now.' });
    expect(mine.decidedBy).toMatchObject({ userId: delegate.userId });

    const theirs = (await call('GET', `/matches/${matchId}/family-review`, suitor.authId)).json();
    expect(theirs).toMatchObject({
      state: 'rejected',
      mySideRequiresReview: false,
      counterpartSideRequiresReview: true,
      decidedBy: null,
      note: null,
    });
    const outsider = await seedMember('female');
    expect(
      (await call('GET', `/matches/${matchId}/family-review`, outsider.authId)).statusCode,
    ).toBe(404);
  });

  it('lets the owner ask their own family again after a decline (R16)', async () => {
    const { owner, delegate, matchId } = await gatedMatch();
    await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, { action: 'reject' });
    const before = await one<{ n: string }>(
      `select count(*)::text as n from public.notifications where user_id = $1::uuid and type = 'family_review_requested'`,
      [delegate.userId],
    );

    const again = await call('POST', `/matches/${matchId}/family-review`, owner.authId);
    expect(again.statusCode, again.body).toBe(200);
    const state = await one<{ s: string }>(
      `select communication_state as s from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(state.s).toBe('pending_family_review');
    const after = await one<{ n: string }>(
      `select count(*)::text as n from public.notifications where user_id = $1::uuid and type = 'family_review_requested'`,
      [delegate.userId],
    );
    expect(Number(after.n)).toBe(Number(before.n) + 1);
    // Pending and not overdue: nothing to ask again.
    expect((await call('POST', `/matches/${matchId}/family-review`, owner.authId)).statusCode).toBe(
      409,
    );
  });

  it('never overrules the OTHER family', async () => {
    const owner = await seedMember('female');
    const ownerDelegate = await seedMember('male');
    const suitor = await seedMember('male');
    const suitorDelegate = await seedMember('female');
    await linkDelegate(owner, ownerDelegate);
    await linkDelegate(suitor, suitorDelegate);
    for (const m of [owner, suitor]) {
      await call('PATCH', '/me', m.authId, { communicationPolicy: 'family_reviewed' });
    }
    const matchId = await matchOf(owner, suitor);
    // The suitor's family rejects. (Once one family rejects, B1 refuses any
    // further decision, so the owner's own review stays undecided.) Even when
    // the owner's side is overdue — normally grounds to ask again — the other
    // family's decision stands.
    const rejected = await call(
      'POST',
      `/family/reviews/${matchId}/decide`,
      suitorDelegate.authId,
      { action: 'reject' },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    void ownerDelegate;
    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '80 hours'
        where match_id = $1::uuid and owner_user_id = $2::uuid`,
      [matchId, owner.userId],
    );
    const refused = await call('POST', `/matches/${matchId}/family-review`, owner.authId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/other family/);
  });

  it('allows a re-request once the owner’s review is overdue', async () => {
    const { owner, matchId } = await gatedMatch();
    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '80 hours' where match_id = $1::uuid`,
      [matchId],
    );
    expect((await call('POST', `/matches/${matchId}/family-review`, owner.authId)).statusCode).toBe(
      200,
    );
  });
});
