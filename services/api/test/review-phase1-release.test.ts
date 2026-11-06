import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Code review Phase 1 — the release ORDER, tested at each step.
 *
 *   1. apply 0026      (the old API is still serving)
 *   2. deploy the API
 *   3. apply 0027      (members lose INSERT on messages.kind)
 *
 * The revoke in 0027 was first written into 0026. That would have broken
 * every message send between applying the migration and deploying the API,
 * because the API released before Phase 1 names `kind` in its member insert.
 * These tests pin the split: at every step, whatever is serving can send.
 *
 * "The old API" is represented by its exact message insert from commit
 * 6c67581, run as the member exactly as that API ran it (`asUser`). It is the
 * only statement of the old API that 0026/0027 changes the answer for.
 */

/** The member insert of the API released before Phase 1, verbatim. */
const OLD_API_MESSAGE_INSERT = `insert into public.messages (conversation_id, sender_user_id, body, kind)
           values ($1::uuid, app.current_user_id(), $2, 'text')
           returning id, sender_user_id, body, kind, created_at`;

const THROUGH_0026 = '20261101000026';

let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: string,
  payload?: Record<string, unknown>,
) =>
  h.app.inject({
    method,
    url,
    headers: authHeader(auth),
    ...(payload ? { payload } : {}),
  });

/** A matched pair with an open conversation, made through the routes. */
async function thread(h: TestHarness): Promise<{ alice: Member; conversationId: string }> {
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
  const matchId = (accepted.json() as { match: { id: string } }).match.id;
  const rows = await h.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [matchId],
  );
  return { alice, conversationId: rows.rows[0]!.id };
}

const oldApiSend = (h: TestHarness, member: Member, conversationId: string, body: string) =>
  h.db.asUser(member.authId, (session) =>
    session.query<{ kind: string }>(OLD_API_MESSAGE_INSERT, [conversationId, body]),
  );

// =============================================================================
// Step 1 -> 2: 0026 applied, 0027 not yet
// =============================================================================

describe('after 0026, before 0027', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness({}, { through: THROUGH_0026 });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it('is really the intermediate state: 0027 has not been applied', async () => {
    const rows = await h.raw.query<{ can: boolean }>(
      `select has_column_privilege('authenticated', 'public.messages', 'kind', 'INSERT') as can`,
    );
    expect(rows.rows[0]!.can).toBe(true);
  });

  describe('the OLD API, still serving while 0026 is applied', () => {
    it('can still send a message — applying 0026 first breaks nothing', async () => {
      const { alice, conversationId } = await thread(h);
      const rows = await oldApiSend(h, alice, conversationId, 'Salaam, from the old API.');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('text');
    });

    it('still cannot post a system notice: the 0026 policy refuses it (temporary exposure is bounded)', async () => {
      // The window's only difference from the end state: a member may NAME
      // `kind`. The policy accepts only 'text', which is the default anyway.
      const { alice, conversationId } = await thread(h);
      await expect(
        h.db.asUser(alice.authId, (session) =>
          session.query(
            `insert into public.messages (conversation_id, sender_user_id, body, kind)
             values ($1::uuid, app.current_user_id(), 'Your account is suspended.', 'system')`,
            [conversationId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('the NEW API, deployed on top of 0026', () => {
    it('sends a message, stored as text', async () => {
      const { alice, conversationId } = await thread(h);
      const sent = await inject(
        h,
        'POST',
        `/conversations/${conversationId}/messages`,
        alice.authId,
        {
          body: 'Salaam, from the new API.',
        },
      );
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.json()).toMatchObject({ kind: 'text' });
    });

    it('serves /me, which needs app.has_entitlement_flag from 0026', async () => {
      const member = await seedMember(h, 'female');
      const me = await inject(h, 'GET', '/me', member.authId);
      expect(me.statusCode, me.body).toBe(200);
    });

    it('refuses free incognito with 403, and allows it once entitled', async () => {
      const member = await seedMember(h, 'male');
      const refused = await inject(h, 'PATCH', '/me', member.authId, { incognito: true });
      expect(refused.statusCode, refused.body).toBe(403);
      await h.raw.query(
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'incognito', 'true'::jsonb)`,
        [member.userId],
      );
      const allowed = await inject(h, 'PATCH', '/me', member.authId, { incognito: true });
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it('serves the feed and the shortlist, which need app.discoverable_to from 0026', async () => {
      const viewer = await seedMember(h, 'female');
      await seedMember(h, 'male');
      const feed = await inject(h, 'GET', '/discovery/sections/recommended', viewer.authId);
      expect(feed.statusCode, feed.body).toBe(200);
      const shortlist = await inject(h, 'GET', '/discovery/shortlist', viewer.authId);
      expect(shortlist.statusCode, shortlist.body).toBe(200);
    });

    it('withdraws a deferred interest, which needs the 0026 constraint', async () => {
      const sender = await seedMember(h, 'male');
      const recipient = await seedMember(h, 'female');
      const sent = await inject(h, 'POST', '/interests', sender.authId, {
        recipientUserId: recipient.userId,
      });
      const interestId = (sent.json() as { id: string }).id;
      const deferred = await inject(
        h,
        'POST',
        `/interests/${interestId}/respond`,
        recipient.authId,
        {
          decision: 'maybe_later',
        },
      );
      expect(deferred.statusCode, deferred.body).toBe(200);
      const withdrawn = await inject(h, 'DELETE', `/interests/${interestId}`, sender.authId);
      expect(withdrawn.statusCode, withdrawn.body).toBe(204);
    });
  });
});

// =============================================================================
// Step 3: 0027 applied (the end state)
// =============================================================================

describe('after 0027', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it('the new API still sends messages', async () => {
    const { alice, conversationId } = await thread(h);
    const sent = await inject(
      h,
      'POST',
      `/conversations/${conversationId}/messages`,
      alice.authId,
      {
        body: 'Salaam, after 0027.',
      },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ kind: 'text' });
  });

  it('the OLD API could not — which is why 0027 waits for the deploy', async () => {
    const { alice, conversationId } = await thread(h);
    await expect(oldApiSend(h, alice, conversationId, 'Salaam, old API.')).rejects.toThrow(
      /permission denied/i,
    );
  });
});
