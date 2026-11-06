import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminAuditPageSchema,
  adminSessionSchema,
  photoRequestPageSchema,
  photoRequestSchema,
  profilePhotosSchema,
} from '@nikahmate/domain';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Code review remediation, Phase 5 — the API half, through the real routes.
 *
 *   L3  another member's photos: which object each viewer may read, signed
 *       with the viewer's own token; photo requests and grants (0031)
 *   L1  rejections need a reason; the staff session; the audit trail
 *
 * STORAGE IS NOT TRUSTED TO THE ROUTE. The in-memory Storage below enforces
 * the same policies the hosted bucket has: 0007's owner rule OR 0031's
 * `app.can_read_photo_object`, evaluated as the token's own member. So a test
 * that gets a URL proves the policy allowed it, and the policy tests at the
 * bottom prove what it refuses. Real Supabase Storage is still unverified.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active', now()) returning id`,
    [`Phase5 ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status, submitted_at)
     values ($1::uuid, 'A sufficiently long about-me for this member.', 'ms_never_married',
             'rel_practising', 'approved', now())`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name) values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

async function seedAdmin(roles: string[]): Promise<Member> {
  const member = await seedMember('female');
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
  return member;
}

/** A finalized photo with its stored objects, at the given visibility and status. */
async function seedPhoto(
  owner: Member,
  visibility: 'public' | 'blurred' | 'on_request' | 'private',
  status: 'approved' | 'pending' | 'rejected' = 'approved',
  position = 0,
): Promise<{ id: string; full: string; thumb: string; blurred: string }> {
  const folder = randomAuthId();
  const full = `${owner.userId}/${folder}/original.jpg`;
  const thumb = `${owner.userId}/${folder}/thumb.jpg`;
  const blurred = `${owner.userId}/${folder}/blurred.jpg`;
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.photos (user_id, storage_path, content_type, visibility, moderation_status, position)
     values ($1::uuid, $2, 'image/jpeg', $3, $4, $5) returning id`,
    [owner.userId, full, visibility, status, position],
  );
  const id = rows.rows[0]!.id;
  for (const [variant, path] of [
    ['thumb', thumb],
    ['blurred', blurred],
  ] as const) {
    await harness.raw.query(
      `insert into public.photo_variants (photo_id, variant, storage_path) values ($1::uuid, $2, $3)`,
      [id, variant, path],
    );
  }
  for (const path of [full, thumb, blurred]) harness.storage.put(path, Buffer.from('jpeg'));
  return { id, full, thumb, blurred };
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

/** Would the bucket let this member read this object? (0007 owner OR 0031 viewer.) */
async function bucketAllows(authId: string, path: string): Promise<boolean> {
  const rows = await harness.db.asUser(authId, (session) =>
    session.query<{ ok: boolean }>(
      `select (split_part($1, '/', 1) = app.current_user_id()::text)
              or app.can_read_photo_object($1) as ok`,
      [path],
    ),
  );
  return rows[0]?.ok === true;
}

beforeAll(async () => {
  harness = await createHarness();
  // Storage that applies the bucket's policies, as the token's member.
  const signed = harness.storage.createSignedUrl.bind(harness.storage);
  harness.storage.createSignedUrl = async (token, path) => {
    const authId = /^test:([0-9a-fA-F-]{36})/.exec(token)?.[1];
    if (!authId || !(await bucketAllows(authId, path))) {
      throw new Error(`storage policy refused ${path}`);
    }
    return signed(token, path);
  };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('L3 GET /profiles/{userId}/photos', () => {
  it('returns exactly the variant each visibility allows, and nothing private or unapproved', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    const pub = await seedPhoto(owner, 'public', 'approved', 0);
    const blur = await seedPhoto(owner, 'blurred', 'approved', 1);
    const onReq = await seedPhoto(owner, 'on_request', 'approved', 2);
    await seedPhoto(owner, 'private', 'approved', 3);
    await seedPhoto(owner, 'public', 'pending', 4);
    await seedPhoto(owner, 'public', 'rejected', 5);

    const res = await call('GET', `/profiles/${owner.userId}/photos`, viewer.authId);
    expect(res.statusCode, res.body).toBe(200);
    const body = profilePhotosSchema.parse(res.json());
    expect(body.items.map((i) => i.id)).toEqual([pub.id, blur.id, onReq.id]);
    expect(body.items[0]).toMatchObject({ variant: 'full', requiresRequest: false });
    expect(body.items[0]!.url).toContain(pub.full);
    expect(body.items[1]).toMatchObject({ variant: 'blurred', requiresRequest: true });
    expect(body.items[1]!.url).toContain(blur.blurred);
    expect(body.items[2]).toMatchObject({ url: null, expiresAt: null, requiresRequest: true });
    expect(body).toMatchObject({ request: null, granted: false });
  });

  it('is 404 for oneself, for an unknown member and for a blocked member', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    await seedPhoto(owner, 'public');
    expect((await call('GET', `/profiles/${owner.userId}/photos`, owner.authId)).statusCode).toBe(
      404,
    );
    expect(
      (await call('GET', `/profiles/${randomAuthId()}/photos`, viewer.authId)).statusCode,
    ).toBe(404);
    expect((await call('GET', `/profiles/not-a-uuid/photos`, viewer.authId)).statusCode).toBe(400);
    await call('PUT', `/blocks/${viewer.userId}`, owner.authId, {});
    expect((await call('GET', `/profiles/${owner.userId}/photos`, viewer.authId)).statusCode).toBe(
      404,
    );
  });

  it('the Storage rule refuses the original of a blurred or on-request photo, and every private object', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    const pub = await seedPhoto(owner, 'public');
    const blur = await seedPhoto(owner, 'blurred');
    const onReq = await seedPhoto(owner, 'on_request');
    const priv = await seedPhoto(owner, 'private');
    const pending = await seedPhoto(owner, 'public', 'pending');

    expect(await bucketAllows(viewer.authId, pub.full)).toBe(true);
    expect(await bucketAllows(viewer.authId, pub.thumb)).toBe(true);
    expect(await bucketAllows(viewer.authId, blur.blurred)).toBe(true);
    expect(await bucketAllows(viewer.authId, blur.full)).toBe(false);
    expect(await bucketAllows(viewer.authId, blur.thumb)).toBe(false);
    for (const path of [
      onReq.full,
      onReq.thumb,
      onReq.blurred,
      priv.full,
      priv.blurred,
      pending.full,
    ]) {
      expect(await bucketAllows(viewer.authId, path), path).toBe(false);
    }
    // A crafted name matches no stored path.
    expect(await bucketAllows(viewer.authId, `${owner.userId}/../${pub.full}`)).toBe(false);
    // The owner keeps every own object (0007).
    expect(await bucketAllows(owner.authId, priv.full)).toBe(true);
  });
});

describe('L3 photo requests', () => {
  it('runs request → approve → full photos, and never reveals a private photo', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    const blur = await seedPhoto(owner, 'blurred', 'approved', 0);
    const onReq = await seedPhoto(owner, 'on_request', 'approved', 1);
    const priv = await seedPhoto(owner, 'private', 'approved', 2);

    const created = await call('POST', `/profiles/${owner.userId}/photo-request`, viewer.authId, {
      message: 'Assalamu alaikum, may I see your photos?',
    });
    expect(created.statusCode, created.body).toBe(201);
    const request = photoRequestSchema.parse(created.json());
    expect(request).toMatchObject({ direction: 'outgoing', status: 'pending' });
    expect(request.counterpart.userId).toBe(owner.userId);

    const notified = await harness.raw.query<{ n: number }>(
      `select count(*)::int as n from public.notifications where user_id = $1::uuid and type = 'photo_request'`,
      [owner.userId],
    );
    expect(notified.rows[0]!.n).toBe(1);

    // One open request at a time.
    expect(
      (await call('POST', `/profiles/${owner.userId}/photo-request`, viewer.authId, {})).statusCode,
    ).toBe(409);

    const photos = profilePhotosSchema.parse(
      (await call('GET', `/profiles/${owner.userId}/photos`, viewer.authId)).json(),
    );
    expect(photos.request).toMatchObject({ id: request.id, status: 'pending' });

    const incoming = photoRequestPageSchema.parse(
      (await call('GET', '/me/photo-requests?direction=incoming', owner.authId)).json(),
    );
    expect(incoming.items.map((i) => i.id)).toContain(request.id);
    expect(incoming.items.find((i) => i.id === request.id)).toMatchObject({
      direction: 'incoming',
      message: 'Assalamu alaikum, may I see your photos?',
    });

    // Only the owner answers.
    const stranger = await seedMember('male');
    for (const who of [viewer, stranger]) {
      const res = await call('POST', `/me/photo-requests/${request.id}/respond`, who.authId, {
        decision: 'approve',
      });
      expect(res.statusCode).toBe(404);
    }

    const approved = await call('POST', `/me/photo-requests/${request.id}/respond`, owner.authId, {
      decision: 'approve',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', direction: 'incoming' });
    expect(
      (
        await call('POST', `/me/photo-requests/${request.id}/respond`, owner.authId, {
          decision: 'decline',
        })
      ).statusCode,
    ).toBe(409);

    const after = profilePhotosSchema.parse(
      (await call('GET', `/profiles/${owner.userId}/photos`, viewer.authId)).json(),
    );
    expect(after.granted).toBe(true);
    expect(after.items.map((i) => [i.id, i.variant, i.requiresRequest])).toEqual([
      [blur.id, 'full', false],
      [onReq.id, 'full', false],
    ]);
    expect(await bucketAllows(viewer.authId, priv.full)).toBe(false);
    expect(await bucketAllows(stranger.authId, onReq.full)).toBe(false);

    // Setting a photo private withdraws it, grant or no grant.
    await harness.raw.query(`update public.photos set visibility = 'private' where id = $1::uuid`, [
      onReq.id,
    ]);
    expect(await bucketAllows(viewer.authId, onReq.full)).toBe(false);

    // A block ends it too.
    await call('PUT', `/blocks/${viewer.userId}`, owner.authId, {});
    expect(await bucketAllows(viewer.authId, blur.full)).toBe(false);

    const answered = await harness.raw.query<{ n: number }>(
      `select count(*)::int as n from public.notifications
        where user_id = $1::uuid and type = 'photo_request_answered'`,
      [viewer.userId],
    );
    expect(answered.rows[0]!.n).toBe(1);
  });

  it('a decline leaves the photos hidden and blocks a new request for the cooldown', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    const onReq = await seedPhoto(owner, 'on_request');
    const created = await call(
      'POST',
      `/profiles/${owner.userId}/photo-request`,
      viewer.authId,
      {},
    );
    expect(created.statusCode, created.body).toBe(201);
    const declined = await call(
      'POST',
      `/me/photo-requests/${created.json().id}/respond`,
      owner.authId,
      {
        decision: 'decline',
      },
    );
    expect(declined.json()).toMatchObject({ status: 'declined' });
    expect(await bucketAllows(viewer.authId, onReq.full)).toBe(false);
    const again = await call('POST', `/profiles/${owner.userId}/photo-request`, viewer.authId, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/declined recently/);
    const outgoing = photoRequestPageSchema.parse(
      (
        await call('GET', '/me/photo-requests?direction=outgoing&status=declined', viewer.authId)
      ).json(),
    );
    expect(outgoing.items.map((i) => i.status)).toEqual(['declined']);
  });

  it('refuses contact details, a profile with nothing to request, oneself and a hidden profile', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    const withPublicOnly = await seedMember('female');
    await seedPhoto(withPublicOnly, 'public');
    await seedPhoto(owner, 'on_request');

    const contact = await call('POST', `/profiles/${owner.userId}/photo-request`, viewer.authId, {
      message: 'WhatsApp me on 0300 1234567',
    });
    expect(contact.statusCode).toBe(400);
    expect(contact.json().fields).toEqual({ message: 'contact_details_not_allowed' });

    const nothing = await call(
      'POST',
      `/profiles/${withPublicOnly.userId}/photo-request`,
      viewer.authId,
      {},
    );
    expect(nothing.statusCode).toBe(409);
    expect(
      (await call('POST', `/profiles/${owner.userId}/photo-request`, owner.authId, {})).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/profiles/${randomAuthId()}/photo-request`, viewer.authId, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call('POST', `/profiles/${owner.userId}/photo-request`, viewer.authId, {
          message: 'x'.repeat(301),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('validates the list filters and the decision', async () => {
    const member = await seedMember('male');
    expect(
      (await call('GET', '/me/photo-requests?direction=sideways', member.authId)).statusCode,
    ).toBe(400);
    expect((await call('GET', '/me/photo-requests?status=maybe', member.authId)).statusCode).toBe(
      400,
    );
    expect((await call('GET', '/me/photo-requests?cursor=garbage', member.authId)).statusCode).toBe(
      400,
    );
    expect(
      (
        await call('POST', `/me/photo-requests/${randomAuthId()}/respond`, member.authId, {
          decision: 'yes',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await harness.app.inject({ method: 'GET', url: '/me/photo-requests' })).statusCode,
    ).toBe(401);
  });
});

describe('L1 rejections carry the reason the member will see', () => {
  it('refuses a photo or profile rejection without reasonKey, and a DOB rejection without a note', async () => {
    const moderator = await seedAdmin(['moderator']);
    const support = await seedAdmin(['support']);
    const member = await seedMember('female');
    const photo = await seedPhoto(member, 'public', 'pending');

    const noReason = await staff('POST', `/admin/moderation/photos/${photo.id}`, moderator.authId, {
      decision: 'reject',
      note: 'Not a person.',
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().fields).toHaveProperty('reasonKey');

    const profileNoReason = await staff(
      'POST',
      `/admin/moderation/profiles/${member.userId}`,
      moderator.authId,
      {
        decision: 'reject',
      },
    );
    expect(profileNoReason.statusCode).toBe(400);

    const filed = await call('POST', '/me/dob-correction-requests', member.authId, {
      requestedDob: '1994-03-02',
      reason: 'I entered my birth year wrongly during sign-up.',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const requestId = filed.json().requestId as string;
    const dobNoNote = await staff('POST', `/admin/dob-corrections/${requestId}`, support.authId, {
      decision: 'reject',
    });
    expect(dobNoNote.statusCode).toBe(400);
    expect(dobNoNote.json().fields).toHaveProperty('note');

    const rejected = await staff('POST', `/admin/dob-corrections/${requestId}`, support.authId, {
      decision: 'reject',
      note: 'The document did not match the requested date.',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    // The member sees the reason on their own request.
    const mine = (await call('GET', '/me/dob-correction-requests', member.authId)).json().items;
    expect(mine[0]).toMatchObject({
      status: 'rejected',
      decisionNote: 'The document did not match the requested date.',
    });
  });
});

describe('L1 GET /admin/session', () => {
  it('names the roles of an authorised staff member, and nothing to anyone else', async () => {
    const moderator = await seedAdmin(['moderator']);
    const member = await seedMember('male');
    const res = await staff('GET', '/admin/session', moderator.authId);
    expect(res.statusCode, res.body).toBe(200);
    expect(adminSessionSchema.parse(res.json())).toMatchObject({
      roles: ['moderator'],
      mfaRequired: true,
    });
    // Without a second factor: 403, so the screen can ask for one.
    expect(
      (await call('GET', '/admin/session', moderator.authId, undefined, 'aal1')).statusCode,
    ).toBe(403);
    // Not staff: the surface does not exist.
    expect((await staff('GET', '/admin/session', member.authId)).statusCode).toBe(404);
    expect((await harness.app.inject({ method: 'GET', url: '/admin/session' })).statusCode).toBe(
      401,
    );
  });
});

describe('L1 GET /admin/audit', () => {
  it('lists decisions newest first with actor and reason, filters by target, and pages', async () => {
    const moderator = await seedAdmin(['moderator']);
    const member = await seedMember('male');
    for (const action of ['warn', 'suspend', 'clear'] as const) {
      const res = await staff('POST', `/admin/users/${member.userId}/actions`, moderator.authId, {
        action,
        reason: `Reason for ${action}`,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const first = await staff(
      'GET',
      `/admin/audit?targetId=${member.userId}&limit=2`,
      moderator.authId,
    );
    expect(first.statusCode, first.body).toBe(200);
    const page = adminAuditPageSchema.parse(first.json());
    expect(page.items.map((i) => i.action)).toEqual(['user.clear', 'user.suspend']);
    expect(page.items[0]).toMatchObject({
      targetType: 'user',
      targetId: member.userId,
      reason: 'Reason for clear',
    });
    expect(page.items[0]!.actor.displayName).toMatch(/^Phase5/);
    expect(page.hasMore).toBe(true);

    const second = adminAuditPageSchema.parse(
      (
        await staff(
          'GET',
          `/admin/audit?targetId=${member.userId}&limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`,
          moderator.authId,
        )
      ).json(),
    );
    expect(second.items.map((i) => i.action)).toEqual(['user.warn']);
    expect(second.hasMore).toBe(false);
  });

  it('refuses bad filters, members and a missing second factor', async () => {
    const support = await seedAdmin(['support']);
    const member = await seedMember('female');
    expect((await staff('GET', '/admin/audit?targetId=nope', support.authId)).statusCode).toBe(400);
    expect(
      (await staff('GET', '/admin/audit?targetType=DROP%20TABLE', support.authId)).statusCode,
    ).toBe(400);
    expect((await staff('GET', '/admin/audit?cursor=garbage', support.authId)).statusCode).toBe(
      400,
    );
    expect((await staff('GET', '/admin/audit', support.authId)).statusCode).toBe(200);
    expect((await staff('GET', '/admin/audit', member.authId)).statusCode).toBe(404);
    expect((await call('GET', '/admin/audit', support.authId, undefined, 'aal1')).statusCode).toBe(
      403,
    );
  });
});
