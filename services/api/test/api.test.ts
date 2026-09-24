import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meSchema, referenceListSchema } from '@nikahmate/domain';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await seedReferenceData(h.raw);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('GET /health', () => {
  it('reports database connectivity', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('needs no authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });

  it('rejects a malformed bearer token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-bearer scheme', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never echoes the token back in an error', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer test:sensitive-token-value' },
    });
    expect(res.body).not.toContain('sensitive-token-value');
  });
});

describe('POST /account/bootstrap', () => {
  it('creates an account and returns 201', async () => {
    const authId = randomAuthId();
    const res = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId, 'a@example.com'),
      payload: { locale: 'en', timezone: 'Asia/Karachi' },
    });

    expect(res.statusCode).toBe(201);
    const me = meSchema.parse(res.json());
    expect(me.status).toBe('onboarding');
    expect(me.displayName).toBeNull();
    expect(me.profileCompleted).toBe(false);
    expect(me.timezone).toBe('Asia/Karachi');
  });

  it('is idempotent — a second call returns 200 and the same account', async () => {
    const authId = randomAuthId();
    const first = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId),
      payload: { locale: 'ur', timezone: 'Asia/Karachi' },
    });
    const second = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId),
      payload: { locale: 'ur', timezone: 'Asia/Karachi' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().userId).toBe(first.json().userId);
  });

  it('ignores an attacker-supplied account id in the body', async () => {
    // Identity comes from the verified JWT. Anything in the body that looks
    // like identity is stripped by the schema before it reaches SQL.
    const victim = randomAuthId();
    const attacker = randomAuthId();

    const victimRes = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(victim),
      payload: { locale: 'en', timezone: 'UTC' },
    });

    const attackerRes = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(attacker),
      payload: {
        locale: 'en',
        timezone: 'UTC',
        authUserId: victim,
        userId: victimRes.json().userId,
        status: 'active',
      },
    });

    expect(attackerRes.statusCode).toBe(201);
    expect(attackerRes.json().userId).not.toBe(victimRes.json().userId);
    // Status is server-assigned; a client cannot vault itself past onboarding.
    expect(attackerRes.json().status).toBe('onboarding');
  });

  it('rejects an invalid timezone', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(randomAuthId()),
      payload: { locale: 'en', timezone: 'Mars/Olympus_Mons' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
    expect(res.json().fields).toHaveProperty('timezone');
  });

  it('requires authentication', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      payload: { locale: 'en', timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('uses the service role, and only for the enumerated reason', async () => {
    const before = [...h.serviceUses];
    await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(randomAuthId()),
      payload: { locale: 'en', timezone: 'UTC' },
    });
    const added = h.serviceUses.slice(before.length);
    expect(added).toEqual(['account.bootstrap']);
  });
});

describe('GET /me', () => {
  let authId: string;
  let userId: string;

  beforeAll(async () => {
    authId = randomAuthId();
    const res = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId),
      payload: { locale: 'en', timezone: 'Europe/London' },
    });
    userId = res.json().userId;
  });

  it('returns the caller account', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: authHeader(authId) });
    expect(res.statusCode).toBe(200);
    const me = meSchema.parse(res.json());
    expect(me.userId).toBe(userId);
    expect(me.timezone).toBe('Europe/London');
  });

  it('returns only booleans for verification, never timestamps', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: authHeader(authId) });
    const verification = res.json().verification;
    for (const value of Object.values(verification)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('404s for a valid token with no account', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/me',
      headers: authHeader(randomAuthId()),
    });
    expect(res.statusCode).toBe(404);
  });

  it('never returns another account, even with many accounts present', async () => {
    // The route selects without a WHERE clause on purpose: RLS is what scopes
    // it. This asserts that the policy, not the query, is doing the work.
    const other = randomAuthId();
    await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(other),
      payload: { locale: 'en', timezone: 'UTC' },
    });

    const res = await h.app.inject({ method: 'GET', url: '/me', headers: authHeader(authId) });
    expect(res.json().userId).toBe(userId);
  });

  it('reads as the caller, not as the service role', async () => {
    const before = h.serviceUses.length;
    await h.app.inject({ method: 'GET', url: '/me', headers: authHeader(authId) });
    expect(h.serviceUses.length).toBe(before);
  });
});

describe('PATCH /me', () => {
  let authId: string;

  beforeAll(async () => {
    authId = randomAuthId();
    await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId),
      payload: { locale: 'en', timezone: 'UTC' },
    });
  });

  it('updates settings and returns the new state', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(authId),
      payload: { locale: 'ar', incognito: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().locale).toBe('ar');
    expect(res.json().incognito).toBe(true);
  });

  it('rejects an empty patch rather than silently doing nothing', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(authId),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('ignores fields a member may not change', async () => {
    // gender and dateOfBirth are not settings. The schema strips them, so the
    // update is a no-op rather than an error the client has to interpret.
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(authId),
      payload: { locale: 'en', gender: 'male', status: 'active', dateOfBirth: '1990-01-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('onboarding');
  });

  it('rejects an unsupported locale shape', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(authId),
      payload: { locale: 'not-a-locale-at-all' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('reference endpoints', () => {
  it('serves a manifest of content hashes', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/manifest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('country');
    expect(typeof res.json().country).toBe('string');
  });

  it('serves a type with localised labels', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/education_level?locale=en' });
    expect(res.statusCode).toBe(200);
    const list = referenceListSchema.parse(res.json());
    expect(list.items.map((i) => i.code)).toContain('edu_bachelors');
    expect(list.items.find((i) => i.code === 'edu_bachelors')?.label).toBe('Bachelor degree');
  });

  it('serves Urdu labels', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/education_level?locale=ur' });
    expect(res.json().items.find((i: { code: string }) => i.code === 'edu_bachelors').label).toBe(
      'بیچلر ڈگری',
    );
  });

  it('falls back to English for a locale with no translation', async () => {
    // A half-translated catalog should show English, not an empty dropdown
    // someone has to choose from to finish signing up.
    const res = await h.app.inject({ method: 'GET', url: '/reference/education_level?locale=ar' });
    expect(res.json().items.find((i: { code: string }) => i.code === 'edu_bachelors').label).toBe(
      'Bachelor degree',
    );
  });

  it('is readable without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/country' });
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown type rather than returning an empty list', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/favourite_colour' });
    expect(res.statusCode).toBe(404);
  });

  it('serves a single item', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/country/pk' });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe('pk');
  });

  it('404s an unknown code', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/reference/country/zz' });
    expect(res.statusCode).toBe(404);
  });

  it('returns a stable hash that changes when content changes', async () => {
    const before = (await h.app.inject({ method: 'GET', url: '/reference/country' })).json().hash;
    const again = (await h.app.inject({ method: 'GET', url: '/reference/country' })).json().hash;
    expect(again).toBe(before);

    await h.raw.exec(`insert into public.reference_items (type, code) values ('country', 'ae')`);
    const after = (await h.app.inject({ method: 'GET', url: '/reference/country' })).json().hash;
    expect(after).not.toBe(before);
  });
});

describe('error envelope', () => {
  it('uses OUR Problem shape, not Fastify default error serialization', async () => {
    // Regression guard. Fastify's default handler emits { statusCode, error,
    // code, message } and silently drops `fields`. It looks close enough to
    // pass a careless assertion, which is how it went unnoticed once already:
    // handlers must be installed before the routes they cover.
    const res = await h.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(randomAuthId()),
      payload: { locale: 'en', timezone: 'Mars/Olympus_Mons' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).not.toHaveProperty('statusCode');
    expect(body).not.toHaveProperty('error');
    expect(Object.keys(body).sort()).toEqual(['code', 'fields', 'message']);
  });

  it('uses the Problem shape for 404s', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('code');
    expect(res.json()).toHaveProperty('message');
  });
});
