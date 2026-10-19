import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Family Safety — the policy boundary, independent of the route (ADR 0011).
 *
 * The API enforces phase-gated grants, invitation expiry and one-review-per-
 * side, and that is where those rules belong. This suite asks the narrower
 * question a route cannot answer about itself: reaching these tables directly
 * through the Data API, what can a delegate, an owner, a counterpart and a
 * stranger each actually do?
 *
 * Four answers carry the safety model, and each has a test below:
 *
 *   1. A delegate's sight is an INTERSECTION with their grants, never a union.
 *      Revoking the relationship or clearing one grant closes the door on the
 *      next query — not on the next login.
 *   2. There is NO DIRECTORY. `can_review_match()` takes one match and returns
 *      a boolean. No question in this schema takes a delegate and returns a
 *      set of people, so `approve_communication` can never be turned into a
 *      list of counterparts to browse.
 *   3. The OWNER CANNOT APPROVE THEIR OWN MATCH (D12 row 2). Enforced twice —
 *      by a check constraint and by the predicate — because that asymmetry is
 *      the only thing that makes an approval worth anything.
 *   4. The COUNTERPART learns that a review is pending and never who is
 *      reviewing or what they wrote.
 */

let db: TestDb;

let owner: SeededUser;
let delegate: SeededUser;
let counterpart: SeededUser;
let stranger: SeededUser;

let relationshipId: string;
let matchId: string;

/** Grants a permission on the seeded relationship. */
async function grant(permission: string): Promise<void> {
  await db.admin(
    `insert into public.family_permissions
       (relationship_id, permission, granted_by_user_id)
     values ($1::uuid, $2, $3::uuid)
     on conflict (relationship_id, permission) do update set granted = true`,
    [relationshipId, permission, owner.userId],
  );
}

/** Clears a permission without deleting the row — the revoke path. */
async function ungrant(permission: string): Promise<void> {
  await db.admin(
    `update public.family_permissions set granted = false
     where relationship_id = $1::uuid and permission = $2`,
    [relationshipId, permission],
  );
}

async function familyGrant(
  delegateUserId: string,
  ownerUserId: string,
  permission: string,
): Promise<boolean> {
  const rows = await db.admin<{ ok: boolean }>(
    `select app.family_grant($1::uuid, $2::uuid, $3) as ok`,
    [delegateUserId, ownerUserId, permission],
  );
  return rows[0]!.ok;
}

async function canReview(delegateUserId: string, match: string): Promise<boolean> {
  const rows = await db.admin<{ ok: boolean }>(
    `select app.can_review_match($1::uuid, $2::uuid) as ok`,
    [delegateUserId, match],
  );
  return rows[0]!.ok;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  owner = await seedUser(db, { displayName: 'Owner', gender: 'female' });
  delegate = await seedUser(db, { displayName: 'Delegate', gender: 'male' });
  counterpart = await seedUser(db, { displayName: 'Counterpart', gender: 'male' });
  stranger = await seedUser(db, { displayName: 'Stranger', gender: 'female' });

  const rel = await db.admin<{ id: string }>(
    `insert into public.family_relationships
       (owner_user_id, delegate_user_id, relationship_code, tier)
     values ($1::uuid, $2::uuid, 'father', 'reviewer')
     returning id`,
    [owner.userId, delegate.userId],
  );
  relationshipId = rel[0]!.id;

  await grant('view_profile');
  await grant('approve_communication');

  // THE OWNER OPTS IN FIRST. `gate_new_match_period()` (migration 0021) sets
  // `communication_state` at the birth of a match period from the two sides'
  // policies, so a state written directly into the insert is overwritten. This
  // is the real path: a gated match exists because someone chose review.
  await db.admin(
    `update public.user_settings set communication_policy = 'family_reviewed'
     where user_id = $1::uuid`,
    [owner.userId],
  );

  // A match needs an interest to point at.
  const interest = await db.admin<{ id: string }>(
    `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
     values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
    [counterpart.userId, owner.userId],
  );

  const [a, b] = [owner.userId, counterpart.userId].sort();
  const match = await db.admin<{ id: string; communication_state: string }>(
    `insert into public.matches (user_a_id, user_b_id, interest_id)
     values ($1::uuid, $2::uuid, $3::uuid)
     returning id, communication_state`,
    [a, b, interest[0]!.id],
  );
  matchId = match[0]!.id;

  // The gate did its job, or nothing below is testing what it claims to.
  if (match[0]!.communication_state !== 'pending_family_review') {
    throw new Error(
      `seed: expected the gate to produce pending_family_review, got ` +
        `${match[0]!.communication_state}`,
    );
  }

  await db.admin(
    `insert into public.family_reviews (match_id, owner_user_id) values ($1::uuid, $2::uuid)`,
    [matchId, owner.userId],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('app.family_grant — the single authority', () => {
  it('is true only for a granted permission on an active relationship', async () => {
    expect(await familyGrant(delegate.userId, owner.userId, 'approve_communication')).toBe(true);
    expect(await familyGrant(delegate.userId, owner.userId, 'view_profile')).toBe(true);
  });

  it('is false for a permission that was never granted', async () => {
    // `tier` is 'reviewer', whose preset would include this. The tier is NOT
    // consulted — only the rows are — so the answer is no.
    expect(await familyGrant(delegate.userId, owner.userId, 'report_on_behalf')).toBe(false);
  });

  it('is false for a stranger holding no relationship', async () => {
    expect(await familyGrant(stranger.userId, owner.userId, 'approve_communication')).toBe(false);
  });

  it('is false in the WRONG DIRECTION — a grant is not reciprocal', async () => {
    // The owner does not become a delegate of their own delegate.
    expect(await familyGrant(owner.userId, delegate.userId, 'approve_communication')).toBe(false);
  });

  it('is scoped to ONE owner — a delegate for two people holds two grant sets', async () => {
    const other = await seedUser(db, { displayName: 'Other Owner', gender: 'female' });
    expect(await familyGrant(delegate.userId, other.userId, 'approve_communication')).toBe(false);
  });

  it('goes false the moment a grant is cleared, not at the next login', async () => {
    await ungrant('view_profile');
    expect(await familyGrant(delegate.userId, owner.userId, 'view_profile')).toBe(false);
    await grant('view_profile');
    expect(await familyGrant(delegate.userId, owner.userId, 'view_profile')).toBe(true);
  });

  it('goes false for EVERY permission when the relationship is revoked', async () => {
    await db.admin(
      `update public.family_relationships
       set status = 'revoked', revoked_at = now() where id = $1::uuid`,
      [relationshipId],
    );

    expect(await familyGrant(delegate.userId, owner.userId, 'approve_communication')).toBe(false);
    expect(await familyGrant(delegate.userId, owner.userId, 'view_profile')).toBe(false);
    // And the match-scoped predicate follows it down.
    expect(await canReview(delegate.userId, matchId)).toBe(false);

    await db.admin(
      `update public.family_relationships
       set status = 'active', revoked_at = null where id = $1::uuid`,
      [relationshipId],
    );
    expect(await canReview(delegate.userId, matchId)).toBe(true);
  });
});

describe('app.can_review_match — match-scoped, and that is the control', () => {
  it('lets a granted delegate review THIS match', async () => {
    expect(await canReview(delegate.userId, matchId)).toBe(true);
  });

  it('refuses a stranger', async () => {
    expect(await canReview(stranger.userId, matchId)).toBe(false);
  });

  it('refuses the COUNTERPART, who is nobody here', async () => {
    expect(await canReview(counterpart.userId, matchId)).toBe(false);
  });

  it('refuses a delegate who holds view_profile but not approve_communication', async () => {
    const viewer = await seedUser(db, { displayName: 'Observer', gender: 'male' });
    const rel = await db.admin<{ id: string }>(
      `insert into public.family_relationships
         (owner_user_id, delegate_user_id, relationship_code, tier)
       values ($1::uuid, $2::uuid, 'brother', 'observer') returning id`,
      [owner.userId, viewer.userId],
    );
    await db.admin(
      `insert into public.family_permissions (relationship_id, permission, granted_by_user_id)
       values ($1::uuid, 'view_profile', $2::uuid)`,
      [rel[0]!.id, owner.userId],
    );

    expect(await familyGrant(viewer.userId, owner.userId, 'view_profile')).toBe(true);
    expect(await canReview(viewer.userId, matchId)).toBe(false);
  });

  it('refuses once the match has ENDED', async () => {
    await db.admin(
      `update public.matches set ended_at = now(), ended_by_user_id = $2::uuid
       where id = $1::uuid`,
      [matchId, owner.userId],
    );
    expect(await canReview(delegate.userId, matchId)).toBe(false);

    await db.admin(
      `update public.matches set ended_at = null, ended_by_user_id = null where id = $1::uuid`,
      [matchId],
    );
    expect(await canReview(delegate.userId, matchId)).toBe(true);
  });

  it('refuses a match the delegate has no side of', async () => {
    const [p, q] = [stranger.userId, counterpart.userId].sort();
    const interest = await db.admin<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
       values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
      [stranger.userId, counterpart.userId],
    );
    const other = await db.admin<{ id: string }>(
      `insert into public.matches (user_a_id, user_b_id, interest_id)
       values ($1::uuid, $2::uuid, $3::uuid) returning id`,
      [p, q, interest[0]!.id],
    );

    expect(await canReview(delegate.userId, other[0]!.id)).toBe(false);
  });

  it('CANNOT BE TURNED INTO A DIRECTORY', async () => {
    // The whole prohibition, stated as a query. There is no form of this
    // question that yields people: the predicate takes one match id and
    // returns a boolean, so a delegate holding `approve_communication` can
    // confirm a specific pairing and can never enumerate counterparts.
    //
    // Proved by the only route that could leak a set — reading `matches`
    // directly as the delegate. The delegate is not a participant, so RLS
    // returns nothing even though they may review this very match.
    const rows = await db.as('authenticated', delegate.authUserId, `select id from public.matches`);
    expect(rows).toEqual([]);

    // And `users` yields only themselves — never the counterpart they review.
    const people = await db.as('authenticated', delegate.authUserId, `select id from public.users`);
    expect(people.map((r) => (r as { id: string }).id)).toEqual([delegate.userId]);
  });
});

describe('family_reviews — who may read the decision', () => {
  it('lets the OWNER read their own review', async () => {
    const rows = await db.as(
      'authenticated',
      owner.authUserId,
      `select id from public.family_reviews`,
    );
    expect(rows).toHaveLength(1);
  });

  it('lets a delegate holding approve_communication read it', async () => {
    const rows = await db.as(
      'authenticated',
      delegate.authUserId,
      `select id from public.family_reviews`,
    );
    expect(rows).toHaveLength(1);
  });

  it('shows the COUNTERPART nothing — not who reviews, not what they wrote', async () => {
    // They learn a review is pending from `matches.communication_state`,
    // which they can already see. They never learn more than that.
    const rows = await db.as(
      'authenticated',
      counterpart.authUserId,
      `select id from public.family_reviews`,
    );
    expect(rows).toEqual([]);
  });

  it('shows a stranger nothing', async () => {
    const rows = await db.as(
      'authenticated',
      stranger.authUserId,
      `select id from public.family_reviews`,
    );
    expect(rows).toEqual([]);
  });

  it('stops showing a delegate once their grant is cleared', async () => {
    await ungrant('approve_communication');
    const rows = await db.as(
      'authenticated',
      delegate.authUserId,
      `select id from public.family_reviews`,
    );
    expect(rows).toEqual([]);
    await grant('approve_communication');
  });

  it('refuses a member INSERT, UPDATE and DELETE', async () => {
    await expect(
      db.as(
        'authenticated',
        delegate.authUserId,
        `update public.family_reviews set decision = 'approved' where match_id = $1::uuid`,
        [matchId],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.as(
        'authenticated',
        owner.authUserId,
        `insert into public.family_reviews (match_id, owner_user_id)
         values ($1::uuid, $2::uuid)`,
        [matchId, owner.userId],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.as('authenticated', owner.authUserId, `delete from public.family_reviews`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('D12 row 2 — the owner can never approve their own match', () => {
  it('refuses a review decided by the owner, at the database', async () => {
    await expect(
      db.admin(
        `update public.family_reviews
         set decision = 'approved', decided_at = now(),
             decided_by_user_id = $2::uuid, relationship_id = $3::uuid
         where match_id = $1::uuid`,
        [matchId, owner.userId, relationshipId],
      ),
    ).rejects.toThrow(/family_reviews_decider_not_owner/i);
  });

  it('refuses a relationship where the owner is their own delegate', async () => {
    // The route forbids it; so does the table. Without this an owner could
    // grant themselves `approve_communication` and decide their own review.
    await expect(
      db.admin(
        `insert into public.family_relationships
           (owner_user_id, delegate_user_id, relationship_code, tier)
         values ($1::uuid, $1::uuid, 'other', 'reviewer')`,
        [owner.userId],
      ),
    ).rejects.toThrow(/family_relationships_not_self/i);
  });

  it('accepts the same decision from the delegate', async () => {
    await db.admin(
      `update public.family_reviews
       set decision = 'approved', decided_at = now(),
           decided_by_user_id = $2::uuid, relationship_id = $3::uuid
       where match_id = $1::uuid`,
      [matchId, delegate.userId, relationshipId],
    );

    const rows = await db.admin<{ decision: string }>(
      `select decision from public.family_reviews where match_id = $1::uuid`,
      [matchId],
    );
    expect(rows[0]!.decision).toBe('approved');

    await db.admin(
      `update public.family_reviews
       set decision = 'pending', decided_at = null,
           decided_by_user_id = null, relationship_id = null
       where match_id = $1::uuid`,
      [matchId],
    );
  });
});

describe('D12 row 4 — one review per side, first decision stands', () => {
  it('refuses a second review row for the same side', async () => {
    await expect(
      db.admin(
        `insert into public.family_reviews (match_id, owner_user_id)
         values ($1::uuid, $2::uuid)`,
        [matchId, owner.userId],
      ),
    ).rejects.toThrow(/family_reviews_side_key|duplicate key/i);
  });

  it('allows the OTHER side its own review row', async () => {
    // A match where both sides require review has two rows, and both must
    // approve. That is D12 row 3 in its strictest reading.
    await db.admin(
      `insert into public.family_reviews (match_id, owner_user_id)
       values ($1::uuid, $2::uuid)`,
      [matchId, counterpart.userId],
    );

    const rows = await db.admin<{ n: number }>(
      `select count(*)::int as n from public.family_reviews where match_id = $1::uuid`,
      [matchId],
    );
    expect(rows[0]!.n).toBe(2);

    await db.admin(`delete from public.family_reviews where owner_user_id = $1::uuid`, [
      counterpart.userId,
    ]);
  });
});

describe('D12-g — a stalled review notifies and keeps waiting', () => {
  it('has no "expired" decision to fall into', async () => {
    // Silence must not become consent, so there is no value that silence
    // could be recorded as. TWO constraints refuse it and either is a correct
    // answer: `decided_consistent` is evaluated first because 'expired'
    // matches neither of its branches, and `decision_valid` would refuse it
    // anyway. The point is that the value cannot be written, not which guard
    // happens to speak first.
    await expect(
      db.admin(`update public.family_reviews set decision = 'expired' where match_id = $1::uuid`, [
        matchId,
      ]),
    ).rejects.toThrow(/family_reviews_decision_valid|family_reviews_decided_consistent/i);
  });

  it('keeps more_info_requested on the PENDING side of the gate', async () => {
    // ERD §12: it notifies the owner and resets nothing. A third outcome that
    // silently behaved like approval would be the worst possible default.
    await db.admin(
      `update public.family_reviews set decision = 'more_info_requested'
       where match_id = $1::uuid`,
      [matchId],
    );

    const rows = await db.admin<{ decided_at: string | null; state: string }>(
      `select r.decided_at, m.communication_state as state
       from public.family_reviews r join public.matches m on m.id = r.match_id
       where r.match_id = $1::uuid and r.owner_user_id = $2::uuid`,
      [matchId, owner.userId],
    );
    expect(rows[0]!.decided_at).toBeNull();
    expect(rows[0]!.state).toBe('pending_family_review');

    await db.admin(
      `update public.family_reviews set decision = 'pending' where match_id = $1::uuid`,
      [matchId],
    );
  });

  it('fires the SLA warning once, by recording when it was sent', async () => {
    const stale = `select id from public.family_reviews
                   where decision in ('pending', 'more_info_requested')
                     and sla_notified_at is null
                     and requested_at < now() - interval '72 hours'`;

    expect(await db.admin(stale)).toEqual([]);

    await db.admin(
      `update public.family_reviews set requested_at = now() - interval '73 hours'
       where match_id = $1::uuid`,
      [matchId],
    );
    expect(await db.admin(stale)).toHaveLength(1);

    await db.admin(
      `update public.family_reviews set sla_notified_at = now() where match_id = $1::uuid`,
      [matchId],
    );
    expect(await db.admin(stale)).toEqual([]);

    await db.admin(
      `update public.family_reviews
       set requested_at = now(), sla_notified_at = null where match_id = $1::uuid`,
      [matchId],
    );
  });
});

describe('family_access_log — the anti-coercion control', () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.family_access_log
         (relationship_id, delegate_user_id, owner_user_id, action, permission,
          resource_type, resource_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'review.open', 'approve_communication',
               'review', $4::uuid)`,
      [relationshipId, delegate.userId, owner.userId, matchId],
    );
  });

  it('shows the OWNER every action taken in their name', async () => {
    const rows = await db.as(
      'authenticated',
      owner.authUserId,
      `select action, permission from public.family_access_log`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'review.open',
      permission: 'approve_communication',
    });
  });

  it('shows the DELEGATE nothing', async () => {
    // A delegate who could see what the owner has been shown would know what
    // is safe to do unobserved, which inverts the control.
    const rows = await db.as(
      'authenticated',
      delegate.authUserId,
      `select id from public.family_access_log`,
    );
    expect(rows).toEqual([]);
  });

  it('refuses every member write — an audit a delegate can edit is not an audit', async () => {
    await expect(
      db.as(
        'authenticated',
        delegate.authUserId,
        `insert into public.family_access_log
           (relationship_id, delegate_user_id, owner_user_id, action, permission)
         values ($1::uuid, $2::uuid, $3::uuid, 'forged', 'view_profile')`,
        [relationshipId, delegate.userId, owner.userId],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.as('authenticated', owner.authUserId, `delete from public.family_access_log`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('family_invitations — a token is never readable', () => {
  let inviteId: string;

  beforeAll(async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.family_invitations
         (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at)
       values ($1::uuid, 'uncle@example.com', 'guardian', 'observer',
               repeat('a', 64), now() + interval '14 days')
       returning id`,
      [owner.userId],
    );
    inviteId = rows[0]!.id;
  });

  it('refuses a token that is not a hash', async () => {
    await expect(
      db.admin(
        `insert into public.family_invitations
           (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at)
         values ($1::uuid, 'aunt@example.com', 'other', 'observer',
                 'plaintext-token', now() + interval '14 days')`,
        [owner.userId],
      ),
    ).rejects.toThrow(/family_invitations_token_hashed/i);
  });

  it('shows the inviter their own invitations', async () => {
    const rows = await db.as(
      'authenticated',
      owner.authUserId,
      `select id from public.family_invitations`,
    );
    expect(rows.map((r) => (r as { id: string }).id)).toContain(inviteId);
  });

  it('shows nobody else anything, including the named invitee', async () => {
    // There is deliberately no policy matching `invitee_contact`: one would
    // turn this table into a lookup of who has been invited into whose
    // family, for anyone who can guess an address. The invitee arrives by
    // token, through the API.
    for (const who of [delegate, counterpart, stranger]) {
      const rows = await db.as(
        'authenticated',
        who.authUserId,
        `select id from public.family_invitations`,
      );
      expect(rows).toEqual([]);
    }
  });

  it('allows a re-invitation only after the first is no longer pending', async () => {
    await expect(
      db.admin(
        `insert into public.family_invitations
           (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at)
         values ($1::uuid, 'uncle@example.com', 'guardian', 'observer',
                 repeat('b', 64), now() + interval '14 days')`,
        [owner.userId],
      ),
    ).rejects.toThrow(/family_invitations_one_pending|duplicate key/i);

    await db.admin(
      `update public.family_invitations
       set status = 'declined', responded_at = now() where id = $1::uuid`,
      [inviteId],
    );

    // Someone who declined a year ago may legitimately be asked again.
    await db.admin(
      `insert into public.family_invitations
         (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at)
       values ($1::uuid, 'uncle@example.com', 'guardian', 'observer',
               repeat('b', 64), now() + interval '14 days')`,
      [owner.userId],
    );
  });
});

describe('family_relationships and permissions — the member surface is read-only', () => {
  it('shows both parties the relationship', async () => {
    for (const who of [owner, delegate]) {
      const rows = await db.as(
        'authenticated',
        who.authUserId,
        `select id from public.family_relationships where id = $1::uuid`,
        [relationshipId],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it('shows an outsider neither the relationship nor its grants', async () => {
    for (const who of [counterpart, stranger]) {
      expect(
        await db.as(
          'authenticated',
          who.authUserId,
          `select id from public.family_relationships where id = $1::uuid`,
          [relationshipId],
        ),
      ).toEqual([]);

      expect(
        await db.as(
          'authenticated',
          who.authUserId,
          `select id from public.family_permissions where relationship_id = $1::uuid`,
          [relationshipId],
        ),
      ).toEqual([]);
    }
  });

  it('refuses a delegate granting themselves a permission', async () => {
    await expect(
      db.as(
        'authenticated',
        delegate.authUserId,
        `insert into public.family_permissions (relationship_id, permission, granted_by_user_id)
         values ($1::uuid, 'report_on_behalf', $2::uuid)`,
        [relationshipId, delegate.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a delegate un-revoking themselves', async () => {
    await expect(
      db.as(
        'authenticated',
        delegate.authUserId,
        `update public.family_relationships set status = 'active' where id = $1::uuid`,
        [relationshipId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('pins tier to the two whose authorization logic exists', async () => {
    // `participant` (M2) and `manager` (1.1) are relaxed in by the migration
    // that can enforce them. A bug must not grant rights nobody has written
    // the checks for yet.
    await expect(
      db.admin(
        `insert into public.family_relationships
           (owner_user_id, delegate_user_id, relationship_code, tier)
         values ($1::uuid, $2::uuid, 'other', 'manager')`,
        [owner.userId, stranger.userId],
      ),
    ).rejects.toThrow(/family_relationships_tier_valid/i);
  });
});

describe('system_flags — the switched-off path', () => {
  it('ships direct 1:1 calling OFF, present and refusing (D12 row 5)', async () => {
    const rows = await db.admin<{ key: string; enabled: boolean }>(
      `select key, enabled from public.system_flags order by key`,
    );
    const direct = rows.find((r) => r.key === 'calls.direct_one_to_one');
    expect(
      direct,
      'the flag must EXIST — an absent path gets rebuilt under deadline',
    ).toBeDefined();
    expect(direct!.enabled).toBe(false);
  });

  it('is invisible to every member — a flag they can read is a roadmap', async () => {
    for (const who of [owner, delegate, stranger]) {
      await expect(
        db.as('authenticated', who.authUserId, `select key from public.system_flags`),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
