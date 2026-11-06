import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from '../src/auth/verify';
import type { Config } from '../src/config';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * Stage 2, Priority 1: what a member can do with their own JWT and the Supabase
 * Data API, without going through our API.
 *
 * The tokens are real: signed JWTs with the claims Supabase issues, checked by the
 * API's real verifier. A request then runs the way PostgREST runs one: the verified
 * claims go into `request.jwt.claims`, and the role comes from the token's `role`
 * claim. PostgREST itself is not running here, so its routing and any hosted
 * configuration are not exercised. What is exercised is the part that decides the
 * answer: real privileges and real RLS on the real migrations.
 */

const JWT_SECRET = 'stage-2-test-secret-that-is-long-enough-to-sign-with';
const SUPABASE_URL = 'https://stage2-test.supabase.invalid';

let harness: TestHarness;

const verifier = createTokenVerifier({
  SUPABASE_URL,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
} as unknown as Config);

async function mint(
  authId: string,
  claims: Record<string, unknown> = {},
  options: { secret?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: 1 }],
    session_id: randomAuthId(),
    email: 'member@example.test',
    phone: '',
    is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setSubject(authId)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(options.secret ?? JWT_SECRET));
}

/** One Data API request. Always rolled back, so a test sees only what is refused. */
async function dataApi<T = Record<string, unknown>>(
  token: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await verifier.verify(token);
  const claims = decodeJwt(token);
  await harness.raw.exec('begin');
  try {
    await harness.raw.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claims),
    ]);
    await harness.raw.exec(`set local role ${String(claims.role)}`);
    return (await harness.raw.query<T>(sql, params as never[])).rows;
  } finally {
    await harness.raw.exec('rollback');
  }
}

interface Member {
  userId: string;
  authId: string;
  token: string;
}

let seq = 0;

async function seedMember(gender: 'female' | 'male' = 'female'): Promise<Member> {
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
       (user_id, about_me, family_background, institution, marital_status_code, religious_practice_code,
        review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.', 'PRIVATE_FAMILY', 'PRIVATE_SCHOOL',
             'ms_never_married', 'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId, token: await mint(authId) };
}

const api = (method: string, url: string, member: Member, payload?: unknown) =>
  harness.app.inject({
    method: method as 'GET',
    url,
    headers: authHeader(member.authId),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function connected() {
  const a = await seedMember('female');
  const b = await seedMember('male');
  const sent = await api('POST', '/interests', b, { recipientUserId: a.userId });
  expect(sent.statusCode).toBe(201);
  const accepted = await api('POST', `/interests/${sent.json().id}/respond`, a, {
    decision: 'accept',
  });
  const conversation = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [accepted.json().match.id],
  );
  return { a, b, conversationId: conversation.rows[0]!.id };
}

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
  await harness.raw.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('marital_status', 'ms_never_married', 1),
      ('religious_practice', 'rel_practising', 1)
    on conflict do nothing
  `);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('the tokens are real', () => {
  it('a token signed with the wrong key is refused before any database work', async () => {
    const member = await seedMember();
    const forged = await mint(
      member.authId,
      {},
      { secret: 'not-the-project-secret-at-all-really' },
    );
    await expect(dataApi(forged, 'select 1')).rejects.toThrow(/Invalid or expired/);
  });

  it('an expired token is refused', async () => {
    const member = await seedMember();
    const old = await mint(member.authId, {}, { expiresIn: '-1m' });
    await expect(dataApi(old, 'select 1')).rejects.toThrow(/Invalid or expired/);
  });

  it('a good token resolves to the right member', async () => {
    const member = await seedMember();
    const rows = await dataApi<{ me: string }>(member.token, 'select app.current_user_id() as me');
    expect(rows[0]!.me).toBe(member.userId);
  });
});

describe('every table in public, with a member JWT', () => {
  let tables: Array<{ name: string; column: string }>;
  let member: Member;

  beforeAll(async () => {
    member = await seedMember();
    const rows = await harness.raw.query<{ name: string; column: string }>(
      `select c.relname as name, min(a.attname) as column
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'
        group by c.relname order by 1`,
    );
    tables = rows.rows;
    expect(tables.length).toBe(57);
  });

  const DENIED = /permission denied/;

  it('cannot INSERT into any', async () => {
    for (const { name } of tables) {
      await expect(
        dataApi(member.token, `insert into public.${name} default values`),
        name,
      ).rejects.toThrow(DENIED);
    }
  });

  it('cannot UPDATE any', async () => {
    for (const { name, column } of tables) {
      await expect(
        dataApi(member.token, `update public.${name} set "${column}" = "${column}"`),
        name,
      ).rejects.toThrow(DENIED);
    }
  });

  it('cannot DELETE from any', async () => {
    for (const { name } of tables) {
      await expect(dataApi(member.token, `delete from public.${name}`), name).rejects.toThrow(
        DENIED,
      );
    }
  });

  it('cannot read any, except the three message columns Realtime needs', async () => {
    for (const { name } of tables) {
      await expect(dataApi(member.token, `select * from public.${name}`), name).rejects.toThrow(
        DENIED,
      );
    }
    expect(
      await dataApi(member.token, `select id, conversation_id, created_at from public.messages`),
    ).toEqual([]);
  });

  it('anon can read only reference data', async () => {
    const anon = await mint(randomAuthId(), { role: 'anon' });
    for (const { name } of tables) {
      const attempt = dataApi(anon, `select * from public.${name} limit 1`);
      if (name.startsWith('reference_')) await expect(attempt).resolves.toBeDefined();
      else await expect(attempt, name).rejects.toThrow(DENIED);
    }
  });
});

describe('the bypasses API validation used to leave open', () => {
  let member: Member;
  let other: Member;

  beforeAll(async () => {
    member = await seedMember();
    other = await seedMember('male');
  });

  it.each<[string, string]>([
    [
      'contact details in about_me, past the filter',
      `update public.profiles set about_me = 'WhatsApp me on 0300 1234567 please do it now'`,
    ],
    ['a profile edit without re-review', `update public.profiles set looking_for = 'x'`],
    ['a new display name', `update public.users set display_name = 'Admin Support'`],
    ['a location', `update public.user_locations set city_name = 'Elsewhere'`],
    ['incognito without paying', `update public.user_settings set incognito = true`],
    ['a privacy setting', `update public.profile_field_visibility set visibility = 'public'`],
    [
      'an unfiltered photo row',
      `insert into public.photos (user_id, storage_path, content_type)
       values (app.current_user_id(), app.current_user_id()::text || '/x/original.jpg', 'image/jpeg')`,
    ],
    ['a main photo change', `update public.photos set is_primary = true`],
    ['a partner preference', `update public.partner_preferences set age_min = 18`],
    ['a preference rule', `delete from public.preference_rules`],
    ['marking notifications read', `update public.notifications set read_at = now()`],
    ['a notification preference', `delete from public.notification_preferences`],
    ['revoking a device', `update public.user_devices set revoked_at = now()`],
    [
      'a date-of-birth request',
      `insert into public.dob_correction_requests (user_id, requested_dob, reason)
       values (app.current_user_id(), date '1990-01-01', 'because I said so')`,
    ],
  ])('%s', async (_label, sql) => {
    await expect(dataApi(member.token, sql)).rejects.toThrow(/permission denied/);
  });

  it('a block, a dismissal and a shortlist entry, past the rate limit', async () => {
    for (const sql of [
      `insert into public.blocks (blocker_user_id, blocked_user_id)
       values (app.current_user_id(), '${other.userId}'::uuid)`,
      `insert into public.dismissed_profiles (user_id, target_user_id)
       values (app.current_user_id(), '${other.userId}'::uuid)`,
      `insert into public.shortlists (user_id, target_user_id)
       values (app.current_user_id(), '${other.userId}'::uuid)`,
    ]) {
      await expect(dataApi(member.token, sql)).rejects.toThrow(/permission denied/);
    }
  });

  it('a message past the rate limit and the send route', async () => {
    const { b, conversationId } = await connected();
    await expect(
      dataApi(
        b.token,
        `insert into public.messages (conversation_id, sender_user_id, body)
         values ('${conversationId}'::uuid, app.current_user_id(), 'hello')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('a forged role claim', () => {
  // What PostgREST does with whatever `role` a token claims, run as the role it
  // connects with. A superuser session is allowed anything, so this switches the
  // session itself to `authenticator`, on a database nothing else here shares.
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    await pg.exec(`
      create role authenticator noinherit login;
      grant anon, authenticated, service_role to authenticator;
      set session authorization authenticator;
    `);
  }, 180_000);

  afterAll(async () => {
    await pg?.close();
  });

  const switchTo = async (role: string): Promise<string> => {
    await pg.exec('begin');
    try {
      await pg.exec(`set local role ${role}`);
      return 'switched';
    } finally {
      await pg.exec('rollback');
    }
  };

  it('PostgREST can still switch to the roles it is meant to', async () => {
    expect(await switchTo('authenticated')).toBe('switched');
    expect(await switchTo('anon')).toBe('switched');
  });

  it('cannot reach api_member, whatever the token says', async () => {
    await expect(switchTo('api_member')).rejects.toThrow(/permission denied to set role/);
  });
});

describe('private profile fields', () => {
  it('a stranger and the owner alike are refused every profile column directly', async () => {
    const owner = await seedMember();
    const stranger = await seedMember('male');
    for (const token of [stranger.token, owner.token]) {
      await expect(
        dataApi(token, `select family_background, institution from public.profiles`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('the API still serves the owner everything and a stranger only what is allowed', async () => {
    const owner = await seedMember();
    const stranger = await seedMember('male');
    await harness.raw.query(
      `insert into public.profile_field_visibility (user_id, field_key, visibility)
       values ($1::uuid, 'family_background', 'private')`,
      [owner.userId],
    );
    expect((await api('GET', '/me/profile', owner)).body).toContain('PRIVATE_FAMILY');
    const seen = await api('GET', `/profiles/${owner.userId}`, stranger);
    expect(seen.statusCode).toBe(200);
    expect(seen.body).not.toContain('PRIVATE_FAMILY');
  });
});

describe('shared chat', () => {
  const readDirect = (token: string, conversationId: string) =>
    dataApi<{ id: string }>(
      token,
      `select id, conversation_id, created_at from public.messages where conversation_id = $1::uuid`,
      [conversationId],
    );

  it('a participant sees that a message exists, which is what Realtime needs', async () => {
    const { a, b, conversationId } = await connected();
    await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' });
    expect(await readDirect(a.token, conversationId)).toHaveLength(1);
    expect(await readDirect(b.token, conversationId)).toHaveLength(1);
  });

  it('nobody reads a message body directly, including the people in the chat', async () => {
    const { a, b, conversationId } = await connected();
    await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' });
    for (const token of [a.token, b.token]) {
      await expect(dataApi(token, `select body from public.messages`)).rejects.toThrow(
        /permission denied/,
      );
    }
    const read = await api('GET', `/conversations/${conversationId}/messages`, a);
    expect(read.body).toContain('Salaam');
  });

  it('a stranger sees nothing, whichever thread they ask about', async () => {
    const { b, conversationId } = await connected();
    await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' });
    const stranger = await seedMember();
    expect(await readDirect(stranger.token, conversationId)).toEqual([]);
  });

  it('someone who has left sees nothing further', async () => {
    const { a, b, conversationId } = await connected();
    await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' });
    await harness.raw.query(
      `update public.conversation_participants set left_at = now()
        where conversation_id = $1::uuid and user_id = $2::uuid`,
      [conversationId, a.userId],
    );
    expect(await readDirect(a.token, conversationId)).toEqual([]);
  });

  it('a restricted participant sees nothing', async () => {
    const { a, b, conversationId } = await connected();
    await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' });
    await harness.raw.query(`update public.users set status = 'banned' where id = $1::uuid`, [
      a.userId,
    ]);
    expect(await readDirect(a.token, conversationId)).toEqual([]);
  });

  it('a deleted message’s words cannot be recovered directly, which they could before', async () => {
    const { a, b, conversationId } = await connected();
    const sent = await api('POST', `/conversations/${conversationId}/messages`, b, {
      body: 'I regret saying this',
    });
    await harness.raw.query(`update public.messages set deleted_at = now() where id = $1::uuid`, [
      sent.json().id,
    ]);
    await expect(
      dataApi(a.token, `select body from public.messages where id = '${sent.json().id}'::uuid`),
    ).rejects.toThrow(/permission denied/);
    expect((await api('GET', `/conversations/${conversationId}/messages`, a)).body).not.toContain(
      'I regret saying this',
    );
  });

  it('read receipts cannot be read directly, past the privacy setting', async () => {
    const { a } = await connected();
    await expect(dataApi(a.token, `select * from public.message_reads`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('the API itself keeps working, and keeps validating', () => {
  it('edits, photos, settings, safety and chat all still work', async () => {
    const { a, b, conversationId } = await connected();
    expect(
      (await api('PATCH', '/me/profile', a, { lookingFor: 'Someone kind and thoughtful' }))
        .statusCode,
    ).toBe(200);
    expect((await api('PATCH', '/me', a, { discoveryPaused: true })).statusCode).toBe(200);
    expect((await api('PATCH', '/me', a, { discoveryPaused: false })).statusCode).toBe(200);
    expect(
      (await api('POST', '/me/photos/upload-url', a, { contentType: 'image/jpeg', byteSize: 1000 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await api('POST', `/conversations/${conversationId}/messages`, b, { body: 'Salaam' }))
        .statusCode,
    ).toBe(201);
    const stranger = await seedMember('male');
    expect((await api('PUT', `/blocks/${stranger.userId}`, a, {})).statusCode).toBeLessThan(300);
  });

  it('what the API refuses is still refused', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const res = await api('POST', '/interests', sender, {
      recipientUserId: recipient.userId,
      note: 'call me on 03001234567',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the release order: 0033, then the API, then 0034', () => {
  let midway: TestHarness;

  beforeAll(async () => {
    midway = await createHarness({}, { through: '20261106000033' });
    await seedReferenceData(midway.raw);
  }, 180_000);

  afterAll(async () => {
    await midway?.close();
  });

  it('after 0033 the previous API, on `authenticated`, has lost nothing', async () => {
    const rows = await midway.raw.query<{ can: boolean }>(
      `select has_column_privilege('authenticated', 'public.profiles', 'about_me', 'UPDATE')
          and has_table_privilege('authenticated', 'public.profiles', 'SELECT')
          and has_table_privilege('authenticated', 'public.blocks', 'INSERT') as can`,
    );
    expect(rows.rows[0]!.can).toBe(true);
  });

  it('after 0033 this API, on `api_member`, already has everything', async () => {
    const privileges = await midway.raw.query<{ a: string; b: string }>(
      `select a.privilege_type as a, a.table_name as b
         from information_schema.role_table_grants a
        where a.table_schema = 'public' and a.grantee = 'authenticated'
          and not exists (
            select 1 from information_schema.role_table_grants b
             where b.table_schema = 'public' and b.grantee = 'api_member'
               and b.table_name = a.table_name and b.privilege_type = a.privilege_type
          )`,
    );
    expect(privileges.rows).toEqual([]);

    const authId = randomAuthId();
    const boot = await midway.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(authId),
      payload: { locale: 'en', timezone: 'UTC' },
    });
    expect(boot.statusCode).toBe(201);
    const me = await midway.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: authHeader(authId),
      payload: { timezone: 'Asia/Karachi' },
    });
    expect(me.statusCode).toBe(200);
  });
});
