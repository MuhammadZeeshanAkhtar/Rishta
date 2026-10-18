import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FREE_PLAN_ENTITLEMENTS } from '@nikahmate/domain';
import { grantEntitlement } from '../src/entitlements/service';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * `POST /interests` and withdrawal.
 *
 * The contract fixes the order of checks — block, gender, approved, quota,
 * existing — and fixes the transaction boundary around the last two: "Quota
 * consumption happens in the same transaction as the insert — otherwise two
 * concurrent requests both read the same remaining count and the limit is
 * advisory."
 *
 * So the tests that matter most are the ones about what does NOT happen: a
 * refused send must not spend an allowance, and five simultaneous sends must
 * not produce five rows or five units of quota.
 */

let harness: TestHarness;
let seq = 0;

const FREE_LIMIT = FREE_PLAN_ENTITLEMENTS.daily_interests as number;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(
  gender: 'male' | 'female',
  overrides: { reviewStatus?: string; status?: string } = {},
): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', $3::text) returning id`,
    [`Member ${seq}`, gender, overrides.status ?? 'active'],
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
             'ms_never_married', 'rel_practising', $2::text)`,
    [userId, overrides.reviewStatus ?? 'approved'],
  );
  return { userId, authId };
}

const send = (sender: Member, recipientUserId: string, note?: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/interests',
    headers: authHeader(sender.authId),
    payload: note === undefined ? { recipientUserId } : { recipientUserId, note },
  });

const quotaUsed = async (userId: string): Promise<number> => {
  const rows = await harness.raw.query<{ count: number }>(
    `select count from public.usage_counters
      where user_id = $1::uuid and counter_key = 'daily_interests'
        and period_start = current_date`,
    [userId],
  );
  return rows.rows[0]?.count ?? 0;
};

const interestCount = async (senderUserId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.interests where sender_user_id = $1::uuid`,
    [senderUserId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const eventCount = async (interestId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.interest_events where interest_id = $1::uuid`,
    [interestId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const relationship = async (a: string, b: string): Promise<string> => {
  const rows = await harness.raw.query<{ v: string }>(
    `select app.relationship($1::uuid, $2::uuid) as v`,
    [a, b],
  );
  return rows.rows[0]!.v;
};

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
// The happy path
// ---------------------------------------------------------------------------

describe('POST /interests', () => {
  it('creates an interest and returns the contract shape', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');

    const response = await send(sender, recipient.userId, 'Assalamu alaikum');
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.direction).toBe('sent');
    expect(body.counterpartUserId).toBe(recipient.userId);
    expect(body.status).toBe('pending');
    expect(body.note).toBe('Assalamu alaikum');
    // A7: always present, so a delegate's action could never be covert.
    expect(body).toHaveProperty('actedBy');
    expect(body.actedBy).toBeNull();
  });

  it('records the correct owner and target', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const rows = await harness.raw.query<{ sender_user_id: string; recipient_user_id: string }>(
      `select sender_user_id, recipient_user_id from public.interests
        where sender_user_id = $1::uuid`,
      [sender.userId],
    );
    expect(rows.rows[0]!.sender_user_id).toBe(sender.userId);
    expect(rows.rows[0]!.recipient_user_id).toBe(recipient.userId);
  });

  it('moves the relationship to interest_pending, both ways', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    expect(await relationship(sender.userId, recipient.userId)).toBe('stranger');

    await send(sender, recipient.userId);
    expect(await relationship(sender.userId, recipient.userId)).toBe('interest_pending');
    expect(await relationship(recipient.userId, sender.userId)).toBe('interest_pending');
  });

  it('writes exactly one `sent` event', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    const rows = await harness.raw.query<{ event: string; actor_user_id: string }>(
      `select event, actor_user_id from public.interest_events where interest_id = $1::uuid`,
      [id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.event).toBe('sent');
    expect(rows.rows[0]!.actor_user_id).toBe(sender.userId);
  });

  it('consumes exactly one unit of quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    expect(await quotaUsed(sender.userId)).toBe(0);

    await send(sender, recipient.userId);
    expect(await quotaUsed(sender.userId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rejections — none of which may spend quota
// ---------------------------------------------------------------------------

describe('rejections', () => {
  it('refuses an anonymous request', async () => {
    const recipient = await seedMember('female');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/interests',
      payload: { recipientUserId: recipient.userId },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses sending to yourself, without spending quota', async () => {
    const sender = await seedMember('male');
    expect((await send(sender, sender.userId)).statusCode).toBe(404);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses a target who blocked the sender, without spending quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [recipient.userId, sender.userId],
    );

    const response = await send(sender, recipient.userId);
    // 404 not 403: a 403 would confirm the member exists.
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses a target the sender blocked, without spending quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [sender.userId, recipient.userId],
    );
    expect((await send(sender, recipient.userId)).statusCode).toBe(404);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses the same gender, without spending quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('male');
    expect((await send(sender, recipient.userId)).statusCode).toBe(400);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses an unapproved target, without spending quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female', { reviewStatus: 'pending' });
    expect((await send(sender, recipient.userId)).statusCode).toBe(404);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses a suspended target, without spending quota', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      recipient.userId,
    ]);
    expect((await send(sender, recipient.userId)).statusCode).toBe(404);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses a target that does not exist', async () => {
    const sender = await seedMember('male');
    expect((await send(sender, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses a malformed body', async () => {
    const sender = await seedMember('male');
    for (const payload of [{}, { recipientUserId: 'nope' }, { recipientUserId: 123 }]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/interests',
        headers: authHeader(sender.authId),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await quotaUsed(sender.userId)).toBe(0);
  });

  it('refuses an over-long note', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const response = await send(sender, recipient.userId, 'x'.repeat(501));
    expect(response.statusCode).toBe(400);
    expect(await quotaUsed(sender.userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('duplicates', () => {
  it('answers the contract 409 on a second send', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    expect((await send(sender, recipient.userId)).statusCode).toBe(201);

    const second = await send(sender, recipient.userId);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('conflict');
  });

  it('does NOT spend quota on the duplicate', async () => {
    // The contract puts the quota check BEFORE the existing-interest check, so
    // the increment happens and then the duplicate aborts the transaction —
    // which must roll the increment back with it.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);
    expect(await quotaUsed(sender.userId)).toBe(1);

    await send(sender, recipient.userId);
    await send(sender, recipient.userId);
    expect(await quotaUsed(sender.userId)).toBe(1);
  });

  it('creates no second row on rapid repeats', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    for (let i = 0; i < 4; i += 1) await send(sender, recipient.userId);
    expect(await interestCount(sender.userId)).toBe(1);
  });

  it('writes no second event on a repeat', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await send(sender, recipient.userId);
    expect(await eventCount(id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('the daily quota', () => {
  it('uses the free-plan allowance from the entitlement service', async () => {
    const sender = await seedMember('male');
    for (let i = 0; i < FREE_LIMIT; i += 1) {
      const recipient = await seedMember('female');
      expect((await send(sender, recipient.userId)).statusCode, `send ${i + 1}`).toBe(201);
    }
    expect(await quotaUsed(sender.userId)).toBe(FREE_LIMIT);
  });

  it('answers the contract 429 once exhausted', async () => {
    const sender = await seedMember('male');
    for (let i = 0; i < FREE_LIMIT; i += 1) {
      await send(sender, (await seedMember('female')).userId);
    }
    const extra = await seedMember('female');
    const response = await send(sender, extra.userId);
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('quota_exhausted');
  });

  it('does not over-consume when refused at the limit', async () => {
    // The refused send increments then rolls back, so the counter must sit
    // exactly at the limit rather than above it.
    const sender = await seedMember('male');
    for (let i = 0; i < FREE_LIMIT; i += 1) {
      await send(sender, (await seedMember('female')).userId);
    }
    await send(sender, (await seedMember('female')).userId);
    await send(sender, (await seedMember('female')).userId);
    expect(await quotaUsed(sender.userId)).toBe(FREE_LIMIT);
  });

  it('creates no interest once the quota is gone', async () => {
    const sender = await seedMember('male');
    for (let i = 0; i < FREE_LIMIT; i += 1) {
      await send(sender, (await seedMember('female')).userId);
    }
    const blocked = await seedMember('female');
    await send(sender, blocked.userId);
    expect(await interestCount(sender.userId)).toBe(FREE_LIMIT);
  });

  it('honours a raised allowance through the existing entitlement model', async () => {
    // No second plan system: an override on `daily_interests` is all it takes.
    const sender = await seedMember('male');
    await grantEntitlement(harness.db, sender.userId, 'daily_interests', FREE_LIMIT + 2);

    for (let i = 0; i < FREE_LIMIT + 2; i += 1) {
      const recipient = await seedMember('female');
      expect((await send(sender, recipient.userId)).statusCode, `send ${i + 1}`).toBe(201);
    }
    const extra = await seedMember('female');
    expect((await send(sender, extra.userId)).statusCode).toBe(429);
  });

  it('refuses everything when the allowance is zero', async () => {
    const sender = await seedMember('male');
    await grantEntitlement(harness.db, sender.userId, 'daily_interests', 0);
    const recipient = await seedMember('female');

    expect((await send(sender, recipient.userId)).statusCode).toBe(429);
    expect(await quotaUsed(sender.userId)).toBe(0);
    expect(await interestCount(sender.userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — genuinely parallel, not sequential repeats
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('creates one row when the same interest is sent five times at once', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => send(sender, recipient.userId)),
    );
    const created = responses.filter((r) => r.statusCode === 201);

    expect(created).toHaveLength(1);
    expect(await interestCount(sender.userId)).toBe(1);
    // And the losers all got the contract's conflict, not a 500.
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect([409, 429]).toContain(response.statusCode);
    }
  });

  it('spends exactly one unit of quota for that one row', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await Promise.all(Array.from({ length: 5 }, () => send(sender, recipient.userId)));
    expect(await quotaUsed(sender.userId)).toBe(1);
  });

  it('writes exactly one event for that one row', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await Promise.all(Array.from({ length: 5 }, () => send(sender, recipient.userId)));

    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.interest_events e
         join public.interests i on i.id = e.interest_id
        where i.sender_user_id = $1::uuid`,
      [sender.userId],
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(1);
  });

  it('cannot overspend the quota at the boundary', async () => {
    // Fill to one below the limit, then fire several at once at distinct
    // targets. Only the remaining allowance may succeed.
    const sender = await seedMember('male');
    for (let i = 0; i < FREE_LIMIT - 1; i += 1) {
      await send(sender, (await seedMember('female')).userId);
    }

    const targets = await Promise.all([
      seedMember('female'),
      seedMember('female'),
      seedMember('female'),
      seedMember('female'),
    ]);
    const responses = await Promise.all(targets.map((t) => send(sender, t.userId)));

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await quotaUsed(sender.userId)).toBe(FREE_LIMIT);
    expect(await interestCount(sender.userId)).toBe(FREE_LIMIT);
  });

  it('never leaves a negative counter', async () => {
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.usage_counters where count < 0`,
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

describe('DELETE /interests/:interestId', () => {
  const withdraw = (member: Member, interestId: string) =>
    harness.app.inject({
      method: 'DELETE',
      url: `/interests/${interestId}`,
      headers: authHeader(member.authId),
    });

  it('lets the sender withdraw, and records the event', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    expect((await withdraw(sender, id)).statusCode).toBe(204);
    expect(await eventCount(id)).toBe(2);

    const rows = await harness.raw.query<{ status: string }>(
      `select status from public.interests where id = $1::uuid`,
      [id],
    );
    expect(rows.rows[0]!.status).toBe('withdrawn');
  });

  it('returns the relationship to stranger', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await withdraw(sender, id);

    expect(await relationship(sender.userId, recipient.userId)).toBe('stranger');
    expect(await relationship(recipient.userId, sender.userId)).toBe('stranger');
  });

  it('does NOT let the RECIPIENT withdraw it', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    expect((await withdraw(recipient, id)).statusCode).toBe(404);
    const rows = await harness.raw.query<{ status: string }>(
      `select status from public.interests where id = $1::uuid`,
      [id],
    );
    expect(rows.rows[0]!.status).toBe('pending');
  });

  it('does NOT let an uninvolved member withdraw it', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    const id = (await send(sender, recipient.userId)).json().id as string;

    expect((await withdraw(other, id)).statusCode).toBe(404);
  });

  it('refuses a second withdrawal with the contract 409', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await withdraw(sender, id);

    const second = await withdraw(sender, id);
    expect(second.statusCode).toBe(409);
    // And no second event: the audit trail must not grow on a repeat.
    expect(await eventCount(id)).toBe(2);
  });

  it('does NOT refund quota', async () => {
    // A refund would make the daily limit trivially bypassable: send,
    // withdraw, repeat. The contract defines none.
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    expect(await quotaUsed(sender.userId)).toBe(1);

    await withdraw(sender, id);
    expect(await quotaUsed(sender.userId)).toBe(1);
  });

  it('lets a fresh interest be sent after a withdrawal', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;
    await withdraw(sender, id);

    // Someone may reconsider — the unique index is partial for this reason.
    expect((await send(sender, recipient.userId)).statusCode).toBe(201);
  });

  it('refuses an anonymous request', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const id = (await send(sender, recipient.userId)).json().id as string;

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/interests/${id}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('GET /interests', () => {
  it('lists what the caller sent', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/interests?direction=sent',
      headers: authHeader(sender.authId),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ direction: string; counterpartUserId: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.direction).toBe('sent');
    expect(items[0]!.counterpartUserId).toBe(recipient.userId);
  });

  it('lists what the caller received, from the other side', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    await send(sender, recipient.userId);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/interests?direction=received',
      headers: authHeader(recipient.authId),
    });
    const items = response.json().items as Array<{ direction: string; counterpartUserId: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.direction).toBe('received');
    expect(items[0]!.counterpartUserId).toBe(sender.userId);
  });

  it('requires a direction, as the contract does', async () => {
    const sender = await seedMember('male');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/interests',
      headers: authHeader(sender.authId),
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows an uninvolved member nothing', async () => {
    const sender = await seedMember('male');
    const recipient = await seedMember('female');
    const other = await seedMember('male');
    await send(sender, recipient.userId);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/interests?direction=received',
      headers: authHeader(other.authId),
    });
    expect(response.json().items).toEqual([]);
  });

  it('refuses an anonymous request', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/interests?direction=sent' });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Sending alone still creates nothing
// ---------------------------------------------------------------------------

describe('crossing interests alone do not match', () => {
  it('leaves both pending until someone actually responds', async () => {
    // Phase 6 Slice 2 made accepting create a match. Sending does not: the
    // contract is "Accepting creates a match", so two unanswered interests are
    // still just two interests.
    const alice = await seedMember('female');
    const bilal = await seedMember('male');

    expect((await send(alice, bilal.userId)).statusCode).toBe(201);
    expect((await send(bilal, alice.userId)).statusCode).toBe(201);

    const rows = await harness.raw.query<{ status: string }>(
      `select status from public.interests
        where (sender_user_id = $1::uuid and recipient_user_id = $2::uuid)
           or (sender_user_id = $2::uuid and recipient_user_id = $1::uuid)`,
      [alice.userId, bilal.userId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.status === 'pending')).toBe(true);

    const matches = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.matches
        where user_a_id = least($1::uuid, $2::uuid)
          and user_b_id = greatest($1::uuid, $2::uuid)`,
      [alice.userId, bilal.userId],
    );
    expect(Number.parseInt(matches.rows[0]!.n, 10)).toBe(0);

    // And the relationship is the weaker one until a response lands.
    const rel = await harness.raw.query<{ v: string }>(
      `select app.relationship($1::uuid, $2::uuid) as v`,
      [alice.userId, bilal.userId],
    );
    expect(rel.rows[0]!.v).toBe('interest_pending');
  });
});
