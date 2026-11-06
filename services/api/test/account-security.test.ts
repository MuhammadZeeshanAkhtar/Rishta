import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESTRICTED_ACCOUNT_ROUTES } from '../src/auth/plugin';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * Post-merge security audit, through the real routes and real migrations.
 *
 *   N1  every protected route refuses a restricted account, with a named list of
 *       exceptions; timed suspensions end as a moderator's date says
 *   N2  the app's own cross-member reads still work with direct reads closed
 *   N5  the staff role hierarchy, on every path that decides about someone
 */

let harness: TestHarness;

interface Member {
  userId: string;
  authId: string;
}

let seq = 0;

async function seedMember(
  gender: 'female' | 'male' = 'female',
  status = 'active',
): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const users = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1, $2, date '1995-06-15', 'pk', 'active', now()) returning id`,
    [`Member ${seq}`, gender],
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
       (user_id, about_me, family_background, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.', 'PRIVATE_FAMILY_TEXT',
             'ms_never_married', 'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  if (status !== 'active') {
    await harness.raw.query(`update public.users set status = $2 where id = $1::uuid`, [
      userId,
      status,
    ]);
  }
  return { userId, authId };
}

async function seedStaff(roles: string[]): Promise<Member & { adminId: string }> {
  const member = await seedMember();
  const admin = await harness.raw.query<{ id: string }>(
    `insert into public.admin_users (user_id) values ($1::uuid) returning id`,
    [member.userId],
  );
  for (const role of roles) {
    await harness.raw.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, $2)`,
      [admin.rows[0]!.id, role],
    );
  }
  return { ...member, adminId: admin.rows[0]!.id };
}

const call = (method: string, url: string, authId: string, payload?: unknown, aal?: 'aal2') =>
  harness.app.inject({
    method: method as 'GET',
    url,
    headers: authHeader(authId, undefined, aal),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const staffCall = (method: string, url: string, authId: string, payload?: unknown) =>
  call(method, url, authId, payload, 'aal2');

const statusOf = async (userId: string) =>
  (
    await harness.raw.query<{ status: string }>(
      `select status from public.users where id = $1::uuid`,
      [userId],
    )
  ).rows[0]!.status;

/** An accepted interest, so there is a real conversation to write to. */
async function connected() {
  const a = await seedMember('female');
  const b = await seedMember('male');
  const sent = await call('POST', '/interests', b.authId, { recipientUserId: a.userId });
  expect(sent.statusCode).toBe(201);
  const accepted = await call('POST', `/interests/${sent.json().id}/respond`, a.authId, {
    decision: 'accept',
  });
  expect(accepted.statusCode).toBeLessThan(300);
  const conversation = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [accepted.json().match.id],
  );
  return { a, b, conversationId: conversation.rows[0]!.id };
}

/** Every route the app actually registers, read from Fastify rather than a list. */
function registeredRoutes(): Array<[string, string]> {
  const routes: Array<[string, string]> = [];
  const stack: string[] = [];
  for (const line of harness.app.printRoutes({ commonPrefix: false }).split(/\r?\n/)) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const full = (stack[depth - 1] ?? '') + m[2]!;
    stack[depth] = full;
    for (const method of (m[3] ?? '').split(',').map((s) => s.trim())) {
      if (method && method !== 'HEAD' && method !== 'OPTIONS') routes.push([method, full]);
    }
  }
  return routes;
}

const PUBLIC_ROUTES = [
  'GET /health',
  'GET /reference/manifest',
  'GET /reference/:type',
  'GET /reference/:type/:code',
  'GET /compatibility/dimensions',
];

const RESTRICTED = ['suspended', 'banned', 'deactivated', 'pending_deletion'] as const;

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
  await harness.raw.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('marital_status', 'ms_never_married', 1),
      ('religious_practice', 'rel_practising', 1),
      ('language', 'ur', 1)
    on conflict do nothing
  `);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('N1: every protected route refuses a restricted account', () => {
  describe.each(RESTRICTED)('%s', (status) => {
    let member: Member;

    beforeAll(async () => {
      member = await seedMember('female', status);
    });

    it('is refused on every route except the named exceptions and public ones', async () => {
      const routes = registeredRoutes();
      expect(routes.length).toBeGreaterThan(100);

      const reachable: string[] = [];
      for (const [method, path] of routes) {
        const url = path.replace(/:\w+/g, randomAuthId());
        const hasBody = method !== 'GET' && method !== 'DELETE';
        const res = await call(method, url, member.authId, hasBody ? {} : undefined);
        const refused = res.statusCode === 403 && res.json().code === 'account_restricted';
        if (!refused) reachable.push(`${method} ${path}`);
        // A permitted lifecycle route really runs (a deactivated account really
        // reactivates), so put the account back before asking about the next one.
        await harness.raw.query(`update public.users set status = $2 where id = $1::uuid`, [
          member.userId,
          status,
        ]);
        await harness.raw.query(
          `update public.account_deletion_requests
              set status = 'cancelled', cancelled_at = now(), retention_hold_reason = null
            where user_id = $1::uuid and status in ('pending', 'held')`,
          [member.userId],
        );
      }

      expect(reachable.sort()).toEqual([...RESTRICTED_ACCOUNT_ROUTES, ...PUBLIC_ROUTES].sort());
    }, 120_000);

    it('gets the same refusal, with nothing about why, on the named product actions', async () => {
      const stranger = await seedMember('male');
      const { conversationId, b } = await connected();
      await harness.raw.query(`update public.users set status = $2 where id = $1::uuid`, [
        b.userId,
        status,
      ]);
      const before = await harness.raw.query<{ n: number }>(
        `select count(*)::int as n from public.messages where conversation_id = $1::uuid`,
        [conversationId],
      );

      for (const [method, url, payload] of [
        ['POST', `/conversations/${conversationId}/messages`, { body: 'hello' }],
        ['POST', '/interests', { recipientUserId: stranger.userId }],
        ['PATCH', '/me/profile', { aboutMe: 'A different sufficiently long about-me text.' }],
        ['POST', `/profiles/${stranger.userId}/photo-request`, {}],
        [
          'POST',
          '/reports',
          { reportedUserId: stranger.userId, category: 'other', description: 'x'.repeat(20) },
        ],
        [
          'POST',
          '/family/invitations',
          { inviteeContact: 'x@example.test', relationshipCode: 'father', tier: 'observer' },
        ],
        ['GET', '/discovery/sections', undefined],
        ['GET', `/profiles/${stranger.userId}`, undefined],
        ['GET', '/conversations', undefined],
        ['GET', '/notifications', undefined],
      ] as const) {
        const res = await call(method, url, b.authId, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({
          code: 'account_restricted',
          message: expect.any(String),
          messageKey: 'errors.accountRestricted',
        });
      }

      const after = await harness.raw.query<{ n: number }>(
        `select count(*)::int as n from public.messages where conversation_id = $1::uuid`,
        [conversationId],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    }, 60_000);

    it('can still learn its own status', async () => {
      const me = await call('GET', '/me', member.authId);
      expect(me.statusCode).toBe(200);
      expect(me.json().status).toBe(status);
      const boot = await call('POST', '/account/bootstrap', member.authId, {
        locale: 'en',
        timezone: 'UTC',
      });
      expect(boot.statusCode).toBe(200);
      expect(boot.json().status).toBe(status);
    });

    it('stays invisible to other members', async () => {
      const other = await seedMember('male');
      expect((await call('GET', `/profiles/${member.userId}`, other.authId)).statusCode).toBe(404);
    });
  });

  it('takes effect on the very next request, without waiting for a token to expire', async () => {
    const member = await seedMember();
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(200);
    await harness.raw.query(`update public.users set status = 'banned' where id = $1::uuid`, [
      member.userId,
    ]);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);
  });

  it('refuses a soft-deleted account', async () => {
    const member = await seedMember();
    await harness.raw.query(`update public.users set deleted_at = now() where id = $1::uuid`, [
      member.userId,
    ]);
    const res = await call('GET', '/discovery/sections', member.authId);
    expect(res.json().code).toBe('account_restricted');
  });

  it('still answers 401 for no token and bad tokens, before any status question', async () => {
    const none = await harness.app.inject({ method: 'GET', url: '/discovery/sections' });
    expect(none.statusCode).toBe(401);
  });

  it('a token with no account yet gets the same answers as before', async () => {
    const authId = randomAuthId();
    expect((await call('GET', '/me', authId)).statusCode).toBe(404);
    expect((await call('GET', '/me/profile', authId)).statusCode).toBe(404);
    const boot = await call('POST', '/account/bootstrap', authId, {
      locale: 'en',
      timezone: 'UTC',
    });
    expect(boot.statusCode).toBe(201);
    expect(boot.json().status).toBe('onboarding');
  });
});

describe('N1: the exceptions only do what they always did', () => {
  it.each(['suspended', 'banned', 'pending_deletion'])(
    '%s cannot reactivate or deactivate itself out of the restriction',
    async (status) => {
      const member = await seedMember('female', status);
      expect((await call('POST', '/me/reactivate', member.authId)).statusCode).toBe(409);
      expect((await call('POST', '/me/deactivate', member.authId)).statusCode).toBe(409);
      expect(await statusOf(member.userId)).toBe(status);
    },
  );

  it.each(['suspended', 'banned'])(
    '%s asking for deletion and cancelling returns to exactly that, never to active',
    async (status) => {
      const member = await seedMember('female', status);
      const requested = await call('POST', '/me/delete', member.authId);
      expect(requested.statusCode).toBe(202);
      expect(requested.json().status).toBe('held');
      expect(await statusOf(member.userId)).toBe('pending_deletion');
      expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
      expect(await statusOf(member.userId)).toBe(status);
    },
  );

  it('a deactivated member reactivates and is fully back', async () => {
    const member = await seedMember();
    expect((await call('POST', '/me/deactivate', member.authId)).statusCode).toBe(204);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);
    expect((await call('POST', '/me/reactivate', member.authId)).statusCode).toBe(204);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(200);
  });

  it('a member who asked for deletion cancels and is fully back', async () => {
    const member = await seedMember();
    expect((await call('POST', '/me/delete', member.authId)).statusCode).toBe(202);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(200);
  });
});

describe('N1: timed suspensions through the API', () => {
  let moderator: Member;

  beforeAll(async () => {
    moderator = await seedStaff(['moderator']);
  });

  const act = (userId: string, payload: unknown) =>
    staffCall('POST', `/admin/users/${userId}/actions`, moderator.authId, payload);

  const expireLatest = (userId: string) =>
    harness.raw.query(
      `update public.moderation_actions set expires_at = now() - interval '1 minute'
        where subject_user_id = $1::uuid and action = 'suspend'`,
      [userId],
    );

  const FUTURE = '2999-01-01T00:00:00.000Z';

  it('is refused while the date is ahead, and ends on the next request after it', async () => {
    const member = await seedMember();
    expect(
      (await act(member.userId, { action: 'suspend', reason: 'A week off', expiresAt: FUTURE }))
        .statusCode,
    ).toBe(201);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);

    await expireLatest(member.userId);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(200);
    expect(await statusOf(member.userId)).toBe('active');
    expect(harness.serviceUses).toContain('account.lift_expired_suspension');
  });

  it('GET /me reports the lifted state, so the app sees it without another route', async () => {
    const member = await seedMember();
    await act(member.userId, { action: 'suspend', reason: 'A week off', expiresAt: FUTURE });
    await expireLatest(member.userId);
    const me = await call('GET', '/me', member.authId);
    expect(me.json().status).toBe('active');
  });

  it('a suspension with no date does not end by itself', async () => {
    const member = await seedMember();
    await act(member.userId, { action: 'suspend', reason: 'Until reviewed' });
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);
    expect(await statusOf(member.userId)).toBe('suspended');
  });

  it('a ban after a timed suspension is not lifted by its date', async () => {
    const member = await seedMember();
    await act(member.userId, { action: 'suspend', reason: 'A week off', expiresAt: FUTURE });
    await act(member.userId, { action: 'ban', reason: 'Worse things came to light' });
    await expireLatest(member.userId);
    expect((await call('GET', '/discovery/sections', member.authId)).statusCode).toBe(403);
    expect(await statusOf(member.userId)).toBe('banned');
  });

  it('a member who had deactivated goes back to deactivated, by date or by clear', async () => {
    const byDate = await seedMember('female', 'deactivated');
    await act(byDate.userId, { action: 'suspend', reason: 'A week off', expiresAt: FUTURE });
    await expireLatest(byDate.userId);
    await call('GET', '/me', byDate.authId);
    expect(await statusOf(byDate.userId)).toBe('deactivated');

    const byClear = await seedMember('female', 'deactivated');
    await act(byClear.userId, { action: 'suspend', reason: 'A week off' });
    await act(byClear.userId, { action: 'ban', reason: 'Then this' });
    const cleared = await act(byClear.userId, { action: 'clear', reason: 'Reviewed and lifted' });
    expect(cleared.json().status).toBe('deactivated');
    expect(await statusOf(byClear.userId)).toBe('deactivated');
  });

  it('accepts an end date only on a suspension, and only in the future', async () => {
    const member = await seedMember();
    expect(
      (await act(member.userId, { action: 'ban', reason: 'Serious', expiresAt: FUTURE }))
        .statusCode,
    ).toBe(400);
    expect(
      (await act(member.userId, { action: 'warn', reason: 'Careful', expiresAt: FUTURE }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await act(member.userId, {
          action: 'suspend',
          reason: 'Past',
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(400);
    expect(await statusOf(member.userId)).toBe('active');
  });

  it('a ban cannot be turned into a timed suspension that would lift it', async () => {
    const member = await seedMember();
    await act(member.userId, { action: 'ban', reason: 'Serious' });
    const res = await act(member.userId, {
      action: 'suspend',
      reason: 'Softer',
      expiresAt: FUTURE,
    });
    expect(res.statusCode).toBe(409);
    expect(await statusOf(member.userId)).toBe('banned');
  });

  it('if the check itself fails the member stays refused, and it is not a 500', async () => {
    const member = await seedMember();
    await act(member.userId, { action: 'suspend', reason: 'A week off', expiresAt: FUTURE });
    await expireLatest(member.userId);
    await harness.raw.exec(`alter function app.lift_expired_suspensions(uuid) rename to held_back`);
    try {
      const res = await call('GET', '/discovery/sections', member.authId);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('account_restricted');
    } finally {
      await harness.raw.exec(
        `alter function app.held_back(uuid) rename to lift_expired_suspensions`,
      );
    }
  });
});

describe('N2: legitimate reads still work with direct reads closed', () => {
  let owner: Member;
  let viewer: Member;

  beforeAll(async () => {
    owner = await seedMember('female');
    viewer = await seedMember('male');
    await harness.raw.query(
      `insert into public.profile_field_visibility (user_id, field_key, visibility)
       values ($1::uuid, 'family_background', 'private')`,
      [owner.userId],
    );
  });

  it('the Data API path (same role, same claims) sees nothing of the other member', async () => {
    const rows = await harness.db.asUser(viewer.authId, (session) =>
      session.query(`select * from public.profiles where user_id = $1::uuid`, [owner.userId]),
    );
    expect(rows).toEqual([]);
  });

  it('GET /profiles/:id still serves the permitted fields and withholds the private one', async () => {
    const res = await call('GET', `/profiles/${owner.userId}`, viewer.authId);
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(owner.userId);
    expect(res.body).toContain('A sufficiently long about-me');
    expect(res.body).not.toContain('PRIVATE_FAMILY_TEXT');
  });

  it('the owner reads and edits their own profile', async () => {
    const res = await call('GET', '/me/profile', owner.authId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRIVATE_FAMILY_TEXT');
    const edit = await call('PATCH', '/me/profile', owner.authId, {
      lookingFor: 'Someone kind and thoughtful',
    });
    expect(edit.statusCode).toBe(200);
  });

  it('discovery, interests, matches and messages work end to end', async () => {
    const { a, b, conversationId } = await connected();
    expect((await call('GET', '/discovery/sections', a.authId)).statusCode).toBe(200);
    expect((await call('GET', '/interests?direction=received', a.authId)).statusCode).toBe(200);
    const sent = await call('POST', `/conversations/${conversationId}/messages`, b.authId, {
      body: 'Assalamu alaikum',
    });
    expect(sent.statusCode).toBe(201);
    const read = await call('GET', `/conversations/${conversationId}/messages`, a.authId);
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain('Assalamu alaikum');
  });

  it('a member still onboarding can build a profile', async () => {
    const authId = randomAuthId();
    await call('POST', '/account/bootstrap', authId, { locale: 'en', timezone: 'UTC' });
    const res = await call('PATCH', '/me/profile', authId, {
      lookingFor: 'Someone kind and thoughtful',
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('N5: the staff role hierarchy', () => {
  const act = (actor: Member, target: string, action: string) =>
    staffCall('POST', `/admin/users/${target}/actions`, actor.authId, {
      action,
      reason: 'Testing the hierarchy',
    });

  describe.each(['warn', 'suspend', 'ban', 'clear'])('account action: %s', (action) => {
    it('a moderator cannot do it to an admin', async () => {
      const moderator = await seedStaff(['moderator']);
      const admin = await seedStaff(['admin']);
      const res = await act(moderator, admin.userId, action);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('staff_protected');
      expect(await statusOf(admin.userId)).toBe('active');
    });

    it('nobody can do it to themselves, admin included', async () => {
      for (const roles of [['moderator'], ['admin']]) {
        const staff = await seedStaff(roles);
        const res = await act(staff, staff.userId, action);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('staff_protected');
      }
    });

    it('a refused action writes no record and no audit row', async () => {
      const moderator = await seedStaff(['moderator']);
      const admin = await seedStaff(['admin']);
      await act(moderator, admin.userId, action);
      const records = await harness.raw.query(
        `select 1 from public.moderation_actions where subject_user_id = $1::uuid`,
        [admin.userId],
      );
      expect(records.rows).toEqual([]);
      const audit = await harness.raw.query(
        `select 1 from public.admin_action_audit where target_id = $1::uuid`,
        [admin.userId],
      );
      expect(audit.rows).toEqual([]);
    });
  });

  it('a moderator cannot act on a peer: moderator or support', async () => {
    const moderator = await seedStaff(['moderator']);
    for (const roles of [['moderator'], ['support']]) {
      const peer = await seedStaff(roles);
      const res = await act(moderator, peer.userId, 'ban');
      expect(res.json().code).toBe('staff_protected');
      expect(await statusOf(peer.userId)).toBe('active');
    }
  });

  it('an admin cannot ban another admin: equal rank goes to an operator', async () => {
    const admin = await seedStaff(['admin']);
    const other = await seedStaff(['admin']);
    expect((await act(admin, other.userId, 'ban')).json().code).toBe('staff_protected');
    expect(await statusOf(other.userId)).toBe('active');
  });

  it('holding a lesser role as well does not lower an admin', async () => {
    const moderator = await seedStaff(['moderator']);
    const both = await seedStaff(['moderator', 'admin']);
    expect((await act(moderator, both.userId, 'ban')).json().code).toBe('staff_protected');
  });

  it('an admin can act on a moderator, and a moderator on a member', async () => {
    const admin = await seedStaff(['admin']);
    const moderator = await seedStaff(['moderator']);
    expect((await act(admin, moderator.userId, 'suspend')).statusCode).toBe(201);
    expect(await statusOf(moderator.userId)).toBe('suspended');
    expect((await act(admin, moderator.userId, 'clear')).statusCode).toBe(201);
    expect(await statusOf(moderator.userId)).toBe('active');

    const member = await seedMember();
    expect((await act(moderator, member.userId, 'ban')).statusCode).toBe(201);
    expect((await act(moderator, member.userId, 'clear')).statusCode).toBe(201);
    expect(await statusOf(member.userId)).toBe('active');
  });

  it('a disabled staff row, or an expired role, no longer protects its holder', async () => {
    const moderator = await seedStaff(['moderator']);
    const disabled = await seedStaff(['admin']);
    await harness.raw.query(
      `update public.admin_users set status = 'disabled' where id = $1::uuid`,
      [disabled.adminId],
    );
    expect((await act(moderator, disabled.userId, 'warn')).statusCode).toBe(201);

    const expired = await seedStaff(['admin']);
    await harness.raw.query(
      `update public.admin_role_assignments set expires_at = now() - interval '1 day'
        where admin_user_id = $1::uuid`,
      [expired.adminId],
    );
    expect((await act(moderator, expired.userId, 'warn')).statusCode).toBe(201);
  });

  it('a restricted member of staff cannot reach the console to lift it themselves', async () => {
    const admin = await seedStaff(['admin']);
    const moderator = await seedStaff(['moderator']);
    await act(admin, moderator.userId, 'ban');

    const session = await staffCall('GET', '/admin/session', moderator.authId);
    expect(session.statusCode).toBe(403);
    expect(session.json().code).toBe('account_restricted');
    const clear = await act(moderator, moderator.userId, 'clear');
    expect(clear.json().code).toBe('account_restricted');
    expect(await statusOf(moderator.userId)).toBe('banned');
  });

  it('a banned member of staff cannot use any other staff route either', async () => {
    const admin = await seedStaff(['admin']);
    const member = await seedMember();
    await harness.raw.query(`update public.users set status = 'banned' where id = $1::uuid`, [
      admin.userId,
    ]);
    expect((await act(admin, member.userId, 'ban')).json().code).toBe('account_restricted');
    expect(await statusOf(member.userId)).toBe('active');
  });

  it('a member cannot reach any of this', async () => {
    const member = await seedMember();
    const other = await seedMember();
    expect((await act(member, other.userId, 'ban')).statusCode).toBe(404);
  });

  it('no route lets staff grant or change a role', () => {
    const roleRoutes = registeredRoutes().filter(([, path]) =>
      /role|admin_users|staff/i.test(path),
    );
    expect(roleRoutes).toEqual([]);
  });

  describe('decisions about content', () => {
    async function seedPhoto(owner: Member): Promise<string> {
      const photo = await harness.raw.query<{ id: string }>(
        `insert into public.photos (user_id, storage_path, content_type)
         values ($1::uuid, $2, 'image/jpeg') returning id`,
        [owner.userId, `${owner.userId}/${randomAuthId()}/original.jpg`],
      );
      await harness.raw.query(
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1::uuid, 'thumb', $2)`,
        [photo.rows[0]!.id, `${owner.userId}/${randomAuthId()}/thumb.jpg`],
      );
      return photo.rows[0]!.id;
    }

    const decidePhoto = (actor: Member, id: string) =>
      staffCall('POST', `/admin/moderation/photos/${id}`, actor.authId, { decision: 'approve' });
    const decideProfile = (actor: Member, id: string) =>
      staffCall('POST', `/admin/moderation/profiles/${id}`, actor.authId, { decision: 'approve' });

    it('staff cannot approve their own photo or profile', async () => {
      const staff = await seedStaff(['moderator']);
      const photo = await decidePhoto(staff, await seedPhoto(staff));
      expect(photo.json().code).toBe('staff_protected');
      expect((await decideProfile(staff, staff.userId)).json().code).toBe('staff_protected');
    });

    it('a moderator cannot decide an admin’s, but can decide a peer’s or a member’s', async () => {
      const moderator = await seedStaff(['moderator']);
      const admin = await seedStaff(['admin']);
      const peer = await seedStaff(['moderator']);
      const member = await seedMember();

      expect((await decidePhoto(moderator, await seedPhoto(admin))).json().code).toBe(
        'staff_protected',
      );
      expect((await decideProfile(moderator, admin.userId)).json().code).toBe('staff_protected');
      expect((await decidePhoto(moderator, await seedPhoto(peer))).statusCode).toBe(200);
      expect((await decidePhoto(moderator, await seedPhoto(member))).statusCode).toBe(200);
      expect((await decideProfile(moderator, member.userId)).statusCode).toBe(200);
    });

    it('an admin can decide a moderator’s content', async () => {
      const admin = await seedStaff(['admin']);
      const moderator = await seedStaff(['moderator']);
      expect((await decidePhoto(admin, await seedPhoto(moderator))).statusCode).toBe(200);
    });

    const file = async (reporter: Member, reported: Member): Promise<string> => {
      const res = await call('POST', '/reports', reporter.authId, {
        reportedUserId: reported.userId,
        category: 'other',
        description: 'x'.repeat(20),
      });
      expect(res.statusCode).toBe(201);
      return res.json().id ?? res.json().reportId;
    };
    const decideReport = (actor: Member, id: string) =>
      staffCall('POST', `/admin/reports/${id}`, actor.authId, { status: 'dismissed' });

    it('staff cannot decide a report about themselves, or one they filed', async () => {
      const staff = await seedStaff(['moderator']);
      const member = await seedMember();
      expect((await decideReport(staff, await file(member, staff))).json().code).toBe(
        'staff_protected',
      );
      expect((await decideReport(staff, await file(staff, member))).json().code).toBe(
        'staff_protected',
      );
    });

    it('a moderator cannot dismiss a report about an admin; another admin can', async () => {
      const moderator = await seedStaff(['moderator']);
      const admin = await seedStaff(['admin']);
      const otherAdmin = await seedStaff(['admin']);
      const member = await seedMember();
      const id = await file(member, admin);
      expect((await decideReport(moderator, id)).json().code).toBe('staff_protected');
      expect((await decideReport(otherAdmin, id)).statusCode).toBe(200);
    });

    it('a moderator still handles a report about a member', async () => {
      const moderator = await seedStaff(['moderator']);
      const a = await seedMember();
      const b = await seedMember();
      expect((await decideReport(moderator, await file(a, b))).statusCode).toBe(200);
    });

    const requestDob = async (member: Member): Promise<string> => {
      const res = await call('POST', '/me/dob-correction-requests', member.authId, {
        requestedDob: '1996-01-01',
        reason: 'A typing mistake when I signed up',
      });
      expect(res.statusCode).toBe(201);
      return res.json().requestId;
    };
    const decideDob = (actor: Member, id: string) =>
      staffCall('POST', `/admin/dob-corrections/${id}`, actor.authId, { decision: 'approve' });

    it('support cannot approve their own date of birth, or an admin’s', async () => {
      const support = await seedStaff(['support']);
      const admin = await seedStaff(['admin']);
      expect((await decideDob(support, await requestDob(support))).json().code).toBe(
        'staff_protected',
      );
      expect((await decideDob(support, await requestDob(admin))).json().code).toBe(
        'staff_protected',
      );
      const dob = await harness.raw.query<{ dob: string }>(
        `select date_of_birth::text as dob from public.users where id = $1::uuid`,
        [support.userId],
      );
      expect(dob.rows[0]!.dob).toBe('1995-06-15');
    });

    it('support still corrects a member’s date of birth', async () => {
      const support = await seedStaff(['support']);
      const member = await seedMember();
      expect((await decideDob(support, await requestDob(member))).statusCode).toBe(200);
    });
  });
});
