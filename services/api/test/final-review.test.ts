import { findContactDetails } from '@nikahmate/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * Backend fixes from the final review of every workflow, through the real routes.
 */

let harness: TestHarness;

const seedMember = async (gender: 'female' | 'male' = 'female') => {
  const authId = randomAuthId();
  const users = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ('Member', $1, date '1995-06-15', 'pk', 'active', now()) returning id`,
    [gender],
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

const connected = async () => {
  const a = await seedMember('female');
  const b = await seedMember('male');
  const sent = await call('POST', '/interests', b.authId, { recipientUserId: a.userId });
  const accepted = await call('POST', `/interests/${sent.json().id}/respond`, a.authId, {
    decision: 'accept',
  });
  const conversation = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [accepted.json().match.id],
  );
  return { a, b, conversationId: conversation.rows[0]!.id, matchId: accepted.json().match.id };
};

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

describe('moving a conversation to the next stage', () => {
  it('tells the other person, with a link back to the conversation', async () => {
    const { a, b, conversationId } = await connected();
    expect(
      (await call('POST', `/conversations/${conversationId}/stage/propose`, b.authId, {}))
        .statusCode,
    ).toBe(201);
    const inbox = await call('GET', '/notifications', a.authId);
    const notice = inbox
      .json()
      .items.find((n: { type: string }) => n.type === 'stage_advance_proposed');
    expect(notice.data).toMatchObject({ conversationId, toStage: 2 });
    expect(notice.titleKey).toBe('notifications.stage_advance_proposed.title');
  });

  it('does not tell the person who proposed it', async () => {
    const { b, conversationId } = await connected();
    await call('POST', `/conversations/${conversationId}/stage/propose`, b.authId, {});
    const inbox = await call('GET', '/notifications', b.authId);
    expect(
      inbox.json().items.filter((n: { type: string }) => n.type === 'stage_advance_proposed'),
    ).toEqual([]);
  });

  it('runs through to the other person agreeing', async () => {
    const { a, b, conversationId } = await connected();
    await call('POST', `/conversations/${conversationId}/stage/propose`, b.authId, {});

    const seen = await call('GET', `/conversations/${conversationId}/stage`, a.authId);
    expect(seen.json().pendingProposal).toMatchObject({ toStage: 2, proposedByMe: false });

    const agreed = await call('POST', `/conversations/${conversationId}/stage/respond`, a.authId, {
      accept: true,
    });
    expect(agreed.statusCode).toBe(200);
    expect(agreed.json()).toMatchObject({ currentStage: 2, pendingProposal: null });
  });

  it('a member who turned the notification off does not get it', async () => {
    const { a, b, conversationId } = await connected();
    const settings = await call('GET', '/me/notification-preferences', a.authId);
    const types = settings
      .json()
      .types.map((t: { type: string; push: boolean; inApp: boolean }) =>
        t.type === 'stage_advance_proposed' ? { ...t, inApp: false } : t,
      );
    expect(
      (
        await call('PUT', '/me/notification-preferences', a.authId, {
          quietHoursStart: null,
          quietHoursEnd: null,
          types,
        })
      ).statusCode,
    ).toBe(200);
    await call('POST', `/conversations/${conversationId}/stage/propose`, b.authId, {});
    const inbox = await call('GET', '/notifications', a.authId);
    expect(
      inbox.json().items.filter((n: { type: string }) => n.type === 'stage_advance_proposed'),
    ).toEqual([]);
  });
});

describe('finding an approval again, to withdraw it', () => {
  const family = async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('female');
    const relationship = await harness.raw.query<{ id: string }>(
      `insert into public.family_relationships (owner_user_id, delegate_user_id, relationship_code, tier, status)
       values ($1::uuid, $2::uuid, 'mother', 'reviewer', 'active') returning id`,
      [owner.userId, delegate.userId],
    );
    await harness.raw.query(
      `insert into public.family_permissions (relationship_id, permission, granted, granted_by_user_id)
       values ($1::uuid, 'approve_communication', true, $2::uuid),
              ($1::uuid, 'view_matches', true, $2::uuid)`,
      [relationship.rows[0]!.id, owner.userId],
    );
    await harness.raw.query(
      `update public.user_settings set communication_policy = 'family_reviewed' where user_id = $1::uuid`,
      [owner.userId],
    );
    const suitor = await seedMember('male');
    const sent = await call('POST', '/interests', suitor.authId, { recipientUserId: owner.userId });
    const accepted = await call('POST', `/interests/${sent.json().id}/respond`, owner.authId, {
      decision: 'accept',
    });
    return { owner, delegate, suitor, matchId: accepted.json().match.id as string };
  };

  it('a pending review is in the default list, and not among the approved', async () => {
    const { delegate, matchId } = await family();
    const waiting = await call('GET', '/family/reviews', delegate.authId);
    expect(waiting.json().items.map((r: { matchId: string }) => r.matchId)).toContain(matchId);
    const approved = await call('GET', '/family/reviews?state=approved', delegate.authId);
    expect(approved.json().items).toEqual([]);
  });

  it('after approving it moves to the approved list, and can be withdrawn', async () => {
    const { delegate, matchId } = await family();
    expect(
      (
        await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, {
          action: 'approve',
        })
      ).statusCode,
    ).toBeLessThan(300);

    const waiting = await call('GET', '/family/reviews', delegate.authId);
    expect(waiting.json().items).toEqual([]);
    const approved = await call('GET', '/family/reviews?state=approved', delegate.authId);
    expect(approved.json().items.map((r: { matchId: string }) => r.matchId)).toEqual([matchId]);

    expect(
      (await call('POST', `/family/reviews/${matchId}/revoke`, delegate.authId, {})).statusCode,
    ).toBeLessThan(300);
    const after = await call('GET', '/family/reviews?state=approved', delegate.authId);
    expect(after.json().items).toEqual([]);
  });

  it('a state that does not exist is refused', async () => {
    const { delegate } = await family();
    const res = await call('GET', '/family/reviews?state=nonsense', delegate.authId);
    expect(res.statusCode).toBe(400);
  });

  it('nobody else sees them', async () => {
    const { suitor, matchId, delegate } = await family();
    await call('POST', `/family/reviews/${matchId}/decide`, delegate.authId, {
      action: 'approve',
    });
    const other = await call('GET', '/family/reviews?state=approved', suitor.authId);
    expect(other.json().items).toEqual([]);
  });
});

describe('the account screens the app now offers', () => {
  it('saved profiles come back, and can be removed', async () => {
    const me = await seedMember('female');
    const them = await seedMember('male');
    await call('PUT', `/discovery/shortlist/${them.userId}`, me.authId);
    const saved = await call('GET', '/discovery/shortlist', me.authId);
    expect(saved.json().items.map((c: { userId: string }) => c.userId)).toEqual([them.userId]);
    await call('DELETE', `/discovery/shortlist/${them.userId}`, me.authId);
    expect((await call('GET', '/discovery/shortlist', me.authId)).json().items).toEqual([]);
  });

  it('a block is listed, and undoing it restores the profile', async () => {
    const me = await seedMember('female');
    const them = await seedMember('male');
    await call('PUT', `/blocks/${them.userId}`, me.authId, {});
    expect((await call('GET', `/profiles/${them.userId}`, me.authId)).statusCode).toBe(404);
    const blocked = await call('GET', '/blocks', me.authId);
    expect(blocked.json().items.map((b: { userId: string }) => b.userId)).toEqual([them.userId]);
    await call('DELETE', `/blocks/${them.userId}`, me.authId);
    expect((await call('GET', '/blocks', me.authId)).json().items).toEqual([]);
    expect((await call('GET', `/profiles/${them.userId}`, me.authId)).statusCode).toBe(200);
  });

  it('a reporter can see their report and its status, and nothing about the other person', async () => {
    const me = await seedMember('female');
    const them = await seedMember('male');
    await call('POST', '/reports', me.authId, {
      reportedUserId: them.userId,
      category: 'harassment',
      description: 'Something a moderator should look at',
    });
    const reports = await call('GET', '/me/reports', me.authId);
    expect(reports.json().items[0]).toMatchObject({ category: 'harassment', status: 'open' });
  });

  it('notification settings save, and turning one off stops it', async () => {
    const { a, b, conversationId } = await connected();
    const current = (await call('GET', '/me/notification-preferences', a.authId)).json();
    const saved = await call('PUT', '/me/notification-preferences', a.authId, {
      ...current,
      types: current.types.map((t: { type: string }) =>
        t.type === 'new_message' ? { ...t, inApp: false } : t,
      ),
    });
    expect(saved.json().types.find((t: { type: string }) => t.type === 'new_message').inApp).toBe(
      false,
    );
    await call('POST', `/conversations/${conversationId}/messages`, b.authId, { body: 'Salaam' });
    const inbox = await call('GET', '/notifications', a.authId);
    expect(inbox.json().items.filter((n: { type: string }) => n.type === 'new_message')).toEqual(
      [],
    );
  });

  it('security alerts cannot be turned off', async () => {
    const me = await seedMember();
    const current = (await call('GET', '/me/notification-preferences', me.authId)).json();
    const res = await call('PUT', '/me/notification-preferences', me.authId, {
      ...current,
      types: current.types.map((t: { type: string }) =>
        t.type === 'security_alert' ? { ...t, inApp: false } : t,
      ),
    });
    expect(res.statusCode).toBe(400);
  });

  it('ending a match closes the chat for both, and keeps what was said', async () => {
    const { a, b, conversationId, matchId } = await connected();
    await call('POST', `/conversations/${conversationId}/messages`, b.authId, { body: 'Salaam' });
    expect(
      (await call('POST', `/matches/${matchId}/unmatch`, a.authId, {})).statusCode,
    ).toBeLessThan(300);
    const thread = await call('GET', `/conversations/${conversationId}`, b.authId);
    expect(thread.json().canWrite).toBe(false);
    const read = await call('GET', `/conversations/${conversationId}/messages`, b.authId);
    expect(read.body).toContain('Salaam');
  });

  it('family invitations can be listed and cancelled', async () => {
    const me = await seedMember();
    const made = await call('POST', '/family/invitations', me.authId, {
      inviteeContact: 'parent@example.test',
      relationshipCode: 'father',
      tier: 'observer',
    });
    expect(made.statusCode).toBe(201);
    const list = await call('GET', '/family/invitations', me.authId);
    expect(list.json().items[0]).toMatchObject({ status: 'pending' });
    expect(
      (await call('DELETE', `/family/invitations/${made.json().id}`, me.authId)).statusCode,
    ).toBeLessThan(300);
  });
});

describe('paging while new things arrive', () => {
  /**
   * Position-based cursors moved under a reader: one new row at the top pushed the last
   * row of page one onto page two. Each list here gets a new row between pages.
   */
  const walk = async (
    url: string,
    authId: string,
    between: () => Promise<unknown>,
    key: string,
  ) => {
    const first = await call('GET', `${url}${url.includes('?') ? '&' : '?'}limit=2`, authId);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.hasMore).toBe(true);
    await between();
    const second = await call(
      'GET',
      `${url}${url.includes('?') ? '&' : '?'}limit=2&cursor=${body.nextCursor}`,
      authId,
    );
    expect(second.statusCode).toBe(200);
    const ids = [...body.items, ...second.json().items].map(
      (item: Record<string, string>) => item[key],
    );
    expect(new Set(ids).size, JSON.stringify(ids)).toBe(ids.length);
    return ids;
  };

  it('notifications', async () => {
    const me = await seedMember();
    const add = (key: string) =>
      harness.raw.query(
        `insert into public.notifications (user_id, type, payload, dedupe_key)
         values ($1::uuid, 'new_match', '{}'::jsonb, $2)`,
        [me.userId, key],
      );
    for (const key of ['a', 'b', 'c', 'd']) await add(key);
    const ids = await walk('/notifications', me.authId, () => add('new'), 'id');
    expect(ids).toHaveLength(4);
  });

  it('interests', async () => {
    const me = await seedMember('female');
    for (let i = 0; i < 4; i += 1) {
      const them = await seedMember('male');
      await call('POST', '/interests', them.authId, { recipientUserId: me.userId });
    }
    const ids = await walk(
      '/interests?direction=received',
      me.authId,
      async () => {
        const late = await seedMember('male');
        await call('POST', '/interests', late.authId, { recipientUserId: me.userId });
      },
      'id',
    );
    expect(ids).toHaveLength(4);
  });

  it('interests filtered by status', async () => {
    const me = await seedMember('female');
    for (let i = 0; i < 3; i += 1) {
      const them = await seedMember('male');
      await call('POST', '/interests', them.authId, { recipientUserId: me.userId });
    }
    const ids = await walk(
      '/interests?direction=received&status=pending',
      me.authId,
      async () => {},
      'id',
    );
    expect(ids).toHaveLength(3);
  });

  it('blocked members', async () => {
    const me = await seedMember();
    for (let i = 0; i < 4; i += 1) {
      await call('PUT', `/blocks/${(await seedMember()).userId}`, me.authId, {});
    }
    const ids = await walk(
      '/blocks',
      me.authId,
      async () => {
        await call('PUT', `/blocks/${(await seedMember()).userId}`, me.authId, {});
      },
      'userId',
    );
    expect(ids).toHaveLength(4);
  });

  it('reports', async () => {
    const me = await seedMember();
    const file = async () =>
      call('POST', '/reports', me.authId, {
        reportedUserId: (await seedMember()).userId,
        category: 'other',
        description: 'Something a moderator should look at',
      });
    for (let i = 0; i < 4; i += 1) await file();
    const ids = await walk('/me/reports', me.authId, async () => void (await file()), 'id');
    expect(ids).toHaveLength(4);
  });

  it('saved profiles', async () => {
    const me = await seedMember('female');
    const save = async () => {
      const them = await seedMember('male');
      await call('PUT', `/discovery/shortlist/${them.userId}`, me.authId);
    };
    for (let i = 0; i < 4; i += 1) await save();
    const ids = await walk('/discovery/shortlist', me.authId, save, 'userId');
    expect(ids).toHaveLength(4);
  });

  it('matches', async () => {
    const me = await seedMember('female');
    const match = async () => {
      const them = await seedMember('male');
      const sent = await call('POST', '/interests', them.authId, { recipientUserId: me.userId });
      await call('POST', `/interests/${sent.json().id}/respond`, me.authId, { decision: 'accept' });
    };
    for (let i = 0; i < 4; i += 1) await match();
    const ids = await walk('/matches', me.authId, match, 'id');
    expect(ids).toHaveLength(4);
  });

  it.each([
    '/notifications',
    '/interests?direction=received',
    '/blocks',
    '/me/reports',
    '/discovery/shortlist',
    '/matches',
    '/family/members',
    '/family/access-log',
    '/family/reviews',
  ])('%s refuses a cursor from before, so the app starts the list again', async (url) => {
    const me = await seedMember();
    const old = Buffer.from('5', 'utf8').toString('base64url');
    const res = await call('GET', `${url}${url.includes('?') ? '&' : '?'}cursor=${old}`, me.authId);
    expect(res.statusCode).toBe(400);
  });
});

describe('TRUST_PROXY', () => {
  it('keeps today’s behaviour when unset, so a deployment behind a proxy is not broken', () => {
    expect(parseTrustProxy(undefined)).toBe(true);
    expect(parseTrustProxy('')).toBe(true);
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('can be turned off, when nothing sits in front of the API', () => {
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('counts proxies, trusting only that many hops', () => {
    const one = parseTrustProxy('1') as (address: string, hop: number) => boolean;
    expect(one('10.0.0.1', 0)).toBe(true);
    expect(one('203.0.113.9', 1)).toBe(false);
  });

  it('names proxies', () => {
    expect(parseTrustProxy('10.0.0.0/8, 192.168.0.1')).toEqual(['10.0.0.0/8', '192.168.0.1']);
  });

  it('with no proxy trusted, a forged header does not change the address', async () => {
    const seen: string[] = [];
    const strict = await createHarness({ TRUST_PROXY: 'false' });
    const trusting = await createHarness();
    try {
      for (const [app, label] of [
        [strict.app, 'strict'],
        [trusting.app, 'trusting'],
      ] as const) {
        const res = await app.inject({
          method: 'GET',
          url: '/health',
          headers: { 'x-forwarded-for': '203.0.113.77' },
          remoteAddress: '198.51.100.1',
        });
        expect(res.statusCode).toBe(200);
        seen.push(`${label}:${res.headers['x-ratelimit-remaining'] ? 'limited' : 'none'}`);
      }
      const addressOf = async (app: TestHarness['app']) => {
        for (let i = 0; i < 2; i += 1) {
          await app.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
            remoteAddress: '198.51.100.2',
          });
        }
        const last = await app.inject({
          method: 'GET',
          url: '/health',
          headers: { 'x-forwarded-for': '203.0.113.3' },
          remoteAddress: '198.51.100.2',
        });
        return Number(last.headers['x-ratelimit-remaining']);
      };
      // Each forged address is a fresh bucket when the header is believed. When it is
      // not, the three requests all count against the one real address.
      const budget = Number(
        (
          await strict.app.inject({
            method: 'GET',
            url: '/health',
            remoteAddress: '198.51.100.9',
          })
        ).headers['x-ratelimit-limit'],
      );
      expect(await addressOf(strict.app)).toBe(budget - 3);
      expect(await addressOf(trusting.app)).toBe(budget - 1);
    } finally {
      await strict.close();
      await trusting.close();
    }
    expect(seen).toHaveLength(2);
  }, 180_000);
});

describe('the contact filter: what the audit got past it', () => {
  it.each([
    ['a number given in pieces', 'my number starts 0300 and ends 4567'],
    ['pieces with an international prefix', 'it begins with +92 300 and then 123 4567'],
    ['Urdu number words', 'صفر تین صفر صفر ایک دو تین چار پانچ چھ سات'],
    ['Roman Urdu number words', 'sifar teen sifar sifar aik do teen char panch che saat'],
    ['letters for digits', 'call O3OO1234567'],
    ['letters for digits, lower case', 'o3oo1234567'],
    ['snap with a colon', 'snap: abc'],
    ['snap with a dash', 'snap - nikah_guy'],
  ])('%s is refused', (_label, text) => {
    expect(findContactDetails(text).length).toBeGreaterThan(0);
  });

  it.each([
    'I work in Lahore and enjoy reading',
    'Do you pray five times a day?',
    'No, I have not been to Lahore yet',
    'Do the kids go to school? Char din pehle aya tha',
    'oil and gas engineer at a big company',
    'I was born in 1995 and studied for 4 years',
    'My height is 170 cm and I am 30',
    'Rs 150,000 monthly salary',
    'We met on 15-06-1995 in Karachi',
    'Snap decisions are not my style',
    'do aur do char',
    'I have 3 sisters and 2 brothers',
  ])('%s is allowed', (text) => {
    expect(findContactDetails(text)).toEqual([]);
  });
});
