import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Code review remediation, Phase 1 — the database half (migrations 0026 and
 * 0027; 0027 is only the `messages.kind` revoke, split out for release order).
 *
 * Each block here is a regression test for one finding in the 2026-10-28
 * review, written against the table rather than the route. The routes are
 * fixed too and tested in services/api; these exist because every one of
 * these findings was reachable WITHOUT the route — by a future caller, or by
 * a member talking to the Supabase Data API directly.
 *
 *   B1  a rejection could be overridden by the other family's approval
 *   B3  pause and incognito were stored and never applied; incognito was free
 *   B7  a member could post `system` messages and blank messages
 */

let db: TestDb;

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** An accepted interest and the match it creates; the gate trigger decides the state. */
async function matchOf(
  sender: SeededUser,
  recipient: SeededUser,
): Promise<{ matchId: string; state: string }> {
  const interest = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [sender.userId, recipient.userId],
  );
  const [a, b] = ordered(sender.userId, recipient.userId);
  const rows = await db.admin<{ id: string; communication_state: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid) returning id, communication_state`,
    [a, b, interest[0]!.id],
  );
  return { matchId: rows[0]!.id, state: rows[0]!.communication_state };
}

async function grantIncognito(user: SeededUser, expiresAt: string | null = null): Promise<void> {
  await db.admin(
    `insert into public.user_entitlements (user_id, entitlement_key, value, expires_at)
     values ($1::uuid, 'incognito', 'true'::jsonb, $2::timestamptz)
     on conflict (user_id, entitlement_key)
       do update set value = excluded.value, expires_at = excluded.expires_at`,
    [user.userId, expiresAt],
  );
}

async function discoverable(viewer: SeededUser, target: SeededUser): Promise<boolean> {
  const rows = await db.admin<{ ok: boolean }>(
    `select app.discoverable_to($1::uuid, $2::uuid) as ok`,
    [viewer.userId, target.userId],
  );
  return rows[0]!.ok;
}

async function viewable(viewer: SeededUser, target: SeededUser): Promise<boolean> {
  const rows = await db.admin<{ ok: boolean }>(
    `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
    [viewer.userId, target.userId],
  );
  return rows[0]!.ok;
}

/** A member with an approved profile, so can_view_profile() can say yes. */
async function member(name: string, gender: 'male' | 'female'): Promise<SeededUser> {
  const user = await seedUser(db, { displayName: name, gender });
  // `profiles_complete_for_review` refuses any status but 'draft' without the
  // required fields; satisfied here exactly as visibility-rls.test.ts does.
  await db.admin(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [user.userId],
  );
  return user;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// =============================================================================
// B1
// =============================================================================

describe('B1 — one family cannot override the other family’s rejection', () => {
  let matchId: string;
  let ownerA: SeededUser;
  let ownerB: SeededUser;
  let delegateA: SeededUser;

  beforeAll(async () => {
    ownerA = await seedUser(db, { displayName: 'Owner A', gender: 'female' });
    ownerB = await seedUser(db, { displayName: 'Owner B', gender: 'male' });
    delegateA = await seedUser(db, { displayName: 'Delegate A', gender: 'male' });

    for (const owner of [ownerA, ownerB]) {
      await db.admin(
        `update public.user_settings set communication_policy = 'family_reviewed'
          where user_id = $1::uuid`,
        [owner.userId],
      );
    }

    const match = await matchOf(ownerB, ownerA);
    expect(match.state).toBe('pending_family_review');
    matchId = match.matchId;

    for (const owner of [ownerA, ownerB]) {
      await db.admin(
        `insert into public.family_reviews (match_id, owner_user_id) values ($1::uuid, $2::uuid)`,
        [matchId, owner.userId],
      );
    }
  });

  it('refuses family_approved while the other side has REJECTED — the reported order', async () => {
    // Family B rejects first; the match closes. A decided review must name
    // the relationship that decided it (family_reviews_decided_consistent).
    const rel = await db.admin<{ id: string }>(
      `insert into public.family_relationships
         (owner_user_id, delegate_user_id, relationship_code, tier)
       values ($1::uuid, $2::uuid, 'father', 'reviewer') returning id`,
      [ownerB.userId, delegateA.userId],
    );
    await db.admin(
      `update public.family_reviews set decision = 'rejected', decided_at = now(),
              decided_by_user_id = $2::uuid, relationship_id = $3::uuid
        where match_id = $1::uuid and owner_user_id = $4::uuid`,
      [matchId, delegateA.userId, rel[0]!.id, ownerB.userId],
    );
    await db.admin(
      `update public.matches set communication_state = 'family_rejected' where id = $1::uuid`,
      [matchId],
    );

    // Family A approves later. Their review row becomes approved — but the
    // match must not move, because B's rejection is still on the record.
    await db.admin(
      `update public.family_reviews set decision = 'approved', decided_at = now(),
              decided_by_user_id = $2::uuid, relationship_id = $3::uuid
        where match_id = $1::uuid and owner_user_id = $4::uuid`,
      [matchId, delegateA.userId, rel[0]!.id, ownerA.userId],
    );

    await expect(
      db.admin(
        `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
        [matchId],
      ),
    ).rejects.toThrow(/every family review for this match to be approved/);

    const state = await db.admin<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [matchId],
    );
    expect(state[0]!.communication_state).toBe('family_rejected');
  });

  it('refuses family_approved while the other side is merely PENDING', async () => {
    const owner = await seedUser(db, { displayName: 'Pending Owner', gender: 'female' });
    const other = await seedUser(db, { displayName: 'Pending Other', gender: 'male' });
    await db.admin(
      `update public.user_settings set communication_policy = 'family_reviewed'
        where user_id = $1::uuid`,
      [owner.userId],
    );
    const match = await matchOf(other, owner);
    await db.admin(
      `insert into public.family_reviews (match_id, owner_user_id) values ($1::uuid, $2::uuid)`,
      [match.matchId, owner.userId],
    );

    await expect(
      db.admin(
        `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
        [match.matchId],
      ),
    ).rejects.toThrow(/every family review/);
  });

  it('allows family_approved once EVERY review is approved', async () => {
    const owner = await seedUser(db, { displayName: 'Approved Owner', gender: 'female' });
    const other = await seedUser(db, { displayName: 'Approved Other', gender: 'male' });
    const delegate = await seedUser(db, { displayName: 'Approved Delegate', gender: 'male' });
    await db.admin(
      `update public.user_settings set communication_policy = 'family_reviewed'
        where user_id = $1::uuid`,
      [owner.userId],
    );
    const match = await matchOf(other, owner);
    const rel = await db.admin<{ id: string }>(
      `insert into public.family_relationships
         (owner_user_id, delegate_user_id, relationship_code, tier)
       values ($1::uuid, $2::uuid, 'mother', 'reviewer') returning id`,
      [owner.userId, delegate.userId],
    );
    await db.admin(
      `insert into public.family_reviews
         (match_id, owner_user_id, decision, decided_at, decided_by_user_id, relationship_id)
       values ($1::uuid, $2::uuid, 'approved', now(), $3::uuid, $4::uuid)`,
      [match.matchId, owner.userId, delegate.userId, rel[0]!.id],
    );

    await db.admin(
      `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
      [match.matchId],
    );
    const state = await db.admin<{ communication_state: string }>(
      `select communication_state from public.matches where id = $1::uuid`,
      [match.matchId],
    );
    expect(state[0]!.communication_state).toBe('family_approved');
  });

  it('leaves every OTHER transition alone — revocation, blocking, rejection', async () => {
    // The guard only acts on entry into family_approved. Closing a match must
    // never be refused by a rule written to stop one opening.
    for (const state of ['revoked', 'blocked', 'family_rejected']) {
      await db.admin(`update public.matches set communication_state = $2 where id = $1::uuid`, [
        matchId,
        state,
      ]);
      const row = await db.admin<{ communication_state: string }>(
        `select communication_state from public.matches where id = $1::uuid`,
        [matchId],
      );
      expect(row[0]!.communication_state).toBe(state);
    }
  });

  it('does not affect an ungated match, which has no reviews at all', async () => {
    const a = await seedUser(db, { displayName: 'Ungated A', gender: 'female' });
    const b = await seedUser(db, { displayName: 'Ungated B', gender: 'male' });
    const match = await matchOf(b, a);
    expect(match.state).toBe('open');

    await db.admin(
      `update public.matches set communication_state = 'family_approved' where id = $1::uuid`,
      [match.matchId],
    );
  });
});

// =============================================================================
// B3
// =============================================================================

describe('B3 — incognito is a paid entitlement, enforced in the database', () => {
  it('refuses a FREE member switching incognito on, even through the Data API', async () => {
    const free = await seedUser(db, { displayName: 'Free Member', gender: 'female' });
    await expect(
      db.as(
        'api_member',
        free.authUserId,
        `update public.user_settings set incognito = true returning incognito`,
      ),
    ).rejects.toThrow(/incognito requires the incognito entitlement/);
  });

  it('allows it with the entitlement', async () => {
    const paid = await seedUser(db, { displayName: 'Paid Member', gender: 'female' });
    await grantIncognito(paid);
    const rows = await db.as<{ incognito: boolean }>(
      'api_member',
      paid.authUserId,
      `update public.user_settings set incognito = true returning incognito`,
    );
    expect(rows[0]!.incognito).toBe(true);
  });

  it('refuses an EXPIRED entitlement', async () => {
    const lapsed = await seedUser(db, { displayName: 'Lapsed Member', gender: 'female' });
    await grantIncognito(lapsed, '2020-01-01T00:00:00Z');
    await expect(
      db.as(
        'api_member',
        lapsed.authUserId,
        `update public.user_settings set incognito = true returning incognito`,
      ),
    ).rejects.toThrow(/incognito requires/);
  });

  it('refuses a wrongly shaped value, as loadEntitlements() does', async () => {
    const odd = await seedUser(db, { displayName: 'Odd Member', gender: 'female' });
    await db.admin(
      `insert into public.user_entitlements (user_id, entitlement_key, value)
       values ($1::uuid, 'incognito', '1'::jsonb)`,
      [odd.userId],
    );
    await expect(
      db.as(
        'api_member',
        odd.authUserId,
        `update public.user_settings set incognito = true returning incognito`,
      ),
    ).rejects.toThrow(/incognito requires/);
  });

  it('ALWAYS allows switching it off, so a lapsed member is never trapped', async () => {
    const trapped = await seedUser(db, { displayName: 'Trapped Member', gender: 'female' });
    // Got into incognito somehow before 0026 existed.
    await db.admin(
      `alter table public.user_settings disable trigger user_settings_guard_incognito`,
    );
    await db.admin(`update public.user_settings set incognito = true where user_id = $1::uuid`, [
      trapped.userId,
    ]);
    await db.admin(`alter table public.user_settings enable trigger user_settings_guard_incognito`);

    const rows = await db.as<{ incognito: boolean }>(
      'api_member',
      trapped.authUserId,
      `update public.user_settings set incognito = false returning incognito`,
    );
    expect(rows[0]!.incognito).toBe(false);
  });
});

describe('B3 — app.discoverable_to hides paused and incognito members from DISCOVERY only', () => {
  let viewer: SeededUser;
  let target: SeededUser;

  beforeAll(async () => {
    viewer = await member('Discovery Viewer', 'male');
    target = await member('Discovery Target', 'female');
  });

  it('is true for an ordinary visible member', async () => {
    expect(await viewable(viewer, target)).toBe(true);
    expect(await discoverable(viewer, target)).toBe(true);
  });

  it('hides a PAUSED member from discovery while leaving them viewable', async () => {
    await db.admin(
      `update public.user_settings set discovery_paused = true where user_id = $1::uuid`,
      [target.userId],
    );

    expect(await discoverable(viewer, target)).toBe(false);
    // The relationship predicate is untouched: an existing match or interest
    // with this member keeps working. Pausing hides you from browsing; it
    // does not unmake relationships you already have.
    expect(await viewable(viewer, target)).toBe(true);

    await db.admin(
      `update public.user_settings set discovery_paused = false where user_id = $1::uuid`,
      [target.userId],
    );
    expect(await discoverable(viewer, target)).toBe(true);
  });

  it('hides an incognito member from everyone they have not expressed interest in', async () => {
    await grantIncognito(target);
    await db.admin(`update public.user_settings set incognito = true where user_id = $1::uuid`, [
      target.userId,
    ]);

    expect(await discoverable(viewer, target)).toBe(false);
    expect(await viewable(viewer, target)).toBe(true);
  });

  it('shows them to a member they HAVE expressed interest in', async () => {
    await db.admin(
      `insert into public.interests (sender_user_id, recipient_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );
    expect(await discoverable(viewer, target)).toBe(true);
  });

  it('does not count interest flowing the OTHER way', async () => {
    // A stranger expressing interest in an incognito member does not earn
    // the right to find them. Only the incognito member's own like counts.
    const admirer = await member('Admirer', 'male');
    await db.admin(
      `insert into public.interests (sender_user_id, recipient_user_id) values ($1::uuid, $2::uuid)`,
      [admirer.userId, target.userId],
    );
    expect(await discoverable(admirer, target)).toBe(false);
  });

  it('hides them again once the interest is withdrawn', async () => {
    await db.admin(
      `update public.interests set status = 'withdrawn'
        where sender_user_id = $1::uuid and recipient_user_id = $2::uuid`,
      [target.userId, viewer.userId],
    );
    expect(await discoverable(viewer, target)).toBe(false);
  });

  it('makes them visible again when the entitlement lapses', async () => {
    // The protection IS the paid feature. Continuing to provide it unpaid
    // would be the bug, so a lapsed subscription means visible.
    await grantIncognito(target, '2020-01-01T00:00:00Z');
    expect(await discoverable(viewer, target)).toBe(true);
  });

  it('still respects everything can_view_profile already refuses', async () => {
    const blocked = await member('Blocked Target', 'female');
    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [blocked.userId, viewer.userId],
    );
    expect(await viewable(viewer, blocked)).toBe(false);
    expect(await discoverable(viewer, blocked)).toBe(false);
  });
});

// =============================================================================
// B7
// =============================================================================

describe('B7 — the Data API cannot post system messages or blank ones', () => {
  let alice: SeededUser;
  let bilal: SeededUser;
  let conversationId: string;

  beforeAll(async () => {
    alice = await seedUser(db, { displayName: 'Chat Alice', gender: 'female' });
    bilal = await seedUser(db, { displayName: 'Chat Bilal', gender: 'male' });
    const match = await matchOf(bilal, alice);
    expect(match.state).toBe('open');
    const rows = await db.admin<{ id: string }>(
      `select id from public.conversations where match_id = $1::uuid`,
      [match.matchId],
    );
    conversationId = rows[0]!.id;
  });

  const send = (who: SeededUser, sql: string, params: unknown[]) =>
    db.as('api_member', who.authUserId, sql, params);

  it('still lets a participant send ordinary text', async () => {
    const rows = await send(
      alice,
      `insert into public.messages (conversation_id, sender_user_id, body)
       values ($1::uuid, app.current_user_id(), 'Assalamu alaikum.') returning kind`,
      [conversationId],
    );
    expect(rows).toEqual([{ kind: 'text' }]);
  });

  it('refuses a member naming kind at all — so no fake system notice', async () => {
    await expect(
      send(
        alice,
        `insert into public.messages (conversation_id, sender_user_id, body, kind)
         values ($1::uuid, app.current_user_id(), 'Your account is suspended.', 'system')`,
        [conversationId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses kind = voice from a member too', async () => {
    await expect(
      send(
        alice,
        `insert into public.messages (conversation_id, sender_user_id, body, kind)
         values ($1::uuid, app.current_user_id(), 'x', 'voice')`,
        [conversationId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a whitespace-only body from a member', async () => {
    await expect(
      send(
        alice,
        `insert into public.messages (conversation_id, sender_user_id, body)
         values ($1::uuid, app.current_user_id(), '   ')`,
        [conversationId],
      ),
    ).rejects.toThrow(/row-level security|messages_body_not_blank/i);
  });

  it('refuses a blank body from EVERY role, the service role included', async () => {
    await expect(
      db.admin(
        `insert into public.messages (conversation_id, sender_user_id, body, kind)
         values ($1::uuid, $2::uuid, E'\\t \\n', 'system')`,
        [conversationId, bilal.userId],
      ),
    ).rejects.toThrow(/messages_body_not_blank/);
  });

  it('still lets the server write a genuine system message', async () => {
    // The column grant and the policy are about MEMBERS. A platform notice
    // written by the service role is legitimate and must keep working.
    const rows = await db.admin<{ kind: string }>(
      `insert into public.messages (conversation_id, sender_user_id, body, kind)
       values ($1::uuid, $2::uuid, 'This conversation moved to stage 2.', 'system')
       returning kind`,
      [conversationId, bilal.userId],
    );
    expect(rows[0]!.kind).toBe('system');
  });
});

// =============================================================================
// B4
// =============================================================================

describe('B4 — a deferred interest can be withdrawn, and the rule stays strict elsewhere', () => {
  let sender: SeededUser;
  let recipient: SeededUser;

  beforeAll(async () => {
    sender = await seedUser(db, { displayName: 'B4 Sender', gender: 'male' });
    recipient = await seedUser(db, { displayName: 'B4 Recipient', gender: 'female' });
  });

  it('allows withdrawing a DEFERRED interest and keeps when it was deferred', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
       values ($1::uuid, $2::uuid, 'maybe_later', timestamptz '2026-10-30 10:00+00')
       returning id`,
      [sender.userId, recipient.userId],
    );
    await db.admin(`update public.interests set status = 'withdrawn' where id = $1::uuid`, [
      rows[0]!.id,
    ]);
    const after = await db.admin<{ status: string; responded_at: string | null }>(
      `select status, responded_at from public.interests where id = $1::uuid`,
      [rows[0]!.id],
    );
    expect(after[0]!.status).toBe('withdrawn');
    // The deferral is a true fact about the row and survives the withdrawal.
    expect(after[0]!.responded_at).not.toBeNull();
  });

  it('still refuses a PENDING interest that claims a response time', async () => {
    await expect(
      db.admin(
        `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
         values ($1::uuid, $2::uuid, 'pending', now())`,
        [recipient.userId, sender.userId],
      ),
    ).rejects.toThrow(/interests_responded_consistent/);
  });

  it('still refuses an ANSWERED interest with no response time', async () => {
    for (const status of ['accepted', 'declined', 'maybe_later']) {
      const a = await seedUser(db, { displayName: `B4 ${status} A`, gender: 'male' });
      const b = await seedUser(db, { displayName: `B4 ${status} B`, gender: 'female' });
      await expect(
        db.admin(
          `insert into public.interests (sender_user_id, recipient_user_id, status)
           values ($1::uuid, $2::uuid, $3)`,
          [a.userId, b.userId, status],
        ),
      ).rejects.toThrow(/interests_responded_consistent/);
    }
  });
});
