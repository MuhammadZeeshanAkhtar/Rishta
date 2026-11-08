import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  createHarness,
  createPgliteDb,
  randomAuthId,
  type TestHarness,
} from './helpers';

/**
 * The release order for the app that is live today, tested at each step:
 *
 *   1. migrate --through=20261106000033   the previous API is still serving
 *   2. deploy the current API
 *   3. migrate                            0034, the cutover
 *
 * The previous API's own 561 tests were run at every migration from 0026 to 0034. What
 * stopped active members working was `kind`: 0027 revokes it and the previous API names
 * it, so nobody could send. 0033 now lends it back until 0034, which is what these pin.
 * The rest were a free member turning on incognito (a rule, answered 500 instead of 403),
 * a restricted member's write being refused, and a test that no new table may exist.
 *
 * "The previous API" here is its exact statements from commit 6c67581, run as the role it
 * ran them as. A rollback at step 2 relies on the same thing.
 */

const OLD_API_MESSAGE_INSERT = `insert into public.messages (conversation_id, sender_user_id, body, kind)
           values ($1::uuid, app.current_user_id(), $2, 'text')
           returning id, sender_user_id, body, kind, created_at`;

const OLD_API_HISTORY = `select id, sender_user_id, body, kind, created_at
           from public.messages where conversation_id = $1::uuid
          order by created_at desc, id desc limit 50`;

const THROUGH_0033 = '20261106000033';

interface Member {
  userId: string;
  authId: string;
}

let seq = 0;

async function seedMember(h: TestHarness, gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await h.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Release ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await h.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await h.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await h.raw.query(
    `insert into public.verification_status (user_id, email_verified_at)
     values ($1::uuid, now())`,
    [userId],
  );
  await h.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  await h.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const inject = (
  h: TestHarness,
  method: 'GET' | 'POST',
  url: string,
  auth: string,
  payload?: Record<string, unknown>,
) => h.app.inject({ method, url, headers: authHeader(auth), ...(payload ? { payload } : {}) });

async function thread(h: TestHarness): Promise<{ alice: Member; bilal: Member; id: string }> {
  const alice = await seedMember(h, 'female');
  const bilal = await seedMember(h, 'male');
  const sent = await inject(h, 'POST', '/interests', bilal.authId, {
    recipientUserId: alice.userId,
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const accepted = await inject(
    h,
    'POST',
    `/interests/${(sent.json() as { id: string }).id}/respond`,
    alice.authId,
    { decision: 'accept' },
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
  const rows = await h.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [(accepted.json() as { match: { id: string } }).match.id],
  );
  return { alice, bilal, id: rows.rows[0]!.id };
}

/** The previous API's connection: it acts as `authenticated`, never `api_member`. */
const previousApi = (h: TestHarness) => createPgliteDb(h.raw, [], 'authenticated');

const holdsKindInOwnRight = async (h: TestHarness, role: string): Promise<boolean> => {
  const rows = await h.raw.query<{ held: boolean }>(
    `select exists (
       select 1 from pg_attribute att
        cross join lateral aclexplode(att.attacl) a
        join pg_roles g on g.oid = a.grantee
        where att.attrelid = 'public.messages'::regclass
          and att.attname = 'kind' and a.privilege_type = 'INSERT' and g.rolname = $1
     ) as held`,
    [role],
  );
  return rows.rows[0]!.held;
};

describe('step 1: through 0033, with the previous API still serving', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness({}, { through: THROUGH_0033 });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it('is really that state: 0034 has not been applied', async () => {
    const rows = await h.raw.query<{ can: boolean }>(
      `select has_table_privilege('authenticated', 'public.profiles', 'SELECT') as can`,
    );
    expect(rows.rows[0]!.can).toBe(true);
  });

  it('the previous API can send a message, which 0027 alone would have stopped', async () => {
    const { alice, id } = await thread(h);
    const rows = await previousApi(h).asUser(alice.authId, (session) =>
      session.query<{ kind: string; body: string }>(OLD_API_MESSAGE_INSERT, [id, 'Salaam.']),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'text', body: 'Salaam.' });
  });

  it('the other side reads it through the previous API', async () => {
    const { alice, bilal, id } = await thread(h);
    const old = previousApi(h);
    await old.asUser(alice.authId, (session) =>
      session.query(OLD_API_MESSAGE_INSERT, [id, 'Readable.']),
    );
    const rows = await old.asUser(bilal.authId, (session) =>
      session.query<{ body: string }>(OLD_API_HISTORY, [id]),
    );
    expect(rows.map((r) => r.body)).toEqual(['Readable.']);
  });

  it('lending the column back reopens nothing: a system notice is still refused', async () => {
    const { alice, id } = await thread(h);
    await expect(
      previousApi(h).asUser(alice.authId, (session) =>
        session.query(
          `insert into public.messages (conversation_id, sender_user_id, body, kind)
           values ($1::uuid, app.current_user_id(), 'Your account is suspended.', 'system')`,
          [id],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a stranger still cannot send through the previous API', async () => {
    const { id } = await thread(h);
    const stranger = await seedMember(h, 'male');
    await expect(
      previousApi(h).asUser(stranger.authId, (session) =>
        session.query(OLD_API_MESSAGE_INSERT, [id, 'Let me in.']),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the current API works on the same database, so step 2 can happen at any time', async () => {
    const { alice, bilal, id } = await thread(h);
    const sent = await inject(h, 'POST', `/conversations/${id}/messages`, alice.authId, {
      body: 'From the current API.',
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ kind: 'text' });
    const read = await inject(h, 'GET', `/conversations/${id}/messages`, bilal.authId);
    expect((read.json() as { items: { body: string }[] }).items[0]!.body).toBe(
      'From the current API.',
    );
  });

  it('both APIs can serve one conversation, which is what a rolling deploy or a rollback does', async () => {
    const { alice, bilal, id } = await thread(h);
    await previousApi(h).asUser(alice.authId, (session) =>
      session.query(OLD_API_MESSAGE_INSERT, [id, 'From the previous API.']),
    );
    const sent = await inject(h, 'POST', `/conversations/${id}/messages`, bilal.authId, {
      body: 'From the current API.',
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const read = await inject(h, 'GET', `/conversations/${id}/messages`, alice.authId);
    expect((read.json() as { items: { body: string }[] }).items.map((m) => m.body)).toEqual([
      'From the current API.',
      'From the previous API.',
    ]);
  });

  it('api_member never holds the column in its own right, so 0034 leaves nothing behind', async () => {
    expect(await holdsKindInOwnRight(h, 'authenticated')).toBe(true);
    expect(await holdsKindInOwnRight(h, 'api_member')).toBe(false);
  });
});

describe('step 3: 0034 applied, with the current API serving', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it('the current API sends and reads', async () => {
    const { alice, bilal, id } = await thread(h);
    const sent = await inject(h, 'POST', `/conversations/${id}/messages`, alice.authId, {
      body: 'After the cutover.',
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const read = await inject(h, 'GET', `/conversations/${id}/messages`, bilal.authId);
    expect((read.json() as { items: { body: string }[] }).items[0]!.body).toBe(
      'After the cutover.',
    );
  });

  it('the previous API can no longer send: this is why 0034 must follow the deploy', async () => {
    const { alice, id } = await thread(h);
    await expect(
      previousApi(h).asUser(alice.authId, (session) =>
        session.query(OLD_API_MESSAGE_INSERT, [id, 'Too late.']),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the previous API cannot even identify a member', async () => {
    const member = await seedMember(h, 'female');
    await expect(
      previousApi(h).asUser(member.authId, (session) =>
        session.query(`select id from public.users where id = app.current_user_id()`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the lent column is gone: nobody can name `kind` any more', async () => {
    expect(await holdsKindInOwnRight(h, 'authenticated')).toBe(false);
    expect(await holdsKindInOwnRight(h, 'api_member')).toBe(false);
    const rows = await h.raw.query<{ a: boolean; b: boolean }>(
      `select has_column_privilege('authenticated', 'public.messages', 'kind', 'INSERT') as a,
              has_column_privilege('api_member', 'public.messages', 'kind', 'INSERT') as b`,
    );
    expect(rows.rows[0]).toEqual({ a: false, b: false });
  });
});
