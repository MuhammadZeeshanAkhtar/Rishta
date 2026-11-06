import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timestampSchema } from '@nikahmate/domain';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/** The shape `isoTimestamp` renders: RFC 3339, UTC, milliseconds. */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Code review remediation, Phase 3 — through the real routes.
 *
 *   B5   no auto-approval; finalize once, only from pending
 *   B6   no auto-approval; edits re-reviewed; DOB locked, corrected by request
 *   B10  keyset pagination: no repeats while messages arrive
 *   B11  abandoned uploads stop holding photo slots
 *   B12  the stored original loses its EXIF
 *   B13  only an approved photo can be primary, checked before clearing
 *   B14  malformed ids are 400, not 500
 *   B19  bootstrap twice returns one account
 *   B20  cards carry badge keys, never timestamps
 *   B21  4xx problems name their cause
 *   B22  settings update scoped to the caller
 *   B23  the daily quota counts the member's own day
 *   B26  one message notification per conversation
 *   L1   the moderation backend: who, MFA, roles, decisions, audit
 *   L4   GET /profiles/{userId}, permission-filtered
 *
 * The database half (migration 0029) is in packages/db review-phase3-rls.test.ts.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(
  gender: 'male' | 'female',
  opts: { reviewStatus?: string; completed?: boolean } = {},
): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active',
             case when $3::boolean then now() else null end) returning id`,
    [`Phase3 ${seq}`, gender, opts.completed ?? true],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(
    `insert into public.verification_status (user_id, email_verified_at)
     values ($1::uuid, now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', $2, now())`,
    [userId, opts.reviewStatus ?? 'approved'],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

/** Staff: an existing member plus an admin row and roles. */
async function seedAdmin(roles: string[], mfaRequired = true): Promise<Member> {
  const member = await seedMember('female');
  const admin = await harness.raw.query<{ id: string }>(
    `insert into public.admin_users (user_id, mfa_required) values ($1::uuid, $2) returning id`,
    [member.userId, mfaRequired],
  );
  for (const role of roles) {
    await harness.raw.query(
      `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, $2)`,
      [admin.rows[0]!.id, role],
    );
  }
  return member;
}

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  auth: string,
  payload?: unknown,
  aal?: 'aal1' | 'aal2',
) =>
  harness.app.inject({
    method,
    url,
    headers: authHeader(auth, undefined, aal),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const staff = (method: 'GET' | 'POST', url: string, auth: string, payload?: unknown) =>
  call(method, url, auth, payload, 'aal2');

async function thread(): Promise<{ alice: Member; bilal: Member; conversationId: string }> {
  const alice = await seedMember('female');
  const bilal = await seedMember('male');
  const sent = await call('POST', '/interests', bilal.authId, { recipientUserId: alice.userId });
  expect(sent.statusCode, sent.body).toBe(201);
  const accepted = await call('POST', `/interests/${sent.json().id}/respond`, alice.authId, {
    decision: 'accept',
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [accepted.json().match.id],
  );
  return { alice, bilal, conversationId: rows.rows[0]!.id };
}

async function jpeg(withExif = false): Promise<Buffer> {
  const base = sharp({
    create: { width: 640, height: 800, channels: 3, background: { r: 30, g: 120, b: 90 } },
  }).jpeg();
  return withExif
    ? base.withExif({ IFD0: { Copyright: 'home address in metadata', Artist: 'phone' } }).toBuffer()
    : base.toBuffer();
}

async function upload(
  member: Member,
  body?: Buffer,
): Promise<{ photoId: string; path: string; finalized: number }> {
  const bytes = body ?? (await jpeg());
  const created = await call('POST', '/me/photos/upload-url', member.authId, {
    contentType: 'image/jpeg',
    byteSize: bytes.length,
  });
  expect(created.statusCode, created.body).toBe(201);
  const { photoId, path } = created.json() as { photoId: string; path: string };
  harness.storage.put(path, bytes);
  const finalized = await call('POST', `/me/photos/${photoId}/finalize`, member.authId);
  return { photoId, path, finalized: finalized.statusCode };
}

const photoStatus = async (photoId: string): Promise<{ status: string; primary: boolean }> => {
  const rows = await harness.raw.query<{ moderation_status: string; is_primary: boolean }>(
    `select moderation_status, is_primary from public.photos where id = $1::uuid`,
    [photoId],
  );
  return { status: rows.rows[0]!.moderation_status, primary: rows.rows[0]!.is_primary };
};

const auditCount = async (action: string, targetId: string): Promise<number> =>
  Number(
    (
      await harness.raw.query<{ n: string }>(
        `select count(*)::text as n from public.admin_action_audit
          where action = $1 and target_id = $2::uuid`,
        [action, targetId],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// =============================================================================
// B14 / B21
// =============================================================================

describe('B14 — malformed ids are refused before they reach the database', () => {
  it.each([
    ['GET', '/conversations/not-a-uuid'],
    ['GET', '/conversations/not-a-uuid/messages'],
    ['POST', '/me/photos/not-a-uuid/finalize'],
    ['DELETE', '/me/photos/12345'],
    ['POST', '/family/invitations/xyz/respond'],
    ['POST', '/family/reviews/xyz/decide'],
    ['GET', '/matches/------------------------------------'],
    ['GET', '/profiles/not-a-uuid'],
  ] as const)('%s %s answers 400, not 500', async (method, url) => {
    const member = await seedMember('female');
    const response = await call(
      method,
      url,
      member.authId,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('still answers 404 for a well-formed id that does not exist (the nil uuid included)', async () => {
    const member = await seedMember('female');
    const response = await call(
      'GET',
      '/conversations/00000000-0000-0000-0000-000000000000',
      member.authId,
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('B21 — a 4xx problem names its cause', () => {
  it('413 payload_too_large for an oversized body', async () => {
    const member = await seedMember('female');
    const response = await call('PATCH', '/me', member.authId, { locale: 'x'.repeat(1_200_000) });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('payload_too_large');
  });

  it('400 malformed_request for broken JSON', async () => {
    const member = await seedMember('female');
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { ...authHeader(member.authId), 'content-type': 'application/json' },
      payload: '{"locale": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('malformed_request');
  });

  it('415 unsupported_media_type for a body type the API does not take', async () => {
    const member = await seedMember('female');
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { ...authHeader(member.authId), 'content-type': 'application/xml' },
      payload: '<locale>en</locale>',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().code).toBe('unsupported_media_type');
  });
});

// =============================================================================
// B19 / B20 / B22 / B23
// =============================================================================

describe('B19 — first sign-in is idempotent', () => {
  it('a second bootstrap returns the same account instead of failing', async () => {
    const authId = randomAuthId();
    const body = { locale: 'en', timezone: 'Asia/Karachi' };
    const first = await call('POST', '/account/bootstrap', authId, body);
    const second = await call('POST', '/account/bootstrap', authId, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const users = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.user_auth_links where auth_user_id = $1::uuid`,
      [authId],
    );
    expect(users.rows[0]!.n).toBe('1');
  });
});

describe('B20 — cards say which checks passed, never when', () => {
  it('returns badge keys with earnedAt null', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    const cards = await call('GET', `/profiles/${target.userId}`, viewer.authId);
    expect(cards.statusCode, cards.body).toBe(200);
    const badges = cards.json().verification.badges as Array<{ key: string; earnedAt: unknown }>;
    expect(badges.map((b) => b.key)).toContain('email_verified');
    expect(badges.every((b) => b.earnedAt === null)).toBe(true);
  });
});

describe('B22 — PATCH /me changes the caller only', () => {
  it('leaves every other member untouched', async () => {
    const me = await seedMember('female');
    const other = await seedMember('male');
    const response = await call('PATCH', '/me', me.authId, { timezone: 'Europe/London' });
    expect(response.statusCode, response.body).toBe(200);
    const rows = await harness.raw.query<{ user_id: string; timezone: string }>(
      `select user_id, timezone from public.user_settings where user_id = any($1::uuid[])`,
      [[me.userId, other.userId]],
    );
    const byUser = Object.fromEntries(rows.rows.map((r) => [r.user_id, r.timezone]));
    expect(byUser[me.userId]).toBe('Europe/London');
    expect(byUser[other.userId]).toBe('UTC');
  });
});

describe('B23 — the daily interest quota counts the sender’s own day', () => {
  const periodOf = async (sender: Member): Promise<string> =>
    (
      await harness.raw.query<{ d: string }>(
        `select period_start::text as d from public.usage_counters where user_id = $1::uuid`,
        [sender.userId],
      )
    ).rows[0]!.d;

  it('uses the member’s timezone', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    // UTC+14: for ten hours of every UTC day this is already "tomorrow".
    await harness.raw.query(
      `update public.user_settings set timezone = 'Pacific/Kiritimati' where user_id = $1::uuid`,
      [sender.userId],
    );
    expect(
      (await call('POST', '/interests', sender.authId, { recipientUserId: recipient.userId }))
        .statusCode,
    ).toBe(201);
    const expected = await harness.raw.query<{ d: string }>(
      `select (now() at time zone 'Pacific/Kiritimati')::date::text as d`,
    );
    expect(await periodOf(sender)).toBe(expected.rows[0]!.d);
  });

  it('falls back to UTC for a zone Postgres does not know, instead of failing the send', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await harness.raw.query(
      `update public.user_settings set timezone = 'Not/AZone' where user_id = $1::uuid`,
      [sender.userId],
    );
    expect(
      (await call('POST', '/interests', sender.authId, { recipientUserId: recipient.userId }))
        .statusCode,
    ).toBe(201);
    const utc = await harness.raw.query<{ d: string }>(
      `select (now() at time zone 'UTC')::date::text as d`,
    );
    expect(await periodOf(sender)).toBe(utc.rows[0]!.d);
  });
});

// =============================================================================
// B10
// =============================================================================

describe('B10 — keyset pagination does not repeat while messages arrive', () => {
  it('"load earlier" after new messages returns only older ones, with no repeats', async () => {
    const t = await thread();
    for (let i = 1; i <= 5; i += 1) {
      const sent = await call(
        'POST',
        `/conversations/${t.conversationId}/messages`,
        t.alice.authId,
        {
          body: `old ${i}`,
        },
      );
      expect(sent.statusCode).toBe(201);
    }
    const first = await call(
      'GET',
      `/conversations/${t.conversationId}/messages?limit=2`,
      t.bilal.authId,
    );
    const page1 = first.json() as { items: { body: string }[]; nextCursor: string };
    expect(page1.items.map((m) => m.body)).toEqual(['old 5', 'old 4']);

    // Three new messages arrive. With row_number() cursors this shifted every
    // position by three and the next page repeated 'old 5' and 'old 4'.
    for (let i = 1; i <= 3; i += 1) {
      await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, {
        body: `new ${i}`,
      });
    }
    const second = await call(
      'GET',
      `/conversations/${t.conversationId}/messages?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      t.bilal.authId,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json().items as { body: string }[]).map((m) => m.body)).toEqual([
      'old 3',
      'old 2',
    ]);
  });

  it('refuses a cursor that is not one of ours, including an old position cursor', async () => {
    const t = await thread();
    const legacy = Buffer.from('r:2', 'utf8').toString('base64url');
    for (const cursor of ['garbage', legacy]) {
      const response = await call(
        'GET',
        `/conversations/${t.conversationId}/messages?cursor=${cursor}`,
        t.alice.authId,
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it('pages the conversation list without repeating a thread', async () => {
    const me = await seedMember('female');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const them = await seedMember('male');
      const sent = await call('POST', '/interests', them.authId, { recipientUserId: me.userId });
      const accepted = await call('POST', `/interests/${sent.json().id}/respond`, me.authId, {
        decision: 'accept',
      });
      ids.push(accepted.json().match.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/conversations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await call('GET', url, me.authId)).json() as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

// =============================================================================
// Photos: B5, B11, B12, B13
// =============================================================================

describe('B5 — no photo is approved without a moderator', () => {
  it('finalize queues the photo for review instead of approving it', async () => {
    const member = await seedMember('female');
    const { photoId, finalized } = await upload(member);
    expect(finalized).toBe(202);
    expect((await photoStatus(photoId)).status).toBe('pending');
    const verdicts = await harness.raw.query<{ provider: string; verdict: string }>(
      `select provider, verdict from public.media_moderation_results where photo_id = $1::uuid`,
      [photoId],
    );
    expect(verdicts.rows).toEqual([{ provider: 'none', verdict: 'review' }]);
  });

  it('refuses a second finalize, so a rejection cannot be undone by re-finalizing', async () => {
    const member = await seedMember('female');
    const { photoId } = await upload(member);
    await harness.raw.query(
      `update public.photos set moderation_status = 'rejected', moderated_at = now() where id = $1::uuid`,
      [photoId],
    );
    const again = await call('POST', `/me/photos/${photoId}/finalize`, member.authId);
    expect(again.statusCode).toBe(409);
    expect((await photoStatus(photoId)).status).toBe('rejected');
  });
});

describe('B11 — an abandoned upload stops holding a slot', () => {
  it('counts a live upload, then frees it once its URL has expired', async () => {
    const member = await seedMember('female');
    // Six upload URLs, never finalized: the limit is reached while they are live.
    const paths: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const created = await call('POST', '/me/photos/upload-url', member.authId, {
        contentType: 'image/jpeg',
        byteSize: 1000,
      });
      expect(created.statusCode).toBe(201);
      paths.push(created.json().path);
      harness.storage.put(created.json().path, Buffer.from('partial'));
    }
    const refused = await call('POST', '/me/photos/upload-url', member.authId, {
      contentType: 'image/jpeg',
      byteSize: 1000,
    });
    expect(refused.statusCode).toBe(409);

    // Twenty minutes later (the URL lives fifteen) they are abandoned.
    await harness.raw.query(
      `update public.photos set created_at = now() - interval '20 minutes' where user_id = $1::uuid`,
      [member.userId],
    );
    const freed = await call('POST', '/me/photos/upload-url', member.authId, {
      contentType: 'image/jpeg',
      byteSize: 1000,
    });
    expect(freed.statusCode, freed.body).toBe(201);
    const live = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.photos where user_id = $1::uuid and deleted_at is null`,
      [member.userId],
    );
    expect(live.rows[0]!.n).toBe('1');
    // Their bytes went with them.
    expect(paths.some((p) => harness.storage.objects.has(p))).toBe(false);
  });

  it('still counts finalized photos', async () => {
    const member = await seedMember('female');
    for (let i = 0; i < 6; i += 1) expect((await upload(member)).finalized).toBe(202);
    await harness.raw.query(
      `update public.photos set created_at = now() - interval '1 day' where user_id = $1::uuid`,
      [member.userId],
    );
    const refused = await call('POST', '/me/photos/upload-url', member.authId, {
      contentType: 'image/jpeg',
      byteSize: 1000,
    });
    expect(refused.statusCode).toBe(409);
  });
});

describe('B12 — the stored original loses its EXIF', () => {
  it('re-encodes the original at finalize', async () => {
    const member = await seedMember('female');
    const withExif = await jpeg(true);
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const { path, finalized } = await upload(member, withExif);
    expect(finalized).toBe(202);
    const stored = harness.storage.objects.get(path)!.body;
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('jpeg');
  });
});

describe('B13 — only an approved photo can be the main photo', () => {
  it('refuses a pending photo, and leaves the current primary in place', async () => {
    const member = await seedMember('female');
    const approved = await upload(member);
    await harness.raw.query(
      `update public.photos set moderation_status = 'approved' where id = $1::uuid`,
      [approved.photoId],
    );
    expect(
      (await call('PATCH', `/me/photos/${approved.photoId}`, member.authId, { isPrimary: true }))
        .statusCode,
    ).toBe(200);

    const pending = await upload(member);
    const refused = await call('PATCH', `/me/photos/${pending.photoId}`, member.authId, {
      isPrimary: true,
    });
    expect(refused.statusCode).toBe(409);
    // Validated BEFORE clearing: the old primary is still the primary.
    expect((await photoStatus(approved.photoId)).primary).toBe(true);
    expect((await photoStatus(pending.photoId)).primary).toBe(false);
  });
});

// =============================================================================
// B6
// =============================================================================

describe('B6 — profiles wait for review, edits are re-reviewed, DOB is locked', () => {
  it('sends an approved profile back to review when its text changes', async () => {
    const member = await seedMember('female');
    const edited = await call('PATCH', '/me/profile', member.authId, {
      aboutMe: 'A completely rewritten about-me that nobody has reviewed yet.',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const rows = await harness.raw.query<{ review_status: string }>(
      `select review_status from public.profiles where user_id = $1::uuid`,
      [member.userId],
    );
    expect(rows.rows[0]!.review_status).toBe('pending');
  });

  it('refuses a date-of-birth change once the profile is complete, with a way forward', async () => {
    const member = await seedMember('female');
    const refused = await call('PATCH', '/me/profile', member.authId, {
      dateOfBirth: '1990-01-01',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/Request a correction/);
  });

  it('runs the correction workflow: request, support decision, audit', async () => {
    const member = await seedMember('female');
    const support = await seedAdmin(['support']);

    const filed = await call('POST', '/me/dob-correction-requests', member.authId, {
      requestedDob: '1994-03-02',
      reason: 'I entered my birth year wrongly during sign-up.',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const { requestId } = filed.json() as { requestId: string };
    // Review Phase 4: every timestamp here is the contract's RFC 3339 shape.
    expect(timestampSchema.safeParse(filed.json().createdAt).success, filed.body).toBe(true);

    const duplicate = await call('POST', '/me/dob-correction-requests', member.authId, {
      requestedDob: '1994-03-02',
      reason: 'I entered my birth year wrongly during sign-up.',
    });
    expect(duplicate.statusCode).toBe(409);

    const queue = await staff('GET', '/admin/dob-corrections', support.authId);
    expect(
      (queue.json().items as { requestId: string; currentDob: string }[]).find(
        (i) => i.requestId === requestId,
      ),
    ).toMatchObject({
      currentDob: '1995-06-15',
      createdAt: expect.stringMatching(RFC3339_UTC),
    });

    const decided = await staff('POST', `/admin/dob-corrections/${requestId}`, support.authId, {
      decision: 'approve',
      note: 'Checked against CNIC.',
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const dob = await harness.raw.query<{ d: string }>(
      `select date_of_birth::text as d from public.users where id = $1::uuid`,
      [member.userId],
    );
    expect(dob.rows[0]!.d).toBe('1994-03-02');
    expect(await auditCount('dob.approve', member.userId)).toBe(1);
    const mine = (await call('GET', '/me/dob-correction-requests', member.authId)).json().items;
    expect(mine[0]).toMatchObject({
      status: 'approved',
      decisionNote: 'Checked against CNIC.',
      decidedAt: expect.stringMatching(RFC3339_UTC),
      createdAt: expect.stringMatching(RFC3339_UTC),
    });
  });

  it('refuses a correction request before the profile is complete, and an impossible date', async () => {
    const early = await seedMember('female', { completed: false });
    expect(
      (
        await call('POST', '/me/dob-correction-requests', early.authId, {
          requestedDob: '1994-03-02',
          reason: 'I entered my birth year wrongly during sign-up.',
        })
      ).statusCode,
    ).toBe(409);
    const member = await seedMember('female');
    expect(
      (
        await call('POST', '/me/dob-correction-requests', member.authId, {
          requestedDob: '1994-02-30',
          reason: 'I entered my birth year wrongly during sign-up.',
        })
      ).statusCode,
    ).toBe(400);
  });
});

// =============================================================================
// L1
// =============================================================================

describe('L1 — the admin surface: who may use it', () => {
  it('does not exist for a member who is not staff (404)', async () => {
    const member = await seedMember('female');
    expect((await staff('GET', '/admin/moderation/photos', member.authId)).statusCode).toBe(404);
  });

  it('requires a second factor (aal2) by default', async () => {
    const moderator = await seedAdmin(['moderator']);
    const withoutMfa = await call(
      'GET',
      '/admin/moderation/photos',
      moderator.authId,
      undefined,
      'aal1',
    );
    expect(withoutMfa.statusCode).toBe(403);
    expect((await staff('GET', '/admin/moderation/photos', moderator.authId)).statusCode).toBe(200);
  });

  it('checks the role: support cannot moderate photos; a moderator cannot decide DOB', async () => {
    const support = await seedAdmin(['support']);
    const moderator = await seedAdmin(['moderator']);
    expect((await staff('GET', '/admin/moderation/photos', support.authId)).statusCode).toBe(403);
    expect((await staff('GET', '/admin/dob-corrections', moderator.authId)).statusCode).toBe(403);
  });

  it('ignores an expired role and a disabled admin', async () => {
    const expired = await seedAdmin(['moderator']);
    await harness.raw.query(
      `update public.admin_role_assignments set expires_at = now() - interval '1 day'
        where admin_user_id = (select id from public.admin_users where user_id = $1::uuid)`,
      [expired.userId],
    );
    expect((await staff('GET', '/admin/moderation/photos', expired.authId)).statusCode).toBe(403);
    const disabled = await seedAdmin(['moderator']);
    await harness.raw.query(
      `update public.admin_users set status = 'disabled' where user_id = $1::uuid`,
      [disabled.userId],
    );
    expect((await staff('GET', '/admin/moderation/photos', disabled.authId)).statusCode).toBe(404);
  });
});

describe('L1 — moderation decisions, each audited', () => {
  it('approves a queued photo, which can then be the main photo', async () => {
    const moderator = await seedAdmin(['moderator']);
    const member = await seedMember('female');
    const { photoId } = await upload(member);

    const queue = await staff('GET', '/admin/moderation/photos', moderator.authId);
    const item = (queue.json().items as { photoId: string; url: string | null }[]).find(
      (i) => i.photoId === photoId,
    );
    expect(item?.url).toContain('signed');
    expect(item).toMatchObject({ createdAt: expect.stringMatching(RFC3339_UTC) });

    const decided = await staff('POST', `/admin/moderation/photos/${photoId}`, moderator.authId, {
      decision: 'approve',
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await photoStatus(photoId)).status).toBe('approved');
    expect(await auditCount('photo.approve', photoId)).toBe(1);
    expect(
      (await call('PATCH', `/me/photos/${photoId}`, member.authId, { isPrimary: true })).statusCode,
    ).toBe(200);
  });

  it('rejects a photo and takes it off the main slot', async () => {
    const moderator = await seedAdmin(['moderator']);
    const member = await seedMember('female');
    const { photoId } = await upload(member);
    await staff('POST', `/admin/moderation/photos/${photoId}`, moderator.authId, {
      decision: 'approve',
    });
    await call('PATCH', `/me/photos/${photoId}`, member.authId, { isPrimary: true });

    const rejected = await staff('POST', `/admin/moderation/photos/${photoId}`, moderator.authId, {
      decision: 'reject',
      reasonKey: 'errors.photoRejected',
      note: 'Not a photo of the member.',
    });
    expect(rejected.statusCode).toBe(200);
    expect(await photoStatus(photoId)).toEqual({ status: 'rejected', primary: false });
    expect(await auditCount('photo.reject', photoId)).toBe(1);
  });

  it('approves a pending profile, which then becomes viewable', async () => {
    const moderator = await seedAdmin(['moderator']);
    const viewer = await seedMember('male');
    const member = await seedMember('female', { reviewStatus: 'pending' });
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(404);

    const queue = await staff('GET', '/admin/moderation/profiles', moderator.authId);
    expect((queue.json().items as { userId: string }[]).map((i) => i.userId)).toContain(
      member.userId,
    );
    expect(
      (queue.json().items as { userId: string }[]).find((i) => i.userId === member.userId),
    ).toMatchObject({ submittedAt: expect.stringMatching(RFC3339_UTC) });
    const decided = await staff(
      'POST',
      `/admin/moderation/profiles/${member.userId}`,
      moderator.authId,
      {
        decision: 'approve',
      },
    );
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(200);
    expect(await auditCount('profile.approve', member.userId)).toBe(1);
  });

  it('resolves a report and tells the reporter', async () => {
    const moderator = await seedAdmin(['moderator']);
    const reporter = await seedMember('female');
    const reported = await seedMember('male');
    const filed = await call('POST', '/reports', reporter.authId, {
      reportedUserId: reported.userId,
      category: 'harassment',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const reportId = filed.json().id as string;

    const queue = await staff('GET', '/admin/reports', moderator.authId);
    expect((queue.json().items as { reportId: string }[]).map((i) => i.reportId)).toContain(
      reportId,
    );
    expect(
      (queue.json().items as { reportId: string }[]).find((i) => i.reportId === reportId),
    ).toMatchObject({ createdAt: expect.stringMatching(RFC3339_UTC) });
    const resolved = await staff('POST', `/admin/reports/${reportId}`, moderator.authId, {
      status: 'actioned',
      outcomeKey: 'report.actioned',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const notes = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.notifications where user_id = $1::uuid and type = 'report_update'`,
      [reporter.userId],
    );
    expect(notes.rows[0]!.n).toBe('1');
    expect(await auditCount('report.actioned', reportId)).toBe(1);
  });

  it('suspends a member (hidden everywhere), refuses a ban without a reason, and clears', async () => {
    const moderator = await seedAdmin(['moderator']);
    const viewer = await seedMember('male');
    const member = await seedMember('female');

    const noReason = await staff(
      'POST',
      `/admin/users/${member.userId}/actions`,
      moderator.authId,
      {
        action: 'ban',
        reason: '   ',
      },
    );
    expect(noReason.statusCode).toBe(400);

    const suspended = await staff(
      'POST',
      `/admin/users/${member.userId}/actions`,
      moderator.authId,
      {
        action: 'suspend',
        reason: 'Repeated harassment reports.',
      },
    );
    expect(suspended.statusCode, suspended.body).toBe(201);
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(404);

    const cleared = await staff('POST', `/admin/users/${member.userId}/actions`, moderator.authId, {
      action: 'clear',
      reason: 'Appeal upheld.',
    });
    expect(cleared.json()).toMatchObject({ status: 'active' });
    expect((await call('GET', `/profiles/${member.userId}`, viewer.authId)).statusCode).toBe(200);
    expect(await auditCount('user.suspend', member.userId)).toBe(1);
    expect(await auditCount('user.clear', member.userId)).toBe(1);
  });
});

// =============================================================================
// B26
// =============================================================================

describe('B26 — one message notification per conversation', () => {
  const rows = async (member: Member) =>
    (
      await harness.raw.query<{ payload: { count: number }; read_at: string | null }>(
        `select payload, read_at from public.notifications where user_id = $1::uuid and type = 'new_message'`,
        [member.userId],
      )
    ).rows;

  it('collapses messages into one row with a count, and revives it once read', async () => {
    const t = await thread();
    for (const body of ['one', 'two', 'three']) {
      await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, { body });
    }
    let mine = await rows(t.alice);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload.count).toBe(3);

    await harness.raw.query(
      `update public.notifications set read_at = now() where user_id = $1::uuid`,
      [t.alice.userId],
    );
    await call('POST', `/conversations/${t.conversationId}/messages`, t.bilal.authId, {
      body: 'four',
    });
    mine = await rows(t.alice);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.read_at).toBeNull();
    expect(mine[0]!.payload.count).toBe(1);
  });
});

// =============================================================================
// L4
// =============================================================================

describe('L4 — GET /profiles/{userId}', () => {
  it('returns the permitted fields, never the date of birth', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    const response = await call('GET', `/profiles/${target.userId}`, viewer.authId);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      userId: target.userId,
      age: expect.any(Number),
      gender: 'female',
      aboutMe: 'A sufficiently long about-me for this member.',
      viewerRelationship: 'stranger',
    });
    expect(JSON.stringify(body)).not.toMatch(/1995-06-15|dateOfBirth|date_of_birth/);
  });

  it('omits a matched_only field for a stranger and shows it within a match', async () => {
    const t = await thread();
    const stranger = await seedMember('male');
    await harness.raw.query(
      `insert into public.profile_field_visibility (user_id, field_key, visibility)
       values ($1::uuid, 'about_me', 'matched_only')`,
      [t.alice.userId],
    );
    const asStranger = (await call('GET', `/profiles/${t.alice.userId}`, stranger.authId)).json();
    expect(asStranger).not.toHaveProperty('aboutMe');
    expect(asStranger.hiddenFieldCount).toBeGreaterThan(0);

    const asMatch = (await call('GET', `/profiles/${t.alice.userId}`, t.bilal.authId)).json();
    expect(asMatch.aboutMe).toBe('A sufficiently long about-me for this member.');
    expect(asMatch.viewerRelationship).toBe('match');
  });

  it('answers 404 when the profile cannot be seen: blocked, pending review, or oneself', async () => {
    const viewer = await seedMember('male');
    const blocker = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [blocker.userId, viewer.userId],
    );
    expect((await call('GET', `/profiles/${blocker.userId}`, viewer.authId)).statusCode).toBe(404);
    const pending = await seedMember('female', { reviewStatus: 'pending' });
    expect((await call('GET', `/profiles/${pending.userId}`, viewer.authId)).statusCode).toBe(404);
    expect((await call('GET', `/profiles/${viewer.userId}`, viewer.authId)).statusCode).toBe(404);
  });
});
