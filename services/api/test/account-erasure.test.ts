import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  erasureReport,
  executeDueErasures,
  type ErasureServices,
} from '../scripts/account-erasure';
import type { Queryable } from '../scripts/phase1-security-checks';
import { assertNoForbiddenSecrets } from '../src/config';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * Account erasure after the grace period (ERD E1, migration 0035, the erasure tool).
 *
 * The deletion screen has promised since 0030 that an account is removed after 30
 * days, and nothing did it. These run the real tool against the real migrations: what
 * is removed, what the other person keeps, what holds it, and that a failure part-way
 * leaves the account exactly as it was.
 */

interface Member {
  userId: string;
  authId: string;
}

let harness: TestHarness;
let db: Queryable;
let seq = 0;

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  auth: string,
  payload?: Record<string, unknown>,
) =>
  harness.app.inject({ method, url, headers: authHeader(auth), ...(payload ? { payload } : {}) });

async function seedMember(gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users
       (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active', now()) returning id`,
    [`Erasure ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
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
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

/** Two members with a conversation and a message each way. */
async function talking(): Promise<{ leaver: Member; other: Member; conversationId: string }> {
  const leaver = await seedMember('female');
  const other = await seedMember('male');
  const sent = await call('POST', '/interests', other.authId, {
    recipientUserId: leaver.userId,
    note: 'A note from the one who stays.',
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const accepted = await call('POST', `/interests/${sent.json().id}/respond`, leaver.authId, {
    decision: 'accept',
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [accepted.json().match.id],
  );
  const conversationId = rows.rows[0]!.id;
  for (const [who, body] of [
    [leaver, 'Salaam from the one who leaves.'],
    [other, 'Wa alaikum salaam.'],
  ] as const) {
    const res = await call('POST', `/conversations/${conversationId}/messages`, who.authId, {
      body,
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  return { leaver, other, conversationId };
}

async function uploadPhoto(member: Member): Promise<void> {
  const target = await call('POST', '/me/photos/upload-url', member.authId, {
    contentType: 'image/jpeg',
    byteSize: 120_000,
  });
  expect(target.statusCode, target.body).toBe(201);
  const jpeg = await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: '#1e785a' },
  })
    .jpeg()
    .toBuffer();
  harness.storage.put(target.json().path, jpeg);
  const finalized = await call(
    'POST',
    `/me/photos/${target.json().photoId}/finalize`,
    member.authId,
  );
  expect(finalized.statusCode, finalized.body).toBe(202);
}

/** Asks for deletion through the API, then moves the grace period into the past. */
async function dueForDeletion(member: Member): Promise<void> {
  const asked = await call('POST', '/me/delete', member.authId);
  expect(asked.statusCode, asked.body).toBe(202);
  await harness.raw.query(
    `update public.account_deletion_requests
        set requested_at = now() - interval '31 days', scheduled_for = now() - interval '1 day'
      where user_id = $1::uuid and status in ('pending', 'held')`,
    [member.userId],
  );
}

interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Supabase Storage and Auth, standing in, over the same in-memory bucket the API wrote
 * the photos to. Lists a folder as Storage does (a sub-folder is an entry with no id),
 * deletes exactly the names it is given, and records every call.
 */
function fakeSupabase(
  options: {
    storage?: number;
    auth?: number;
    hang?: boolean;
    beforeDelete?: () => Promise<void>;
  } = {},
) {
  const calls: FakeCall[] = [];
  const objects = harness.storage.objects;
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const services: ErasureServices = {
    supabaseUrl: 'https://project.supabase.test',
    serviceKey: 'service-key-for-tests',
    timeoutMs: options.hang ? 50 : 10_000,
    fetchImpl: (async (input: string, init: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method: String(init.method), path, body });
      if (options.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }
      if (path === '/storage/v1/object/list/photos') {
        const { prefix, limit, offset } = body as { prefix: string; limit: number; offset: number };
        const entries = new Map<string, string | null>();
        for (const key of [...objects.keys()].sort()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash === -1) entries.set(rest, `object-${rest}`);
          else entries.set(rest.slice(0, slash), null);
        }
        return json([...entries].slice(offset, offset + limit).map(([name, id]) => ({ name, id })));
      }
      if (path === '/storage/v1/object/photos' && init.method === 'DELETE') {
        await options.beforeDelete?.();
        if (options.storage) return new Response('', { status: options.storage });
        const names = (body as { prefixes: string[] }).prefixes;
        return json(names.filter((name) => objects.delete(name)).map((name) => ({ name })));
      }
      if (path.startsWith('/auth/v1/admin/users/') && init.method === 'DELETE') {
        if (options.auth) return new Response('', { status: options.auth });
        return json({});
      }
      return new Response('', { status: 404 });
    }) as typeof fetch,
  };
  return { services, calls };
}

const filesOf = (member: Member) =>
  [...harness.storage.objects.keys()].filter((key) => key.startsWith(`${member.userId}/`));

const userRow = async (userId: string) =>
  (
    await harness.raw.query<{
      display_name: string | null;
      date_of_birth: string | null;
      status: string;
      deleted_at: string | null;
    }>(
      `select display_name, date_of_birth, status, deleted_at from public.users where id = $1::uuid`,
      [userId],
    )
  ).rows[0]!;

const count = async (sql: string, params: unknown[]) =>
  Number((await harness.raw.query<{ n: number }>(sql, params)).rows[0]!.n);

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
  db = { query: (sql, params) => harness.raw.query(sql, params) as never };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  // Each test sees only its own due requests.
  await harness.raw.query(
    `update public.account_deletion_requests set status = 'cancelled', cancelled_at = now()
      where status = 'pending'`,
  );
});

describe('reading an open request back', () => {
  it('a member who asked can see when, after the app restarts', async () => {
    const member = await seedMember('female');
    expect((await call('GET', '/me/delete', member.authId)).statusCode).toBe(404);
    await call('POST', '/me/delete', member.authId);
    const open = await call('GET', '/me/delete', member.authId);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json()).toMatchObject({ status: 'pending', heldReason: null });
    expect(Date.parse(open.json().scheduledFor) - Date.parse(open.json().requestedAt)).toBe(
      30 * 24 * 3600 * 1000,
    );
    await call('DELETE', '/me/delete', member.authId);
    expect((await call('GET', '/me/delete', member.authId)).statusCode).toBe(404);
  });
});

describe('a dry run', () => {
  it('says what would happen and changes nothing', async () => {
    const { leaver } = await talking();
    await uploadPhoto(leaver);
    await dueForDeletion(leaver);
    const filesBefore = filesOf(leaver);

    const summary = await executeDueErasures(db, null, { apply: false });
    expect(summary).toMatchObject({ applied: false, considered: 1, erased: 0, held: 0 });
    expect(summary.planned).toEqual([
      expect.objectContaining({ outcome: 'erase', signIns: 1, files: expect.any(Number) }),
    ]);
    expect(summary.planned[0]!.files).toBeGreaterThanOrEqual(3);
    expect((await userRow(leaver.userId)).display_name).toMatch(/^Erasure/);
    expect(filesOf(leaver)).toEqual(filesBefore);
    expect(await erasureReport(db)).toMatchObject({ due: 1 });
  });

  it('refuses to apply without Storage and Auth access', async () => {
    await expect(executeDueErasures(db, null, { apply: true })).rejects.toThrow(/needs Storage/);
  });
});

describe('erasing an account whose grace period has ended', () => {
  let leaver: Member;
  let other: Member;
  let relative: Member;
  let noteRecipient: Member;
  let conversationId: string;
  let calls: FakeCall[];
  let summary: Awaited<ReturnType<typeof executeDueErasures>>;
  let photoPaths: string[];
  let othersFiles: string[];
  let nameWhenFilesWentFirst: string | null | undefined;
  const orphan = () => `${leaver.userId}/left-behind-by-a-failed-finalize/blurred.jpg`;

  beforeAll(async () => {
    ({ leaver, other, conversationId } = await talking());
    relative = await seedMember('male');
    noteRecipient = await seedMember('male');
    const noted = await call('POST', '/interests', leaver.authId, {
      recipientUserId: noteRecipient.userId,
      note: 'A note from the one who leaves.',
    });
    expect(noted.statusCode, noted.body).toBe(201);
    await uploadPhoto(leaver);
    await uploadPhoto(other);
    // A file with no row: what a finalize that failed after writing its variants, or a
    // member's own delete whose Storage call failed, leaves behind.
    harness.storage.put(orphan(), Buffer.from('bytes'));
    await harness.raw.query(
      `insert into public.profile_sensitive (user_id, phone_e164, email)
       values ($1::uuid, '+923001234567', 'private@example.com')`,
      [leaver.userId],
    );
    const invite = await call('POST', '/family/invitations', leaver.authId, {
      inviteeContact: 'relative@example.com',
      relationshipCode: 'father',
      tier: 'observer',
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const joined = await call(
      'POST',
      `/family/invitations/${invite.json().id}/respond`,
      relative.authId,
      { token: invite.json().token, accept: true },
    );
    expect(joined.statusCode, joined.body).toBeLessThan(300);
    expect((await call('GET', '/family/managed', relative.authId)).json().items).toHaveLength(1);
    photoPaths = (
      await harness.raw.query<{ path: string }>(
        `select storage_path as path from public.photos where user_id = $1::uuid
         union select v.storage_path from public.photo_variants v
           join public.photos p on p.id = v.photo_id where p.user_id = $1::uuid`,
        [leaver.userId],
      )
    ).rows.map((r) => r.path);
    othersFiles = filesOf(other);
    expect(othersFiles.length).toBeGreaterThan(0);
    await dueForDeletion(leaver);

    const fake = fakeSupabase({
      // Inside the tool's open transaction: the database step has already run.
      beforeDelete: async () => {
        if (nameWhenFilesWentFirst === undefined) {
          nameWhenFilesWentFirst = (await userRow(leaver.userId)).display_name;
        }
      },
    });
    calls = fake.calls;
    summary = await executeDueErasures(db, fake.services, { apply: true });
  }, 120_000);

  it('reports one erasure and no failure', () => {
    expect(summary).toMatchObject({ applied: true, considered: 1, erased: 1, held: 0, failed: [] });
  });

  it('deleted every file in the member’s folder, including one with no row, and nobody else’s', () => {
    expect(filesOf(leaver)).toEqual([]);
    expect(filesOf(other)).toEqual(othersFiles);
    const deleted = calls
      .filter((c) => c.method === 'DELETE' && c.path === '/storage/v1/object/photos')
      .flatMap((c) => (c.body as { prefixes: string[] }).prefixes);
    expect(deleted).toEqual(expect.arrayContaining([...photoPaths, orphan()]));
    expect(deleted.every((name) => name.startsWith(`${leaver.userId}/`))).toBe(true);
    // Every folder listed was inside the member's own.
    for (const listed of calls.filter((c) => c.path === '/storage/v1/object/list/photos')) {
      expect((listed.body as { prefix: string }).prefix.startsWith(`${leaver.userId}/`)).toBe(true);
    }
  });

  it('anonymised the database first, then the files, then the sign-in, then committed', () => {
    // The database step ran (uncommitted) before anything irreversible.
    expect(nameWhenFilesWentFirst).toBeNull();
    const firstDelete = calls.findIndex(
      (c) => c.method === 'DELETE' && c.path === '/storage/v1/object/photos',
    );
    const signIn = calls.filter((c) => c.path.startsWith('/auth/v1/admin/users/'));
    expect(signIn.map((c) => [c.method, c.path.split('/').pop()])).toEqual([
      ['DELETE', leaver.authId],
    ]);
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(calls.indexOf(signIn[0]!));
  });

  it('removed the name and date of birth, keeping a tombstone', async () => {
    const row = await userRow(leaver.userId);
    expect(row).toMatchObject({
      display_name: null,
      date_of_birth: null,
      status: 'pending_deletion',
    });
    expect(row.deleted_at).not.toBeNull();
  });

  it('removed the profile, sensitive fields, location, settings and invitations', async () => {
    for (const table of [
      'profiles',
      'profile_sensitive',
      'user_locations',
      'user_settings',
      'verification_status',
      'user_devices',
    ]) {
      expect(
        await count(`select count(*)::int as n from public.${table} where user_id = $1::uuid`, [
          leaver.userId,
        ]),
        table,
      ).toBe(0);
    }
    expect(
      await count(
        `select count(*)::int as n from public.family_invitations where owner_user_id = $1::uuid`,
        [leaver.userId],
      ),
    ).toBe(0);
  });

  it('ended the family link and every permission on it, as removing a relative does', async () => {
    expect((await call('GET', '/family/managed', relative.authId)).json().items).toEqual([]);
    expect(
      await count(
        `select count(*)::int as n from public.family_permissions p
           join public.family_relationships r on r.id = p.relationship_id
          where r.owner_user_id = $1::uuid and (p.granted or r.status = 'active')`,
        [leaver.userId],
      ),
    ).toBe(0);
  });

  it('soft-deleted the photos and removed their variants', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.photos where user_id = $1::uuid and deleted_at is null`,
        [leaver.userId],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from public.photo_variants v join public.photos p on p.id = v.photo_id
          where p.user_id = $1::uuid`,
        [leaver.userId],
      ),
    ).toBe(0);
  });

  it('the other person keeps the conversation, read-only, with both sides of it', async () => {
    const history = await call('GET', `/conversations/${conversationId}/messages`, other.authId);
    expect(history.statusCode, history.body).toBe(200);
    expect((history.json() as { items: { body: string }[] }).items.map((m) => m.body)).toEqual([
      'Wa alaikum salaam.',
      'Salaam from the one who leaves.',
    ]);
    // Still in their list, shown as over rather than active.
    const list = await call('GET', '/conversations', other.authId);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({
        id: conversationId,
        status: 'ended',
        counterpartDisplayName: null,
        canWrite: false,
        writeBlockedReason: 'counterpart_left',
      }),
    ]);
    const thread = await call('GET', `/conversations/${conversationId}`, other.authId);
    expect(thread.json()).toMatchObject({ status: 'ended', canWrite: false });
    const send = await call('POST', `/conversations/${conversationId}/messages`, other.authId, {
      body: 'Are you there?',
    });
    expect(send.statusCode).toBeGreaterThanOrEqual(400);
    // Recorded as a departure (B25), not only as the match ending, so the thread stays
    // closed even if the match were ever revived.
    expect(
      await count(
        `select count(*)::int as n from public.conversation_participants
          where conversation_id = $1::uuid and user_id = $2::uuid and left_at is not null`,
        [conversationId, leaver.userId],
      ),
    ).toBe(1);
  });

  it('ended the match, and the erased member is gone from discovery', async () => {
    expect((await call('GET', '/matches', other.authId)).json().items).toEqual([]);
    expect((await call('GET', `/profiles/${leaver.userId}`, other.authId)).statusCode).toBe(404);
  });

  it('marked the request executed, so a second run does nothing', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.account_deletion_requests
          where user_id = $1::uuid and status = 'executed' and executed_at is not null`,
        [leaver.userId],
      ),
    ).toBe(1);
    const again = await executeDueErasures(db, fakeSupabase().services, { apply: true });
    expect(again).toMatchObject({ considered: 0, erased: 0 });
  });

  it('removed the note the member wrote on an interest, and kept the other person’s', async () => {
    const received = await call('GET', '/interests?direction=received', noteRecipient.authId);
    expect(received.statusCode, received.body).toBe(200);
    expect(received.json().items).toEqual([
      expect.objectContaining({ counterpartUserId: leaver.userId, note: null }),
    ]);
    expect(received.body).not.toContain('A note from the one who leaves.');
    const sent = await call('GET', '/interests?direction=sent', other.authId);
    expect(sent.json().items).toEqual([
      expect.objectContaining({
        counterpartUserId: leaver.userId,
        note: 'A note from the one who stays.',
      }),
    ]);
  });

  it('a session token issued before the erasure cannot create a new account or read anything', async () => {
    // Supabase access tokens stay valid until they expire; the sign-in behind this one
    // is gone, so no new token can be had, but this one still verifies.
    const usersBefore = await count(`select count(*)::int as n from public.users`, []);
    const bootstrap = await harness.app.inject({
      method: 'POST',
      url: '/account/bootstrap',
      headers: authHeader(leaver.authId),
      payload: {
        locale: 'en',
        timezone: 'Asia/Karachi',
        deviceId: 'device-after-erasure',
        platform: 'android',
      },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(404);
    expect(await count(`select count(*)::int as n from public.users`, [])).toBe(usersBefore);
    expect(
      await count(
        `select count(*)::int as n from public.user_devices where device_id = 'device-after-erasure'`,
        [],
      ),
    ).toBe(0);
    // Still pointing at the tombstone, which is what refuses the token.
    expect(
      await count(
        `select count(*)::int as n from public.user_auth_links
          where user_id = $1::uuid and auth_user_id = $2::uuid`,
        [leaver.userId, leaver.authId],
      ),
    ).toBe(1);

    expect((await call('GET', '/me', leaver.authId)).statusCode).toBe(404);
    expect((await call('GET', '/me/delete', leaver.authId)).statusCode).toBe(404);
    expect((await call('DELETE', '/me/delete', leaver.authId)).statusCode).toBe(404);
    expect((await call('POST', '/me/delete', leaver.authId)).statusCode).toBe(404);
    for (const url of ['/conversations', `/conversations/${conversationId}/messages`, '/matches']) {
      const res = await call('GET', url, leaver.authId);
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.body).not.toContain('Wa alaikum salaam.');
    }
    const write = await call('POST', '/interests', leaver.authId, {
      recipientUserId: other.userId,
    });
    expect(write.statusCode).toBe(403);
    // And the database refuses it directly, whatever a route might do.
    const visible = await harness.db.asUser(leaver.authId, (session) =>
      session.query<{ n: number }>(
        `select count(*)::int as n from public.messages where conversation_id = $1::uuid`,
        [conversationId],
      ),
    );
    expect(Number(visible[0]!.n)).toBe(0);
  });

  it('kept the tombstone, so the other person’s records still point at someone', async () => {
    // Every user foreign key is `on delete restrict` (ERD E1): the messages, match and
    // interest above still reference this row, which is why it survives.
    expect(
      await count(`select count(*)::int as n from public.users where id = $1::uuid`, [
        leaver.userId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from public.messages where sender_user_id = $1::uuid`,
        [leaver.userId],
      ),
    ).toBe(1);
  });
});

describe('what stops an erasure', () => {
  it('an open report holds the request, and nothing is deleted', async () => {
    const { leaver, other } = await talking();
    await uploadPhoto(leaver);
    const report = await call('POST', '/reports', other.authId, {
      reportedUserId: leaver.userId,
      category: 'scam',
      description: 'Asked me for money.',
    });
    expect(report.statusCode, report.body).toBe(201);
    // Asked after the report, so the request starts held; release it to test the recheck.
    await dueForDeletion(leaver);
    await harness.raw.query(
      `update public.account_deletion_requests set status = 'pending', retention_hold_reason = null
        where user_id = $1::uuid and status = 'held'`,
      [leaver.userId],
    );
    const filesBefore = filesOf(leaver);

    const fake = fakeSupabase();
    const summary = await executeDueErasures(db, fake.services, { apply: true });
    expect(summary).toMatchObject({ erased: 0, held: 1 });
    expect(fake.calls).toEqual([]);
    expect(filesOf(leaver)).toEqual(filesBefore);
    expect((await userRow(leaver.userId)).display_name).toMatch(/^Erasure/);
    const open = await call('GET', '/me/delete', leaver.authId);
    expect(open.json()).toMatchObject({ status: 'held' });
  });

  it('a report closed while the tool runs is erased completely, never only in the database', async () => {
    const { leaver, other } = await talking();
    await uploadPhoto(leaver);
    await call('POST', '/reports', other.authId, {
      reportedUserId: leaver.userId,
      category: 'scam',
      description: 'Asked me for money.',
    });
    await dueForDeletion(leaver);
    await harness.raw.query(
      `update public.account_deletion_requests set status = 'pending', retention_hold_reason = null
        where user_id = $1::uuid and status = 'held'`,
      [leaver.userId],
    );
    // The tool saw the open report; staff dismiss it before the database step runs.
    const racing: Queryable = {
      query: async (sql, params) => {
        if (sql.includes('app.erase_account')) {
          await harness.raw.query(
            `update public.reports set status = 'dismissed', resolved_at = now(),
                    outcome_key = 'no_violation'
              where reported_user_id = $1::uuid and status in ('open', 'triaged')`,
            [leaver.userId],
          );
        }
        return db.query(sql, params);
      },
    };
    const fake = fakeSupabase();
    const summary = await executeDueErasures(racing, fake.services, { apply: true });
    expect(summary).toMatchObject({ erased: 1, held: 0, failed: [] });
    // The files and the sign-in went with the database rows.
    expect(filesOf(leaver)).toEqual([]);
    expect(fake.calls.filter((c) => c.path.startsWith('/auth/v1/admin/users/'))).toHaveLength(1);
  });

  it('a held request is never executed: releasing it is for staff', async () => {
    const member = await seedMember('male');
    await dueForDeletion(member);
    await harness.raw.query(
      `update public.account_deletion_requests
          set status = 'held', retention_hold_reason = 'A legal hold.'
        where user_id = $1::uuid and status = 'pending'`,
      [member.userId],
    );
    const fake = fakeSupabase();
    const summary = await executeDueErasures(db, fake.services, { apply: true });
    expect(summary.considered).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('a retention hold on the account survives the member cancelling and asking again', async () => {
    const member = await seedMember('female');
    await uploadPhoto(member);
    await harness.raw.query(
      `insert into public.account_retention_holds (user_id, reason)
       values ($1::uuid, 'Preservation request, case 1.')`,
      [member.userId],
    );
    await dueForDeletion(member);
    const dry = await executeDueErasures(db, null, { apply: false });
    expect(dry.planned).toEqual([expect.objectContaining({ outcome: 'hold' })]);

    const fake = fakeSupabase();
    expect(await executeDueErasures(db, fake.services, { apply: true })).toMatchObject({
      erased: 0,
      held: 1,
    });
    expect(fake.calls).toEqual([]);
    // Told in general terms, never the hold's own reason.
    const shown = await call('GET', '/me/delete', member.authId);
    expect(shown.json()).toMatchObject({
      status: 'held',
      heldReason: 'A legal review on this account must finish before it can be deleted.',
    });
    expect(shown.body).not.toContain('Preservation request');

    // The way round the old request-only hold: cancel, then ask again.
    expect((await call('DELETE', '/me/delete', member.authId)).statusCode).toBe(204);
    await dueForDeletion(member);
    expect(await executeDueErasures(db, fake.services, { apply: true })).toMatchObject({
      erased: 0,
      held: 1,
    });
    expect(fake.calls).toEqual([]);
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
    await expect(
      harness.raw.query(`select app.erasure_blocker($1::uuid) as b`, [member.userId]),
    ).resolves.toMatchObject({ rows: [{ b: 'held' }] });
  });

  it('a released hold stops blocking once staff release the request as well', async () => {
    const member = await seedMember('male');
    await harness.raw.query(
      `insert into public.account_retention_holds (user_id, reason) values ($1::uuid, 'Litigation.')`,
      [member.userId],
    );
    await dueForDeletion(member);
    expect((await executeDueErasures(db, fakeSupabase().services, { apply: true })).held).toBe(1);
    await harness.raw.query(
      `update public.account_retention_holds set released_at = now() where user_id = $1::uuid`,
      [member.userId],
    );
    // The request is still held: releasing it is a separate staff decision.
    expect(
      (await executeDueErasures(db, fakeSupabase().services, { apply: true })).considered,
    ).toBe(0);
    await harness.raw.query(
      `update public.account_deletion_requests set status = 'pending', retention_hold_reason = null
        where user_id = $1::uuid and status = 'held'`,
      [member.userId],
    );
    expect((await executeDueErasures(db, fakeSupabase().services, { apply: true })).erased).toBe(1);
  });

  it('a request still in its grace period is not touched', async () => {
    const member = await seedMember('female');
    await call('POST', '/me/delete', member.authId);
    const summary = await executeDueErasures(db, fakeSupabase().services, { apply: true });
    expect(summary.considered).toBe(0);
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
  });

  it('a wrong scheduled date cannot bring an erasure forward: 30 days from asking still apply', async () => {
    const member = await seedMember('female');
    await call('POST', '/me/delete', member.authId);
    await harness.raw.query(
      `update public.account_deletion_requests
          set requested_at = now() - interval '29 days', scheduled_for = now() - interval '1 hour'
        where user_id = $1::uuid and status = 'pending'`,
      [member.userId],
    );
    const fake = fakeSupabase();
    const summary = await executeDueErasures(db, fake.services, { apply: true });
    expect(summary.skipped).toEqual([expect.objectContaining({ reason: 'grace_period_running' })]);
    expect(fake.calls).toEqual([]);
    await expect(
      harness.raw.query(`select app.erase_account($1::uuid)`, [member.userId]),
    ).rejects.toThrow(/cannot be erased: grace_period_running/);
  });

  it('a staff account is skipped, with nothing deleted, until its staff access is removed', async () => {
    const member = await seedMember('female');
    await harness.raw.query(
      `insert into public.admin_users (user_id, mfa_required) values ($1::uuid, false)`,
      [member.userId],
    );
    await dueForDeletion(member);
    const fake = fakeSupabase();
    const summary = await executeDueErasures(db, fake.services, { apply: true });
    expect(summary.skipped).toEqual([expect.objectContaining({ reason: 'staff_account' })]);
    expect(fake.calls).toEqual([]);
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
  });

  it('a request skipped every run does not use up the limit, so the others are reached', async () => {
    const staff = await seedMember('female');
    await harness.raw.query(
      `insert into public.admin_users (user_id, mfa_required) values ($1::uuid, false)`,
      [staff.userId],
    );
    await dueForDeletion(staff);
    const member = await seedMember('male');
    await dueForDeletion(member);
    // The skipped one is first in line.
    await harness.raw.query(
      `update public.account_deletion_requests set scheduled_for = now() - interval '2 days'
        where user_id = $1::uuid and status = 'pending'`,
      [staff.userId],
    );
    const summary = await executeDueErasures(db, fakeSupabase().services, {
      apply: true,
      limit: 1,
    });
    expect(summary).toMatchObject({ erased: 1, considered: 2 });
    expect(summary.skipped).toEqual([expect.objectContaining({ reason: 'staff_account' })]);
    expect((await userRow(member.userId)).display_name).toBeNull();
  });

  it('a database failure deletes no file and no sign-in', async () => {
    const member = await seedMember('female');
    await uploadPhoto(member);
    await dueForDeletion(member);
    const filesBefore = filesOf(member);
    // A row the function cannot remove, standing in for any schema surprise.
    await harness.raw.query(`
      create function public.test_refuse_erasure() returns trigger language plpgsql as $$
      begin raise exception 'simulated failure'; end $$`);
    await harness.raw.query(`
      create trigger test_refuse_erasure before delete on public.profiles
        for each row when (old.user_id = '${member.userId}'::uuid)
        execute function public.test_refuse_erasure()`);
    try {
      const fake = fakeSupabase();
      const summary = await executeDueErasures(db, fake.services, { apply: true });
      expect(summary.failed).toEqual([
        expect.objectContaining({ step: 'database', code: 'P0001' }),
      ]);
      expect(fake.calls).toEqual([]);
      expect(filesOf(member)).toEqual(filesBefore);
      expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
    } finally {
      await harness.raw.query(`drop trigger test_refuse_erasure on public.profiles`);
      await harness.raw.query(`drop function public.test_refuse_erasure()`);
    }
    expect((await executeDueErasures(db, fakeSupabase().services, { apply: true })).erased).toBe(1);
  });

  it('a Storage failure rolls everything back, and the sign-in is not touched', async () => {
    const { leaver } = await talking();
    await uploadPhoto(leaver);
    await dueForDeletion(leaver);
    const fake = fakeSupabase({ storage: 500 });
    const summary = await executeDueErasures(db, fake.services, { apply: true });
    expect(summary.failed).toEqual([
      expect.objectContaining({ step: 'storage', code: 'http_500' }),
    ]);
    expect(fake.calls.filter((c) => c.path.startsWith('/auth/'))).toEqual([]);
    expect((await userRow(leaver.userId)).display_name).toMatch(/^Erasure/);
    for (const table of ['profiles', 'user_locations', 'user_settings']) {
      expect(
        await count(`select count(*)::int as n from public.${table} where user_id = $1::uuid`, [
          leaver.userId,
        ]),
        table,
      ).toBeGreaterThan(0);
    }
    expect(
      await count(
        `select count(*)::int as n from public.conversation_participants
          where user_id = $1::uuid and left_at is not null`,
        [leaver.userId],
      ),
    ).toBe(0);
    // The next run finishes it.
    const retry = await executeDueErasures(db, fakeSupabase().services, { apply: true });
    expect(retry.erased).toBe(1);
    expect(filesOf(leaver)).toEqual([]);
  });

  it('a commit that fails after the files and sign-in are gone is finished by the next run', async () => {
    const member = await seedMember('female');
    await uploadPhoto(member);
    await dueForDeletion(member);
    // The narrowest window: everything outside the database is already deleted.
    const failingCommit: Queryable = {
      query: async (sql, params) => {
        if (sql === 'commit') throw Object.assign(new Error('connection lost'), { code: '08006' });
        return db.query(sql, params);
      },
    };
    const first = fakeSupabase();
    const failed = await executeDueErasures(failingCommit, first.services, { apply: true });
    expect(failed.failed).toEqual([expect.objectContaining({ step: 'commit', code: '08006' })]);
    expect(filesOf(member)).toEqual([]);
    // The database was rolled back: the account is intact and the request still due.
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);

    // The sign-in is already gone (404) and the files are already gone: the retry
    // still completes, and touches nothing outside the member's folder.
    const retry = fakeSupabase({ auth: 404 });
    const done = await executeDueErasures(db, retry.services, { apply: true });
    expect(done).toMatchObject({ erased: 1, failed: [] });
    expect((await userRow(member.userId)).display_name).toBeNull();
    const deleted = retry.calls
      .filter((c) => c.method === 'DELETE' && c.path === '/storage/v1/object/photos')
      .flatMap((c) => (c.body as { prefixes: string[] }).prefixes);
    expect(deleted.every((name) => name.startsWith(`${member.userId}/`))).toBe(true);
  });

  it('a call that never answers times out and rolls back', async () => {
    const member = await seedMember('male');
    await uploadPhoto(member);
    await dueForDeletion(member);
    const summary = await executeDueErasures(db, fakeSupabase({ hang: true }).services, {
      apply: true,
    });
    expect(summary.failed).toEqual([expect.objectContaining({ step: 'storage', code: 'timeout' })]);
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
  });

  it('a sign-in that is already gone counts as deleted', async () => {
    const member = await seedMember('male');
    await dueForDeletion(member);
    const summary = await executeDueErasures(db, fakeSupabase({ auth: 404 }).services, {
      apply: true,
    });
    expect(summary.erased).toBe(1);
  });

  it('an Auth failure rolls the database back', async () => {
    const member = await seedMember('female');
    await dueForDeletion(member);
    const summary = await executeDueErasures(db, fakeSupabase({ auth: 500 }).services, {
      apply: true,
    });
    expect(summary.failed).toEqual([expect.objectContaining({ step: 'auth', code: 'http_500' })]);
    expect((await userRow(member.userId)).display_name).toMatch(/^Erasure/);
  });

  it('a failure says which step and which code, never a message, a name or a path', async () => {
    const member = await seedMember('female');
    await uploadPhoto(member);
    await dueForDeletion(member);
    const summary = await executeDueErasures(db, fakeSupabase({ storage: 503 }).services, {
      apply: true,
    });
    expect(summary.failed).toEqual([
      expect.objectContaining({ step: 'storage', code: 'http_503' }),
    ]);
    const printed = JSON.stringify(summary);
    expect(printed).not.toContain(member.userId);
    expect(printed).not.toContain(member.authId);
    expect(printed).not.toMatch(/Erasure \d+|original\.jpg|service-key/);
  });
});

describe('who may erase', () => {
  it('a member cannot run the erasure, even on their own account', async () => {
    const member = await seedMember('female');
    await dueForDeletion(member);
    await expect(
      harness.db.asUser(member.authId, (session) =>
        session.query(`select app.erase_account($1::uuid)`, [member.userId]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      harness.db.asUser(member.authId, (session) =>
        session.query(`select app.erasure_blocker($1::uuid)`, [member.userId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a member can neither see nor change a retention hold, even their own', async () => {
    const member = await seedMember('female');
    await harness.raw.query(
      `insert into public.account_retention_holds (user_id, reason) values ($1::uuid, 'Internal.')`,
      [member.userId],
    );
    await expect(
      harness.db.asUser(member.authId, (session) =>
        session.query(`select reason from public.account_retention_holds`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      harness.db.asUser(member.authId, (session) =>
        session.query(`update public.account_retention_holds set released_at = now()`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the database refuses an account with no open, due request, whoever calls it', async () => {
    const member = await seedMember('male');
    await expect(
      harness.raw.query(`select app.erase_account($1::uuid)`, [member.userId]),
    ).rejects.toThrow(/cannot be erased: no_open_request/);
    await call('POST', '/me/delete', member.authId);
    await expect(
      harness.raw.query(`select app.erase_account($1::uuid)`, [member.userId]),
    ).rejects.toThrow(/cannot be erased: grace_period_running/);
  });

  it('the API refuses to start with either tool’s service key in its environment', () => {
    for (const name of ['ERASURE_TOOL_SERVICE_KEY', 'LEGACY_TOOL_STORAGE_KEY']) {
      expect(() => assertNoForbiddenSecrets({ [name]: 'a-value' } as NodeJS.ProcessEnv)).toThrow(
        new RegExp(`Refusing to start: ${name}`),
      );
    }
    expect(() => assertNoForbiddenSecrets({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('the family review SLA, swept for everyone', () => {
  async function stalledReview(): Promise<{
    owner: Member;
    suitor: Member;
    relative: Member;
    matchId: string;
  }> {
    const owner = await seedMember('female');
    const suitor = await seedMember('male');
    const relative = await seedMember('male');
    const invite = await call('POST', '/family/invitations', owner.authId, {
      inviteeContact: 'father@example.com',
      relationshipCode: 'father',
      tier: 'reviewer',
    });
    await call('POST', `/family/invitations/${invite.json().id}/respond`, relative.authId, {
      token: invite.json().token,
      accept: true,
    });
    await harness.raw.query(
      `update public.user_settings set communication_policy = 'family_reviewed' where user_id = $1::uuid`,
      [owner.userId],
    );
    const sent = await call('POST', '/interests', suitor.authId, { recipientUserId: owner.userId });
    const answer = await call('POST', `/interests/${sent.json().id}/respond`, owner.authId, {
      decision: 'accept',
    });
    expect(answer.json().match.communicationState).toBe('pending_family_review');
    await harness.raw.query(
      `update public.family_reviews set requested_at = now() - interval '73 hours'
        where owner_user_id = $1::uuid`,
      [owner.userId],
    );
    return { owner, suitor, relative, matchId: answer.json().match.id };
  }

  const stalledNotices = (member: Member) =>
    count(
      `select count(*)::int as n from public.notifications
        where user_id = $1::uuid and type = 'family_review_stalled'`,
      [member.userId],
    );

  it('warns the owner once, and nobody else', async () => {
    const { owner, suitor, relative } = await stalledReview();

    const first = await harness.raw.query<{ n: number }>(
      `select app.notify_stalled_family_reviews() as n`,
    );
    expect(first.rows[0]!.n).toBeGreaterThanOrEqual(1);
    const second = await harness.raw.query<{ n: number }>(
      `select app.notify_stalled_family_reviews() as n`,
    );
    expect(second.rows[0]!.n).toBe(0);
    expect(await stalledNotices(owner)).toBe(1);
    expect(await stalledNotices(suitor)).toBe(0);
    expect(await stalledNotices(relative)).toBe(0);
  });

  it('says nothing about a review that can no longer be decided', async () => {
    const { owner, suitor, matchId } = await stalledReview();
    const ended = await call('POST', `/matches/${matchId}/unmatch`, suitor.authId, {});
    expect(ended.statusCode, ended.body).toBeLessThan(300);
    await harness.raw.query(`select app.notify_stalled_family_reviews()`);
    expect(await stalledNotices(owner)).toBe(0);
  });
});
