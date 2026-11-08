import { NikahMateClient } from '@nikahmate/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * End-to-end workflows for the three findings the code review said unit tests had
 * missed because they cross several steps (B1, B2, B4). Each one is driven through the
 * real client the app uses, against the real routes and migrations, as several people
 * taking turns, and checks what each person can see and do at every step.
 *
 * Not a device test: there is no UI here. The screens are covered by the browser
 * walkthrough and by real-device testing, which is still outstanding (L12).
 */

interface Person {
  userId: string;
  authId: string;
  name: string;
  app: NikahMateClient;
}

let harness: TestHarness;
let seq = 0;

const inject: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const res = await harness.app.inject({
    method: (init?.method ?? 'GET') as 'GET',
    url: url.pathname + url.search,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
  });
  return new Response(res.statusCode === 204 || res.body === '' ? null : res.body, {
    status: res.statusCode,
    headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
  });
};

function clientFor(authId: string): NikahMateClient {
  const store = new Map<string, string>();
  const client = new NikahMateClient({
    supabaseUrl: 'http://localhost:54321',
    publishableKey: 'test',
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    apiBaseUrl: 'http://api.test',
    fetchImpl: inject,
  });
  const token = authHeader(authId).authorization!.replace('Bearer ', '');
  client.auth.getAccessToken = async () => token;
  return client;
}

async function person(gender: 'male' | 'female'): Promise<Person> {
  seq += 1;
  const authId = randomAuthId();
  const name = `Workflow ${seq}`;
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users
       (display_name, gender, date_of_birth, country_code, status, profile_completed_at)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active', now()) returning id`,
    [name, gender],
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
  return { userId, authId, name, app: clientFor(authId) };
}

/** The owner invites a relative as a reviewer, and the relative accepts from the link. */
async function addReviewer(owner: Person, relative: Person): Promise<void> {
  const invitation = await owner.app.createFamilyInvitation({
    inviteeContact: `relative${seq}@example.com`,
    relationshipCode: 'father',
    tier: 'reviewer',
  });
  await relative.app.respondToFamilyInvitation(invitation.id, invitation.token, true);
}

/** Family review on: the owner's own setting, as the Family screen sets it. */
const requireFamilyReview = (who: Person) =>
  who.app.updateSettings({ communicationPolicy: 'family_reviewed' });

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('B2: a family invitation, from the link to a decision that opens the chat', () => {
  it('runs end to end, and every person sees the right thing at each step', async () => {
    const owner = await person('female');
    const father = await person('male');
    const suitor = await person('male');

    // 1. The owner invites. The link the app shares carries exactly these two values.
    const invitation = await owner.app.createFamilyInvitation({
      inviteeContact: 'father@example.com',
      relationshipCode: 'father',
      tier: 'reviewer',
    });
    expect(invitation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(invitation.token.length).toBeGreaterThan(20);
    expect((await owner.app.listFamilyInvitations()).items.map((i) => i.id)).toContain(
      invitation.id,
    );

    // 2. A wrong token of a plausible length is refused, saying nothing about why; the
    // right one joins the family.
    await expect(
      father.app.respondToFamilyInvitation(invitation.id, 'definitely-not-the-right-token', true),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await father.app.respondToFamilyInvitation(invitation.id, invitation.token, true);
    expect((await owner.app.listFamilyMembers()).items.map((m) => m.userId)).toEqual([
      father.userId,
    ]);
    expect((await father.app.listManagedProfiles()).items.map((m) => m.userId)).toEqual([
      owner.userId,
    ]);

    // 3. Family review on, then a match: the chat stays closed and the reviewer is asked.
    await requireFamilyReview(owner);
    const interest = await suitor.app.sendInterest(owner.userId);
    const answer = await owner.app.respondToInterest(interest.id, 'accept');
    expect(answer.match?.communicationState).toBe('pending_family_review');
    expect((await owner.app.listConversations()).items).toEqual([]);
    expect((await suitor.app.listConversations()).items).toEqual([]);
    const waiting = await father.app.listFamilyReviews();
    expect(waiting.items.map((r) => r.matchId)).toEqual([answer.match!.id]);

    // 4. The reviewer reads the packet and approves: the chat opens for both.
    const packet = await father.app.getReviewPacket(answer.match!.id);
    expect(packet.ownerDisplayName).toBe(owner.name);
    await father.app.decideReview(answer.match!.id, { action: 'approve' });
    for (const side of [owner, suitor]) {
      const threads = await side.app.listConversations();
      expect(threads.items).toHaveLength(1);
      expect(threads.items[0]!.canWrite).toBe(true);
    }
    expect((await father.app.listFamilyReviews()).items).toEqual([]);

    // 5. The owner can see exactly what their family looked at, and under which right.
    const log = await owner.app.listFamilyAccessLog();
    expect(log.items.map((e) => e.action).sort()).toEqual(['review.approved', 'review.open']);
    expect(new Set(log.items.map((e) => e.permission))).toEqual(new Set(['approve_communication']));
  });

  it('a used invitation cannot be accepted again, by anyone', async () => {
    const owner = await person('female');
    const first = await person('male');
    const second = await person('male');
    const invitation = await owner.app.createFamilyInvitation({
      inviteeContact: 'once@example.com',
      relationshipCode: 'brother',
      tier: 'observer',
    });
    await first.app.respondToFamilyInvitation(invitation.id, invitation.token, true);
    await expect(
      second.app.respondToFamilyInvitation(invitation.id, invitation.token, true),
    ).rejects.toBeTruthy();
    expect((await owner.app.listFamilyMembers()).items.map((m) => m.userId)).toEqual([
      first.userId,
    ]);
  });
});

describe('B1: when both families review, one family cannot override the other', () => {
  async function bothReviewed() {
    const owner = await person('female');
    const suitor = await person('male');
    const ownersFather = await person('male');
    const suitorsFather = await person('male');
    await addReviewer(owner, ownersFather);
    await addReviewer(suitor, suitorsFather);
    await requireFamilyReview(owner);
    await requireFamilyReview(suitor);
    const interest = await suitor.app.sendInterest(owner.userId);
    const answer = await owner.app.respondToInterest(interest.id, 'accept');
    expect(answer.match?.communicationState).toBe('pending_family_review');
    return { owner, suitor, ownersFather, suitorsFather, matchId: answer.match!.id };
  }

  it('a rejection, then the other family approving, leaves the chat closed', async () => {
    const { owner, suitor, ownersFather, suitorsFather, matchId } = await bothReviewed();

    await suitorsFather.app.decideReview(matchId, { action: 'reject' });

    // The other household's review is moot now: it is no longer offered, and deciding
    // it anyway is refused rather than flipping the match open.
    expect((await ownersFather.app.listFamilyReviews()).items).toEqual([]);
    await expect(
      ownersFather.app.decideReview(matchId, { action: 'approve' }),
    ).rejects.toMatchObject({ kind: 'conflict' });

    for (const side of [owner, suitor]) {
      expect((await side.app.listConversations()).items).toEqual([]);
    }
    const state = await harness.raw.query<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(state.rows[0]!.communication_state).toBe('family_rejected');
  });

  it('one approval is not enough: the chat opens only when both families approve', async () => {
    const { owner, suitor, ownersFather, suitorsFather, matchId } = await bothReviewed();

    await ownersFather.app.decideReview(matchId, { action: 'approve' });
    expect((await owner.app.listConversations()).items).toEqual([]);

    await suitorsFather.app.decideReview(matchId, { action: 'approve' });
    for (const side of [owner, suitor]) {
      expect((await side.app.listConversations()).items).toHaveLength(1);
    }
  });

  it('the database refuses the override even if a route forgot to check', async () => {
    const { suitorsFather, matchId } = await bothReviewed();
    await suitorsFather.app.decideReview(matchId, { action: 'reject' });
    await expect(
      harness.raw.query(
        `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
        [matchId],
      ),
    ).rejects.toThrow();
  });
});

describe('B4: "Maybe later" defers a decision instead of ending the interest', () => {
  it('the recipient can still accept, and the chat opens', async () => {
    const recipient = await person('female');
    const sender = await person('male');
    const interest = await sender.app.sendInterest(recipient.userId);

    const deferred = await recipient.app.respondToInterest(interest.id, 'maybe_later');
    expect(deferred.interest.status).toBe('maybe_later');
    expect(deferred.match).toBeNull();
    // Both sides still see it, as deferred, not as finished.
    expect((await recipient.app.listInterests('received')).items[0]!.status).toBe('maybe_later');
    expect((await sender.app.listInterests('sent')).items[0]!.status).toBe('maybe_later');

    const accepted = await recipient.app.respondToInterest(interest.id, 'accept');
    expect(accepted.interest.status).toBe('accepted');
    expect(accepted.match).not.toBeNull();
    expect((await sender.app.listConversations()).items).toHaveLength(1);
  });

  it('the recipient can still decline it', async () => {
    const recipient = await person('female');
    const sender = await person('male');
    const interest = await sender.app.sendInterest(recipient.userId);
    await recipient.app.respondToInterest(interest.id, 'maybe_later');
    const declined = await recipient.app.respondToInterest(interest.id, 'decline');
    expect(declined.interest.status).toBe('declined');
  });

  it('the sender can withdraw a deferred interest', async () => {
    const recipient = await person('female');
    const sender = await person('male');
    const interest = await sender.app.sendInterest(recipient.userId);
    await recipient.app.respondToInterest(interest.id, 'maybe_later');
    await sender.app.withdrawInterest(interest.id);
    expect((await sender.app.listInterests('sent')).items[0]!.status).toBe('withdrawn');
    await expect(recipient.app.respondToInterest(interest.id, 'accept')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('deferring twice is refused, so it never becomes a loop', async () => {
    const recipient = await person('female');
    const sender = await person('male');
    const interest = await sender.app.sendInterest(recipient.userId);
    await recipient.app.respondToInterest(interest.id, 'maybe_later');
    await expect(recipient.app.respondToInterest(interest.id, 'maybe_later')).rejects.toMatchObject(
      { kind: 'conflict' },
    );
  });
});
