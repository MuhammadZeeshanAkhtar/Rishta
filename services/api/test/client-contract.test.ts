import { NikahMateClient } from '@nikahmate/api-client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  createHarness,
  randomAuthId,
  seedReferenceData,
  type TestHarness,
} from './helpers';

/**
 * The real client against the real routes, with nothing between them.
 *
 * The API's tests read raw JSON and the client's tests use stubbed responses, so neither
 * notices when a route returns something the client's own schema rejects. That is how
 * GET /family/managed answered `createdAt: null` to a schema requiring a timestamp: the
 * client threw, the Family tab swallowed it, and because the tab shows matches awaiting
 * review only to someone it knows is a reviewer, reviewers never saw them. POST /interests
 * and its respond route had the same fault: the action saved, then the member saw an
 * error, and a retry was refused. All three went unnoticed from the day they were written.
 *
 * Every response below goes through the client's Zod parsing, so a test passing means the
 * app can read that answer. The last test fails if a client method has no test here.
 */

/** Client methods that cannot run here, and why. */
const NOT_EXERCISED: Record<string, string> = {
  uploadPhotoBytes: 'sends bytes straight to Storage, not the API',
  subscribeToMessages: 'Supabase Realtime, which does not run outside Supabase',
};

const called = new Set<string>();

interface Member {
  userId: string;
  authId: string;
  name: string;
}

let harness: TestHarness;
let seq = 0;

/** A fetch that hands the request to the real app, without a network. */
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

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

/** The client as this person, recording which methods get used. */
function as(authId: string): NikahMateClient {
  const client = new NikahMateClient({
    supabaseUrl: 'http://localhost:54321',
    publishableKey: 'test',
    storage: memoryStorage(),
    apiBaseUrl: 'http://api.test',
    fetchImpl: inject,
  });
  const token = authHeader(authId, undefined, 'aal2').authorization!.replace('Bearer ', '');
  client.auth.getAccessToken = async () => token;
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      called.add(String(property));
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

async function seedMember(gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const name = `Contract ${seq}`;
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
    `insert into public.verification_status (user_id, email_verified_at)
     values ($1::uuid, now())`,
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
  return { userId, authId, name };
}

async function seedStaff(): Promise<Member> {
  const member = await seedMember('female');
  const admin = await harness.raw.query<{ id: string }>(
    `insert into public.admin_users (user_id, mfa_required) values ($1::uuid, true) returning id`,
    [member.userId],
  );
  await harness.raw.query(
    `insert into public.admin_role_assignments (admin_user_id, role_key) values ($1::uuid, 'admin')`,
    [admin.rows[0]!.id],
  );
  return member;
}

async function match(from: Member, to: Member): Promise<{ matchId: string; id: string }> {
  const interest = await as(from.authId).sendInterest(to.userId);
  const answer = await as(to.authId).respondToInterest(interest.id, 'accept');
  const matchId = answer.match!.id;
  const rows = await harness.raw.query<{ id: string }>(
    `select id from public.conversations where match_id = $1::uuid`,
    [matchId],
  );
  return { matchId, id: rows.rows[0]?.id ?? '' };
}

const jpeg = () =>
  sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#1e785a' } })
    .jpeg()
    .toBuffer();

async function uploadPhoto(member: Member): Promise<string> {
  const client = as(member.authId);
  const target = await client.createPhotoUploadTarget({
    contentType: 'image/jpeg',
    byteSize: 120_000,
  });
  harness.storage.put(target.path, await jpeg());
  const photo = await client.finalizePhoto(target.photoId);
  return photo.id;
}

beforeAll(async () => {
  harness = await createHarness();
  await seedReferenceData(harness.raw);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('account', () => {
  it('bootstrap, then read and change it', async () => {
    const client = as(randomAuthId());
    const me = await client.bootstrap({ locale: 'en', timezone: 'UTC' });
    expect(me.status).toBe('onboarding');
    expect((await client.getMe()).userId).toBe(me.userId);
    const changed = await client.updateSettings({ timezone: 'Asia/Karachi' });
    expect(changed.timezone).toBe('Asia/Karachi');
  });

  it('notification preferences', async () => {
    const client = as((await seedMember('female')).authId);
    const preferences = await client.getNotificationPreferences();
    const saved = await client.updateNotificationPreferences({
      ...preferences,
      types: [{ type: 'new_message', push: false, inApp: true }],
    });
    expect(saved.types.find((t) => t.type === 'new_message')?.push).toBe(false);
  });

  it('deactivate and come back', async () => {
    const member = await seedMember('male');
    const client = as(member.authId);
    await client.deactivateAccount();
    expect((await client.getMe()).status).toBe('deactivated');
    await client.reactivateAccount();
    expect((await client.getMe()).status).toBe('active');
  });

  it('ask for deletion and change your mind', async () => {
    const client = as((await seedMember('female')).authId);
    await client.requestAccountDeletion();
    expect((await client.getMe()).status).toBe('pending_deletion');
    await client.cancelAccountDeletion();
    expect((await client.getMe()).status).toBe('active');
  });

  it('date of birth corrections', async () => {
    const client = as((await seedMember('female')).authId);
    await client.requestDobCorrection({
      requestedDob: '1996-01-01',
      reason: 'I entered my birth year wrongly during sign-up.',
    });
    expect((await client.listDobCorrections()).items).toHaveLength(1);
  });
});

describe('profile', () => {
  it('reference data', async () => {
    const client = as((await seedMember('female')).authId);
    expect((await client.getReference('marital_status')).items.length).toBeGreaterThan(0);
    expect(Object.keys(await client.getReferenceManifest()).length).toBeGreaterThan(0);
  });

  it('read, edit and send to review', async () => {
    const client = as((await seedMember('female')).authId);
    expect((await client.getProfile()).aboutMe).toContain('about-me');
    const edited = await client.updateProfile({
      aboutMe: 'An edited about-me, long enough to be accepted here.',
    });
    expect(edited.aboutMe).toContain('edited');
    const completion = await client.getProfileCompletion();
    expect(completion.reviewStatus).toBeTruthy();
    await client.submitProfile().catch((error: { kind?: string }) => {
      // An incomplete profile is told so. Only a parsing failure would be a contract break.
      expect(error.kind).not.toBe('server');
    });
  });

  it('preferences and field visibility', async () => {
    const client = as((await seedMember('female')).authId);
    await client.getPreferences();
    const saved = await client.updatePreferences({ ageMin: 21, ageMax: 40 });
    expect(saved.ageMin).toBe(21);
    const visibility = await client.getFieldVisibility();
    await client.updateFieldVisibility(visibility);
  });
});

describe('photos', () => {
  it('upload, list, edit, order and delete', async () => {
    const member = await seedMember('female');
    const client = as(member.authId);
    const first = await uploadPhoto(member);
    const second = await uploadPhoto(member);
    expect((await client.listPhotos()).map((p) => p.id).sort()).toEqual([first, second].sort());
    await client.updatePhoto(first, { isPrimary: false });
    expect((await client.reorderPhotos([second, first])).map((p) => p.id)).toEqual([second, first]);
    await client.deletePhoto(second);
    expect((await client.listPhotos()).map((p) => p.id)).toEqual([first]);
  });

  it('another member asks to see them, and is answered', async () => {
    const owner = await seedMember('female');
    const viewer = await seedMember('male');
    await harness.raw.query(
      `update public.photos set moderation_status = 'approved', visibility = 'on_request'
        where id = $1::uuid`,
      [await uploadPhoto(owner)],
    );
    const asked = await as(viewer.authId).requestPhotos(owner.userId, 'May I see your photos?');
    expect(Array.isArray((await as(viewer.authId).getProfilePhotos(owner.userId)).items)).toBe(
      true,
    );
    const incoming = await as(owner.authId).listPhotoRequests({ direction: 'incoming' });
    expect(incoming.items.map((r) => r.id)).toContain(asked.id);
    const answered = await as(owner.authId).respondToPhotoRequest(asked.id, 'approve');
    expect(answered.status).toBe('approved');
  });
});

describe('Discover', () => {
  it('sections, shortlist, profiles and compatibility', async () => {
    const viewer = await seedMember('female');
    const other = await seedMember('male');
    const hidden = await seedMember('male');
    const client = as(viewer.authId);
    const sections = await client.listDiscoverySections();
    expect(sections.items.length).toBeGreaterThan(0);
    await client.getDiscoverySection(sections.items[0]!.key);
    await client.addToShortlist(other.userId);
    expect((await client.getShortlist()).items.map((p) => p.userId)).toContain(other.userId);
    await client.removeFromShortlist(other.userId);
    await client.dismissProfile(hidden.userId);
    expect((await client.getPublicProfile(other.userId)).userId).toBe(other.userId);
    await client.recordProfileView(other.userId);
    await client.getCompatibility(other.userId);
    await client.getCompatibilityExplanation(other.userId);
  });
});

describe('interests and matches', () => {
  it('send, list, withdraw, accept and unmatch', async () => {
    const her = await seedMember('female');
    const him = await seedMember('male');
    const other = await seedMember('male');
    const withdrawn = await as(other.authId).sendInterest(her.userId);
    await as(other.authId).withdrawInterest(withdrawn.id);
    const sent = await as(him.authId).sendInterest(her.userId);
    expect((await as(her.authId).listInterests('received')).items.map((i) => i.id)).toContain(
      sent.id,
    );
    expect((await as(him.authId).listInterests('sent')).items.map((i) => i.id)).toContain(sent.id);
    const answer = await as(her.authId).respondToInterest(sent.id, 'accept');
    expect((await as(him.authId).listMatches()).items.map((m) => m.id)).toContain(answer.match!.id);
    await as(him.authId).unmatch(answer.match!.id);
    expect((await as(him.authId).listMatches()).items).toEqual([]);
  });
});

describe('a saved action is never answered as a failure', () => {
  it('when the card cannot be read afterwards, the answer is still a success, with no card', async () => {
    const her = await seedMember('female');
    const him = await seedMember('male');
    const asService = harness.db.asService.bind(harness.db);
    harness.db.asService = ((purpose: string, fn: never) => {
      if (purpose === 'discovery.read_cards') throw new Error('the database went away');
      return asService(purpose as never, fn);
    }) as typeof harness.db.asService;
    try {
      const sent = await as(him.authId).sendInterest(her.userId);
      expect(sent.counterpart).toBeNull();
      const answer = await as(her.authId).respondToInterest(sent.id, 'accept');
      expect(answer.interest.counterpart).toBeNull();
      expect(answer.match?.counterpart).toBeNull();
      expect(answer.interest.status).toBe('accepted');
    } finally {
      harness.db.asService = asService;
    }
  });
});

describe('messaging', () => {
  it('the whole conversation', async () => {
    const her = await seedMember('female');
    const him = await seedMember('male');
    const { id } = await match(him, her);
    const mine = as(her.authId);
    const theirs = as(him.authId);
    expect((await mine.listConversations()).items.map((c) => c.id)).toEqual([id]);
    expect((await mine.getConversation(id)).canWrite).toBe(true);
    await mine.sendMessage(id, 'Assalamu alaikum.');
    const history = await theirs.listMessages(id);
    expect(history.items[0]).toMatchObject({ body: 'Assalamu alaikum.', isMine: false });
    await theirs.markRead(id, history.items[0]!.id);
    expect((await mine.getStage(id)).currentStage).toBe(1);
    await mine.proposeStage(id);
    expect((await theirs.respondToStage(id, true)).currentStage).toBe(2);
    await mine.leaveConversation(id);
    expect((await mine.listConversations()).items).toEqual([]);
  });
});

describe('safety', () => {
  it('blocks and reports', async () => {
    const me = await seedMember('female');
    const other = await seedMember('male');
    const client = as(me.authId);
    await client.blockUser(other.userId);
    expect((await client.listBlocks()).items).toHaveLength(1);
    await client.unblockUser(other.userId);
    const report = await client.createReport({
      reportedUserId: other.userId,
      category: 'scam',
      description: 'Asked me for money.',
    });
    expect((await client.listMyReports()).items.map((r) => r.id)).toContain(report.id);
  });
});

describe('notifications', () => {
  it('read one, then the rest', async () => {
    const her = await seedMember('female');
    const him = await seedMember('male');
    await match(him, her);
    const client = as(her.authId);
    const inbox = await client.listNotifications();
    expect(inbox.items.length).toBeGreaterThan(0);
    await client.markNotificationRead(inbox.items[0]!.id);
    await client.markAllNotificationsRead();
    expect((await client.listNotifications({ unreadOnly: true })).items).toEqual([]);
  });
});

describe('family', () => {
  const invite = async (owner: Member, delegate: Member): Promise<string> => {
    const created = await as(owner.authId).createFamilyInvitation({
      inviteeContact: 'relative@example.com',
      relationshipCode: 'father',
      tier: 'reviewer',
    });
    await as(delegate.authId).respondToFamilyInvitation(created.id, created.token, true);
    const members = await as(owner.authId).listFamilyMembers();
    return members.items.find((m) => m.userId === delegate.userId)!.id;
  };

  it('invitations can be listed and cancelled', async () => {
    const client = as((await seedMember('female')).authId);
    const created = await client.createFamilyInvitation({
      inviteeContact: 'mother@example.com',
      relationshipCode: 'mother',
      tier: 'observer',
    });
    expect((await client.listFamilyInvitations()).items.map((i) => i.id)).toContain(created.id);
    await client.cancelFamilyInvitation(created.id);
  });

  it('a reviewer can read who they help, which the review section depends on', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    await invite(owner, delegate);
    const managed = await as(delegate.authId).listManagedProfiles();
    expect(managed.items).toHaveLength(1);
    expect(managed.items[0]).toMatchObject({ userId: owner.userId, displayName: owner.name });
    expect(Number.isNaN(Date.parse(managed.items[0]!.createdAt))).toBe(false);
  });

  it('a review from packet to decision, then revoked, then permissions and removal', async () => {
    const owner = await seedMember('female');
    const delegate = await seedMember('male');
    const suitor = await seedMember('male');
    const relationship = await invite(owner, delegate);
    await harness.raw.query(
      `update public.user_settings set communication_policy = 'family_reviewed'
        where user_id = $1::uuid`,
      [owner.userId],
    );
    const { matchId } = await match(suitor, owner);
    const reviewer = as(delegate.authId);
    expect((await reviewer.listFamilyReviews()).items.map((r) => r.matchId)).toContain(matchId);
    const packet = await reviewer.getReviewPacket(matchId);
    expect(packet.ownerDisplayName).toBe(owner.name);
    await reviewer.decideReview(matchId, { action: 'approve' });
    await reviewer.revokeReview(matchId, 'On reflection.');
    await as(owner.authId).listMyFamilyReviews();
    await as(owner.authId).listFamilyAccessLog();
    await as(owner.authId).updateFamilyPermissions(relationship, []);
    await as(owner.authId).revokeFamilyMember(relationship);
    expect((await reviewer.listManagedProfiles()).items).toEqual([]);
  });
});

describe('the staff console', () => {
  it('every queue and every decision', async () => {
    const staff = await seedStaff();
    const console_ = as(staff.authId);
    expect((await console_.getAdminSession()).roles).toContain('admin');

    const photoOwner = await seedMember('female');
    const photoId = await uploadPhoto(photoOwner);
    const photos = await console_.listPhotoQueue();
    expect(photos.items.map((p) => p.photoId)).toContain(photoId);
    await console_.decidePhoto(photoId, { decision: 'approve' });

    const pending = await seedMember('female');
    await harness.raw.query(
      `update public.profiles set review_status = 'pending' where user_id = $1::uuid`,
      [pending.userId],
    );
    const profiles = await console_.listProfileQueue();
    expect(profiles.items.map((p) => p.userId)).toContain(pending.userId);
    await console_.decideProfile(pending.userId, { decision: 'approve' });

    const reporter = await seedMember('female');
    const reported = await seedMember('male');
    const report = await as(reporter.authId).createReport({
      reportedUserId: reported.userId,
      category: 'scam',
      description: 'Asked me for money.',
    });
    const reports = await console_.listReportQueue();
    expect(reports.items.map((r) => r.reportId)).toContain(report.id);
    await console_.updateReport(report.id, { status: 'dismissed' });

    const suspended = await console_.actOnUser(reported.userId, {
      action: 'suspend',
      reason: 'Repeated harassment reports.',
    });
    expect(suspended.status).toBe('suspended');
    const cleared = await console_.actOnUser(reported.userId, {
      action: 'clear',
      reason: 'Appeal upheld.',
    });
    expect(cleared.status).toBe('active');

    const asker = await seedMember('female');
    const asked = await as(asker.authId).requestDobCorrection({
      requestedDob: '1996-01-01',
      reason: 'I entered my birth year wrongly during sign-up.',
    });
    const dob = await console_.listDobQueue();
    expect(dob.items.map((d) => d.requestId)).toContain(asked.requestId);
    await console_.decideDobCorrection(asked.requestId, {
      decision: 'reject',
      note: 'No document.',
    });

    expect((await console_.listAudit()).items.length).toBeGreaterThan(0);
  });
});

describe('coverage', () => {
  it('no client method is left out of this file', () => {
    const methods = Object.getOwnPropertyNames(NikahMateClient.prototype).filter(
      (name) => name !== 'constructor',
    );
    const missing = methods.filter((name) => !called.has(name) && !(name in NOT_EXERCISED));
    expect(missing).toEqual([]);
  });
});
