import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyReport } from '../scripts/legacy-content';
import type { Queryable } from '../scripts/phase1-security-checks';
import { authHeader, createHarnessOn, randomAuthId, type TestHarness } from './helpers';

/**
 * The application is live, so what matters most about a migration is what it does to a
 * database that already has people in it.
 *
 * This builds a database as the live release left it (migrations through 0025), fills
 * it the way that release filled it (photos and profiles approved automatically,
 * originals with their metadata, chats in progress, someone mid-onboarding), then applies
 * 0026 to 0034 in the documented order and checks nothing was lost, nobody was locked
 * out, and the current API serves all of it.
 *
 * It is a realistic stand-in for live data, not a copy of it. Nothing here has seen the
 * real database, so a backup and a rehearsal on a copy are still required.
 */

const THROUGH_LIVE = '20261019000025';
const FIRST_NEW = '20261101000026';

let pg: PGlite;
let harness: TestHarness;

interface Person {
  userId: string;
  authId: string;
}

const people: Record<string, Person> = {};
let conversationId: string;
let primaryPhotoId: string;
let pendingPrimaryPhotoId: string;

const person = async (
  key: string,
  options: { status?: string; complete?: boolean; gender?: string } = {},
): Promise<Person> => {
  const authId = randomAuthId();
  const complete = options.complete ?? true;
  const users = await pg.query<{ id: string }>(
    complete
      ? `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
         values ($1, $2, date '1995-06-15', 'pk', $3, now()) returning id`
      : `insert into public.users (status) values ('onboarding') returning id`,
    complete ? [key, options.gender ?? 'female', options.status ?? 'active'] : [],
  );
  const userId = users.rows[0]!.id;
  await pg.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await pg.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await pg.query(
    `insert into public.verification_status (user_id, email_verified_at, profile_reviewed_at)
     values ($1::uuid, now(), now())`,
    [userId],
  );
  if (complete) {
    await pg.query(
      `insert into public.profiles
         (user_id, about_me, family_background, marital_status_code, religious_practice_code,
          review_status, submitted_at, reviewed_at)
       values ($1::uuid, $2, 'FAMILY_TEXT_OF_' || $3, 'ms_never_married', 'rel_practising', 'approved', now(), now())`,
      [userId, `About ${key}: a sufficiently long description for this member.`, key],
    );
    await pg.query(
      `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
      [userId],
    );
  }
  const created = { userId, authId };
  people[key] = created;
  return created;
};

const fingerprint = async (sql: string): Promise<string> => {
  const rows = await pg.query(sql);
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
};

const TABLES_BEFORE: string[] = [];
const countsBefore: Record<string, number> = {};
const fingerprints: Record<string, string> = {};

const SNAPSHOTS: Record<string, string> = {
  messages: `select id, conversation_id, sender_user_id, body, kind, created_at from public.messages order by id`,
  conversations: `select id, match_id, status, created_at from public.conversations order by id`,
  participants: `select conversation_id, user_id, left_at from public.conversation_participants order by 1, 2`,
  matches: `select id, user_a_id, user_b_id, communication_state, ended_at from public.matches order by id`,
  interests: `select id, sender_user_id, recipient_user_id, status, note from public.interests order by id`,
  links: `select user_id, auth_user_id, provider from public.user_auth_links order by 1`,
  identity: `select id, display_name, gender, date_of_birth, country_code, status, profile_completed_at from public.users order by id`,
  profileText: `select user_id, about_me, family_background, marital_status_code from public.profiles order by user_id`,
  locations: `select user_id, country_code, city_name from public.user_locations order by user_id`,
  settings: `select user_id, locale, timezone, incognito, discovery_paused from public.user_settings order by user_id`,
  blocks: `select blocker_user_id, blocked_user_id from public.blocks order by 1, 2`,
  photoFiles: `select id, user_id, storage_path, content_type, visibility from public.photos order by id`,
  variants: `select photo_id, variant, storage_path from public.photo_variants order by 1, 2`,
  reports: `select reporter_user_id, reported_user_id, category, status from public.reports order by 1`,
};

const api = (method: string, url: string, who: Person, payload?: unknown) =>
  harness.app.inject({
    method: method as 'GET',
    url,
    headers: authHeader(who.authId),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg, { through: THROUGH_LIVE });
  await pg.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('country', 'pk', 1), ('marital_status', 'ms_never_married', 1),
      ('religious_practice', 'rel_practising', 1)
    on conflict do nothing
  `);

  const ayesha = await person('Ayesha', { gender: 'female' });
  const bilal = await person('Bilal', { gender: 'male' });
  const sara = await person('Sara', { gender: 'female' });
  await person('Hamza', { gender: 'male', status: 'suspended' });
  await person('Farah', { gender: 'female', status: 'deactivated' });
  await person('Newcomer', { complete: false });

  // Photos approved the moment they arrived, as the live release does.
  const photo = await pg.query<{ id: string }>(
    `insert into public.photos
       (user_id, storage_path, content_type, moderation_status, moderated_at, is_primary, visibility)
     values ($1::uuid, $2, 'image/jpeg', 'approved', now(), true, 'public') returning id`,
    [ayesha.userId, `${ayesha.userId}/one/original.jpg`],
  );
  primaryPhotoId = photo.rows[0]!.id;
  await pg.query(
    `insert into public.photo_variants (photo_id, variant, storage_path)
     values ($1::uuid, 'thumb', $2), ($1::uuid, 'blurred', $3)`,
    [primaryPhotoId, `${ayesha.userId}/one/thumb.jpg`, `${ayesha.userId}/one/blurred.jpg`],
  );
  await pg.query(
    `insert into public.media_moderation_results (photo_id, provider, verdict, labels)
     values ($1::uuid, 'auto_stub', 'approved', '{}'::jsonb)`,
    [primaryPhotoId],
  );
  // The state review B13 found: pending, and somehow the main photo.
  const pending = await pg.query<{ id: string }>(
    `insert into public.photos (user_id, storage_path, content_type, moderation_status, is_primary)
     values ($1::uuid, $2, 'image/jpeg', 'pending', true) returning id`,
    [bilal.userId, `${bilal.userId}/two/original.jpg`],
  );
  pendingPrimaryPhotoId = pending.rows[0]!.id;

  // A chat in progress, with history.
  const interest = await pg.query<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, note, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', 'Assalamu alaikum, I liked your profile', now()) returning id`,
    [bilal.userId, ayesha.userId],
  );
  const [a, b] = [ayesha.userId, bilal.userId].sort();
  const match = await pg.query<{ id: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid) returning id`,
    [a, b, interest.rows[0]!.id],
  );
  const conversation = await pg.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [match.rows[0]!.id],
  );
  conversationId = conversation.rows[0]!.id;
  for (const [sender, body] of [
    [bilal.userId, 'Salaam, how are you?'],
    [ayesha.userId, 'Wa alaikum salaam, I am well, thank you.'],
    [bilal.userId, 'Would your family be happy for us to talk further?'],
  ] as const) {
    await pg.query(
      `insert into public.messages (conversation_id, sender_user_id, body, kind) values ($1::uuid, $2::uuid, $3, 'text')`,
      [conversationId, sender, body],
    );
  }
  await pg.query(
    `insert into public.notifications (user_id, type, payload, dedupe_key)
     values ($1::uuid, 'new_message', '{}'::jsonb, 'live-one')`,
    [ayesha.userId],
  );
  await pg.query(
    `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
    [sara.userId, bilal.userId],
  );

  const tables = await pg.query<{ t: string }>(
    `select relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  for (const { t } of tables.rows) {
    TABLES_BEFORE.push(t);
    const rows = await pg.query<{ n: number }>(`select count(*)::int as n from public.${t}`);
    countsBefore[t] = rows.rows[0]!.n;
  }
  for (const [name, sql] of Object.entries(SNAPSHOTS)) fingerprints[name] = await fingerprint(sql);

  // The upgrade, exactly as documented. Every migration runs on real rows.
  await applyMigrations(pg, { from: FIRST_NEW });
  harness = await createHarnessOn(pg);
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

describe('nothing is lost', () => {
  it('every table that existed still has every row', async () => {
    for (const table of TABLES_BEFORE) {
      const rows = await pg.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
      expect(rows.rows[0]!.n, table).toBe(countsBefore[table]);
    }
  });

  it.each(Object.keys(SNAPSHOTS))('%s are byte for byte what they were', async (name) => {
    expect(await fingerprint(SNAPSHOTS[name]!)).toBe(fingerprints[name]);
  });

  it('the upgrade creates only the one new table', async () => {
    const now = await pg.query<{ t: string }>(
      `select relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    const added = now.rows.map((r) => r.t).filter((t) => !TABLES_BEFORE.includes(t));
    expect(added.length).toBeGreaterThan(0);
    expect(added).toContain('pii_access_log');
  });
});

describe('nobody is locked out, and sessions carry on', () => {
  it.each(['Ayesha', 'Bilal', 'Sara'])(
    '%s signs in with the same identity and is served',
    async (key) => {
      const me = await api('GET', '/me', people[key]!);
      expect(me.statusCode).toBe(200);
      expect(me.json().userId).toBe(people[key]!.userId);
      expect(me.json().status).toBe('active');
      expect((await api('GET', '/discovery/sections', people[key]!)).statusCode).toBe(200);
    },
  );

  it('a member part-way through onboarding can carry on', async () => {
    const who = people.Newcomer!;
    const me = await api('GET', '/me', who);
    expect(me.json().status).toBe('onboarding');
    const edit = await api('PATCH', '/me/profile', who, {
      lookingFor: 'Someone kind and thoughtful',
    });
    expect(edit.statusCode).toBeLessThan(400);
  });

  it('a member already suspended is told so, and stays suspended', async () => {
    const who = people.Hamza!;
    expect((await api('GET', '/me', who)).json().status).toBe('suspended');
    expect((await api('GET', '/discovery/sections', who)).json().code).toBe('account_restricted');
  });

  it('a member who deactivated can come back', async () => {
    const who = people.Farah!;
    expect((await api('POST', '/me/reactivate', who)).statusCode).toBe(204);
    expect((await api('GET', '/discovery/sections', who)).statusCode).toBe(200);
  });
});

describe('chat history', () => {
  it('both people still read it, in order', async () => {
    for (const who of [people.Ayesha!, people.Bilal!]) {
      const res = await api('GET', `/conversations/${conversationId}/messages`, who);
      expect(res.statusCode).toBe(200);
      const bodies = res.json().items.map((m: { body: string }) => m.body);
      expect(bodies).toEqual([
        'Would your family be happy for us to talk further?',
        'Wa alaikum salaam, I am well, thank you.',
        'Salaam, how are you?',
      ]);
    }
  });

  it('it shows in their conversation list', async () => {
    const res = await api('GET', '/conversations', people.Ayesha!);
    expect(res.json().items.map((c: { id: string }) => c.id)).toContain(conversationId);
  });

  it('they can carry on talking', async () => {
    const sent = await api('POST', `/conversations/${conversationId}/messages`, people.Ayesha!, {
      body: 'Yes, of course.',
    });
    expect(sent.statusCode).toBe(201);
    await pg.query(`delete from public.messages where id = $1::uuid`, [sent.json().id]);
  });

  it('a stranger still cannot see it', async () => {
    const res = await api('GET', `/conversations/${conversationId}`, people.Sara!);
    expect(res.statusCode).toBe(404);
  });
});

describe('legacy content after the upgrade', () => {
  const queryable: Queryable = {
    query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
  };

  it('stays visible, because hiding it is a company decision the migration does not make', async () => {
    const row = await pg.query<{ moderation_status: string; is_primary: boolean }>(
      `select moderation_status, is_primary from public.photos where id = $1::uuid`,
      [primaryPhotoId],
    );
    expect(row.rows[0]).toEqual({ moderation_status: 'approved', is_primary: true });
    const profile = await pg.query<{ review_status: string }>(
      `select review_status from public.profiles where user_id = $1::uuid`,
      [people.Ayesha!.userId],
    );
    expect(profile.rows[0]!.review_status).toBe('approved');
  });

  it('its originals are withheld until cleaned, in case they still carry GPS', async () => {
    const rule = await pg.query<{ full: boolean; blurred: boolean; marked: boolean }>(
      `select app.photo_variant_readable($1::uuid, $2::uuid, 'full') as full,
              app.photo_variant_readable($1::uuid, $2::uuid, 'blurred') as blurred,
              (select original_needs_strip from public.photos where id = $2::uuid) as marked`,
      [people.Sara!.userId, primaryPhotoId],
    );
    expect(rule.rows[0]).toEqual({ full: false, blurred: true, marked: true });
  });

  it('the tool can see all of it', async () => {
    const report = await legacyReport(queryable);
    expect(report.legacyPhotos).toBe(1);
    expect(report.legacyProfiles).toBeGreaterThanOrEqual(5);
    expect(report.originalsToClean).toBe(2);
  });

  it('a pending photo can no longer be someone’s main photo', async () => {
    const row = await pg.query<{ is_primary: boolean }>(
      `select is_primary from public.photos where id = $1::uuid`,
      [pendingPrimaryPhotoId],
    );
    expect(row.rows[0]!.is_primary).toBe(false);
  });
});

describe('private data after the upgrade', () => {
  it('another member’s private fields are not available directly', async () => {
    await pg.exec('begin');
    try {
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: people.Sara!.authId, role: 'authenticated' }),
      ]);
      await pg.exec('set local role authenticated');
      await expect(pg.query(`select family_background from public.profiles`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  it('the API still serves profiles between members', async () => {
    const res = await api('GET', `/profiles/${people.Ayesha!.userId}`, people.Sara!);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('About Ayesha');
  });

  it('a block made before the upgrade still holds, both ways', async () => {
    expect((await api('GET', `/profiles/${people.Bilal!.userId}`, people.Sara!)).statusCode).toBe(
      404,
    );
    expect((await api('GET', `/profiles/${people.Sara!.userId}`, people.Bilal!)).statusCode).toBe(
      404,
    );
  });
});
