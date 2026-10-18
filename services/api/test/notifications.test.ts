import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * The notification inbox.
 *
 * The duplicate cases are the point of this file. A notification is the one
 * artefact a member cannot un-see, so sending two "you have a new match" for
 * one match is a visible bug — and the shape of this system makes it easy:
 * acceptances can race, unmatched pairs can rematch onto the SAME row, and
 * every retry hits the same code path.
 *
 * The inverse matters just as much: a rematch must notify AGAIN. Suppressing
 * it would mean the one event the pair most want to hear about is the one
 * swallowed by the duplicate guard.
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
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Member ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  return { userId, authId };
}

const send = (sender: Member, recipientUserId: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/interests',
    headers: authHeader(sender.authId),
    payload: { recipientUserId },
  });

const respond = (member: Member, interestId: string, decision: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/interests/${interestId}/respond`,
    headers: authHeader(member.authId),
    payload: { decision },
  });

const unmatch = (member: Member, matchId: string) =>
  harness.app.inject({
    method: 'POST',
    url: `/matches/${matchId}/unmatch`,
    headers: authHeader(member.authId),
    payload: {},
  });

const inbox = (member: Member, query = '') =>
  harness.app.inject({
    method: 'GET',
    url: `/notifications${query}`,
    headers: authHeader(member.authId),
  });

/** Rows straight from the table, so a privacy test cannot be fooled by a route. */
const rowsFor = async (userId: string, type?: string) => {
  const rows = await harness.raw.query<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    read_at: string | null;
  }>(
    `select id, type, payload, read_at from public.notifications
      where user_id = $1::uuid ${type ? 'and type = $2::text' : ''}
      order by created_at`,
    type ? [userId, type] : [userId],
  );
  return rows.rows;
};

async function matched(): Promise<{ alice: Member; bilal: Member; matchId: string }> {
  const alice = await seedMember('female');
  const bilal = await seedMember('male');
  const interestId = (await send(alice, bilal.userId)).json().id as string;
  const matchId = (await respond(bilal, interestId, 'accept')).json().match.id as string;
  return { alice, bilal, matchId };
}

beforeAll(async () => {
  harness = await createHarness();
  await harness.raw.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'),
      ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing;
  `);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------
// Event -> notification
// ---------------------------------------------------------------------------

describe('interest_received', () => {
  it('reaches the recipient, not the sender', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = (await send(sender, recipient.userId)).json().id as string;

    const received = await rowsFor(recipient.userId, 'interest_received');
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.interestId).toBe(interestId);
    expect(received[0]!.payload.actorUserId).toBe(sender.userId);

    expect(await rowsFor(sender.userId)).toHaveLength(0);
  });

  it('arrives unread', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);
    expect((await rowsFor(recipient.userId))[0]!.read_at).toBeNull();
  });

  it('is not written when the send is refused', async () => {
    // Same transaction as the interest and the quota, so a refusal leaves
    // nothing behind.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [recipient.userId, sender.userId],
    );
    expect((await send(sender, recipient.userId)).statusCode).toBe(404);
    expect(await rowsFor(recipient.userId)).toHaveLength(0);
  });
});

describe('interest_accepted', () => {
  it('reaches the SENDER when their interest is accepted', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = (await send(sender, recipient.userId)).json().id as string;
    await respond(recipient, interestId, 'accept');

    const accepted = await rowsFor(sender.userId, 'interest_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload.actorUserId).toBe(recipient.userId);
  });

  it('is NOT sent on a decline', async () => {
    // The contract's type enum has no `interest_declined`, and that absence is
    // a decision: "a decline tells the sender it was declined and nothing
    // more". A push the moment someone says no is the opposite of that.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = (await send(sender, recipient.userId)).json().id as string;
    await respond(recipient, interestId, 'decline');

    expect(await rowsFor(sender.userId)).toHaveLength(0);
  });

  it('is NOT sent on maybe_later', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const interestId = (await send(sender, recipient.userId)).json().id as string;
    await respond(recipient, interestId, 'maybe_later');

    expect(await rowsFor(sender.userId)).toHaveLength(0);
  });
});

describe('new_match', () => {
  it('reaches BOTH participants', async () => {
    const { alice, bilal, matchId } = await matched();

    for (const member of [alice, bilal]) {
      const rows = await rowsFor(member.userId, 'new_match');
      expect(rows, member.userId).toHaveLength(1);
      expect(rows[0]!.payload.matchId).toBe(matchId);
    }
    // Each is told who the OTHER person is, by id.
    expect((await rowsFor(alice.userId, 'new_match'))[0]!.payload.counterpartUserId).toBe(
      bilal.userId,
    );
    expect((await rowsFor(bilal.userId, 'new_match'))[0]!.payload.counterpartUserId).toBe(
      alice.userId,
    );
  });

  it('is NOT sent when unmatching', async () => {
    // The contract's enum has no match-ended type. Ending a match is not
    // something the other person is pushed about.
    const { alice, bilal, matchId } = await matched();
    const before = (await rowsFor(bilal.userId)).length;

    await unmatch(alice, matchId);
    expect(await rowsFor(bilal.userId)).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Duplicates — the reason this file exists
// ---------------------------------------------------------------------------

describe('duplicate prevention', () => {
  it('sends one interest_received however many times the send is retried', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    for (let i = 0; i < 4; i += 1) await send(sender, recipient.userId);
    expect(await rowsFor(recipient.userId, 'interest_received')).toHaveLength(1);
  });

  it('sends one interest_received under concurrent sends', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await Promise.all(Array.from({ length: 5 }, () => send(sender, recipient.userId)));
    expect(await rowsFor(recipient.userId, 'interest_received')).toHaveLength(1);
  });

  it('sends one interest_accepted and one new_match on a repeated accept', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const interestId = (await send(alice, bilal.userId)).json().id as string;

    await respond(bilal, interestId, 'accept');
    await respond(bilal, interestId, 'accept');
    await respond(bilal, interestId, 'accept');

    expect(await rowsFor(alice.userId, 'interest_accepted')).toHaveLength(1);
    expect(await rowsFor(alice.userId, 'new_match')).toHaveLength(1);
    expect(await rowsFor(bilal.userId, 'new_match')).toHaveLength(1);
  });

  it('sends ONE new_match when both sides accept crossing interests at once', async () => {
    // The trap. Two acceptances both succeed and both return the same match;
    // only the one that actually created it may notify.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const aToB = (await send(alice, bilal.userId)).json().id as string;
    const bToA = (await send(bilal, alice.userId)).json().id as string;

    const [first, second] = await Promise.all([
      respond(bilal, aToB, 'accept'),
      respond(alice, bToA, 'accept'),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    expect(await rowsFor(alice.userId, 'new_match')).toHaveLength(1);
    expect(await rowsFor(bilal.userId, 'new_match')).toHaveLength(1);
  });

  it('sends one new_match under five concurrent accepts', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    const interestId = (await send(alice, bilal.userId)).json().id as string;
    await Promise.all(Array.from({ length: 5 }, () => respond(bilal, interestId, 'accept')));

    expect(await rowsFor(alice.userId, 'new_match')).toHaveLength(1);
    expect(await rowsFor(bilal.userId, 'new_match')).toHaveLength(1);
  });

  it('writes nothing extra on a repeated or concurrent unmatch', async () => {
    const { alice, bilal, matchId } = await matched();
    const before = (await rowsFor(bilal.userId)).length;

    await unmatch(alice, matchId);
    await unmatch(alice, matchId);
    await Promise.all([unmatch(alice, matchId), unmatch(bilal, matchId)]);

    expect(await rowsFor(bilal.userId)).toHaveLength(before);
  });
});

describe('rematch', () => {
  it('notifies AGAIN, because it is a genuinely new match', async () => {
    // The inverse trap. A rematched pair reuses its `matches` row, so a
    // dedupe key based on the match id alone would swallow exactly the event
    // they most want to hear about.
    const { alice, bilal, matchId } = await matched();
    expect(await rowsFor(alice.userId, 'new_match')).toHaveLength(1);

    await unmatch(alice, matchId);
    const fresh = (await send(bilal, alice.userId)).json().id as string;
    const response = await respond(alice, fresh, 'accept');
    expect(response.json().match.id).toBe(matchId);

    // Same match row, two match periods, two notifications each.
    expect(await rowsFor(alice.userId, 'new_match')).toHaveLength(2);
    expect(await rowsFor(bilal.userId, 'new_match')).toHaveLength(2);
  });

  it('keys the two on different interests', async () => {
    const { alice, bilal, matchId } = await matched();
    await unmatch(alice, matchId);
    const fresh = (await send(bilal, alice.userId)).json().id as string;
    await respond(alice, fresh, 'accept');

    const payloads = (await rowsFor(alice.userId, 'new_match')).map((r) => r.payload.interestId);
    expect(new Set(payloads).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

describe('GET /notifications', () => {
  it('returns the caller notifications with an unread count', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const body = (await inbox(recipient)).json();
    expect(body.items).toHaveLength(1);
    expect(body.unreadCount).toBe(1);

    const item = body.items[0];
    expect(item.type).toBe('interest_received');
    expect(item.titleKey).toBe('notifications.interest_received.title');
    expect(item.bodyKey).toBe('notifications.interest_received.body');
    expect(item.readAt).toBeNull();
    expect(item.data.actorUserId).toBe(sender.userId);
  });

  it('carries identifiers only, never profile content', async () => {
    // A notification is read long after it is written, so a name copied in
    // would outlive the permission that allowed it.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const data = (await inbox(recipient)).json().items[0].data as Record<string, unknown>;
    for (const forbidden of ['displayName', 'name', 'age', 'photo', 'cityName', 'aboutMe']) {
      expect(data, forbidden).not.toHaveProperty(forbidden);
    }
    expect(Object.keys(data).sort()).toEqual(['actorUserId', 'interestId']);
  });

  it('shows one member nothing of another inbox', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    await send(sender, recipient.userId);

    const body = (await inbox(other)).json();
    expect(body.items).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('refuses an anonymous request', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/notifications' });
    expect(response.statusCode).toBe(401);
  });

  it('filters to unread only', async () => {
    const recipient = await seedMember('female');
    for (let i = 0; i < 3; i += 1) {
      await send(await seedMember('male'), recipient.userId);
    }
    const all = (await inbox(recipient)).json();
    expect(all.items).toHaveLength(3);

    const firstId = all.items[0].id as string;
    await harness.app.inject({
      method: 'POST',
      url: `/notifications/${firstId}/read`,
      headers: authHeader(recipient.authId),
    });

    const unread = (await inbox(recipient, '?unreadOnly=true')).json();
    expect(unread.items).toHaveLength(2);
    expect(unread.unreadCount).toBe(2);
    expect((unread.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(firstId);
  });

  it('rejects a malformed unreadOnly, cursor or limit', async () => {
    const member = await seedMember('female');
    expect((await inbox(member, '?unreadOnly=maybe')).statusCode).toBe(400);
    expect((await inbox(member, '?cursor=garbage')).statusCode).toBe(400);
    expect((await inbox(member, '?limit=0')).statusCode).toBe(400);
    expect((await inbox(member, '?limit=51')).statusCode).toBe(400);
  });

  it('pages without gaps or repeats, and reports an honest empty page', async () => {
    const recipient = await seedMember('female');
    for (let i = 0; i < 5; i += 1) {
      await send(await seedMember('male'), recipient.userId);
    }

    const all = ((await inbox(recipient, '?limit=50')).json().items as Array<{ id: string }>).map(
      (i) => i.id,
    );
    expect(all).toHaveLength(5);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body: { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null } = (
        await inbox(recipient, `?limit=2${suffix}`)
      ).json();
      walked.push(...body.items.map((i) => i.id));
      cursor = body.hasMore ? body.nextCursor : null;
      if (!body.hasMore) expect(body.nextCursor).toBeNull();
      pages += 1;
      expect(pages, 'cursor walk did not terminate').toBeLessThan(20);
    } while (cursor);

    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);

    const empty = (await inbox(await seedMember('female'))).json();
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

describe('marking read', () => {
  it('marks one and answers 204', async () => {
    const recipient = await seedMember('female');
    await send(await seedMember('male'), recipient.userId);
    const id = (await inbox(recipient)).json().items[0].id as string;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/notifications/${id}/read`,
      headers: authHeader(recipient.authId),
    });
    expect(response.statusCode).toBe(204);

    const body = (await inbox(recipient)).json();
    expect(body.items[0].readAt).not.toBeNull();
    expect(body.unreadCount).toBe(0);
  });

  it('keeps the FIRST read time on a repeat', async () => {
    const recipient = await seedMember('female');
    await send(await seedMember('male'), recipient.userId);
    const id = (await inbox(recipient)).json().items[0].id as string;

    const mark = () =>
      harness.app.inject({
        method: 'POST',
        url: `/notifications/${id}/read`,
        headers: authHeader(recipient.authId),
      });

    await mark();
    const first = (await rowsFor(recipient.userId))[0]!.read_at;
    expect((await mark()).statusCode).toBe(204);
    // Idempotent, and it does not rewrite when they actually saw it.
    expect((await rowsFor(recipient.userId))[0]!.read_at).toEqual(first);
  });

  it('does NOT let a member mark another member notification read', async () => {
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    await send(await seedMember('male'), recipient.userId);
    const id = (await inbox(recipient)).json().items[0].id as string;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/notifications/${id}/read`,
      headers: authHeader(other.authId),
    });
    // Absent rather than forbidden: a 403 would confirm it exists.
    expect(response.statusCode).toBe(404);
    expect((await rowsFor(recipient.userId))[0]!.read_at).toBeNull();
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const member = await seedMember('female');
    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/notifications/00000000-0000-0000-0000-000000000000/read',
      headers: authHeader(member.authId),
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/notifications/nope/read',
      headers: authHeader(member.authId),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('marks everything read, and only for the caller', async () => {
    const recipient = await seedMember('female');
    const bystander = await seedMember('female');
    for (let i = 0; i < 3; i += 1) await send(await seedMember('male'), recipient.userId);
    await send(await seedMember('male'), bystander.userId);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: authHeader(recipient.authId),
    });
    expect(response.statusCode).toBe(204);

    expect((await inbox(recipient)).json().unreadCount).toBe(0);
    // The bystander is untouched.
    expect((await inbox(bystander)).json().unreadCount).toBe(1);
  });

  it('read-all is idempotent and refuses anonymously', async () => {
    const recipient = await seedMember('female');
    await send(await seedMember('male'), recipient.userId);

    const call = (auth?: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/notifications/read-all',
        ...(auth ? { headers: authHeader(auth) } : {}),
      });

    expect((await call(recipient.authId)).statusCode).toBe(204);
    const first = (await rowsFor(recipient.userId))[0]!.read_at;
    expect((await call(recipient.authId)).statusCode).toBe(204);
    expect((await rowsFor(recipient.userId))[0]!.read_at).toEqual(first);

    expect((await call()).statusCode).toBe(401);
  });

  it('is not shadowed by the :notificationId route', async () => {
    const member = await seedMember('female');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: authHeader(member.authId),
    });
    expect(response.statusCode).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('nothing beyond the inbox', () => {
  it('has no push, preferences or token tables', async () => {
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('push_tokens', 'notification_preferences')`,
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(0);
  });

  it('exposes no notification-preferences endpoint', async () => {
    const member = await seedMember('female');
    for (const method of ['GET', 'PUT'] as const) {
      const response = await harness.app.inject({
        method,
        url: '/me/notification-preferences',
        headers: authHeader(member.authId),
        payload: {},
      });
      expect([404, 405], method).toContain(response.statusCode);
    }
  });
});
