import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FREE_PLAN_ENTITLEMENTS } from '@nikahmate/domain';
import {
  can,
  grantEntitlement,
  isEntitlementKey,
  loadEntitlements,
  requireEntitlement,
  revokeEntitlement,
  valueOf,
} from '../src/entitlements/service';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * The entitlement resolver, against a real database and real policies.
 *
 * `can()` is the single question feature code is allowed to ask (ADR 0005), so
 * what matters here is that it answers correctly from an empty table, from an
 * override, and from a row that should no longer count — and that it fails
 * closed every time it cannot answer.
 */

let harness: TestHarness;
let authId: string;
let userId: string;

async function bootstrap(auth: string): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/account/bootstrap',
    headers: authHeader(auth),
    payload: { locale: 'en', timezone: 'Asia/Karachi' },
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`bootstrap failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().userId as string;
}

beforeAll(async () => {
  harness = await createHarness();
  authId = randomAuthId();
  userId = await bootstrap(authId);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('a free member, with no rows at all', () => {
  it('receives exactly the free-plan defaults', async () => {
    // No backfill and no bootstrap write: an empty table IS the free plan.
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(entitlements).toEqual(FREE_PLAN_ENTITLEMENTS);
  });

  it('cannot use advanced_filters', async () => {
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'advanced_filters')).toBe(false);
  });

  it('cannot use who_viewed_me', async () => {
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'who_viewed_me')).toBe(false);
  });

  it('may send interests at all, because the free limit is above zero', async () => {
    // `can` on a limit means "any at all", not "any left". How many remain is
    // a counter, and counters are Phase 6.
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'daily_interests')).toBe(true);
    expect(valueOf(entitlements, 'daily_interests')).toBe(5);
  });
});

describe('an override', () => {
  it('turns a capability on', async () => {
    await grantEntitlement(harness.db, userId, 'advanced_filters', true);
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'advanced_filters')).toBe(true);
    // Everything else stays on the plan default.
    expect(can(entitlements, 'who_viewed_me')).toBe(false);
  });

  it('is recorded through the service role, not a member write', async () => {
    expect(harness.serviceUses).toContain('entitlement.grant');
  });

  it('can be raised above the plan default', async () => {
    await grantEntitlement(harness.db, userId, 'daily_interests', 50);
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(valueOf(entitlements, 'daily_interests')).toBe(50);
  });

  it('returns the member to the default when revoked', async () => {
    await revokeEntitlement(harness.db, userId, 'daily_interests');
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(valueOf(entitlements, 'daily_interests')).toBe(FREE_PLAN_ENTITLEMENTS.daily_interests);
  });

  it('can turn a capability explicitly OFF, below the default', async () => {
    // A restriction is an override too — the resolver must not treat a row as
    // "grant" and a missing row as "deny".
    await grantEntitlement(harness.db, userId, 'daily_interests', 0);
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'daily_interests')).toBe(false);
    await revokeEntitlement(harness.db, userId, 'daily_interests');
  });
});

describe('failing closed', () => {
  it('ignores an override that has expired', async () => {
    await grantEntitlement(harness.db, userId, 'who_viewed_me', true, {
      source: 'promo',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    // Lapsed, so it stops applying — without anything having had to delete it.
    expect(can(entitlements, 'who_viewed_me')).toBe(false);
  });

  it('honours an override that has not expired yet', async () => {
    await grantEntitlement(harness.db, userId, 'who_viewed_me', true, {
      source: 'promo',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'who_viewed_me')).toBe(true);
    await revokeEntitlement(harness.db, userId, 'who_viewed_me');
  });

  it('rejects an unknown key rather than guessing', async () => {
    const entitlements = await loadEntitlements(harness.db, authId, userId);
    expect(can(entitlements, 'not_a_real_entitlement')).toBe(false);
    expect(can(entitlements, '')).toBe(false);
    expect(isEntitlementKey('not_a_real_entitlement')).toBe(false);
    expect(isEntitlementKey('advanced_filters')).toBe(true);
  });

  it('ignores a stored value of the wrong shape', async () => {
    // The column constraint refuses this, so write it past the constraint to
    // prove the resolver does not depend on the constraint having been there
    // when the row was created.
    await harness.raw.query(
      `alter table public.user_entitlements drop constraint user_entitlements_value_shape`,
    );
    try {
      await harness.raw.query(
        `insert into public.user_entitlements (user_id, entitlement_key, value)
         values ($1::uuid, 'incognito', '"yes"'::jsonb)
         on conflict (user_id, entitlement_key) do update set value = excluded.value`,
        [userId],
      );
      const entitlements = await loadEntitlements(harness.db, authId, userId);
      expect(can(entitlements, 'incognito')).toBe(false);
    } finally {
      await harness.raw.query(
        `delete from public.user_entitlements where user_id = $1::uuid and entitlement_key = 'incognito'`,
        [userId],
      );
      await harness.raw.query(
        `alter table public.user_entitlements add constraint user_entitlements_value_shape
           check (jsonb_typeof(value) in ('boolean', 'number'))`,
      );
    }
  });

  it('reads only the caller own entitlements', async () => {
    // Another member's grant must not leak in. RLS is what enforces this; the
    // test is here because the resolver is where it would be bypassed if
    // someone reached for the service role to "simplify" the read.
    const otherAuth = randomAuthId();
    const otherId = await bootstrap(otherAuth);
    await grantEntitlement(harness.db, otherId, 'profile_boost', true);

    const mine = await loadEntitlements(harness.db, authId, userId);
    expect(can(mine, 'profile_boost')).toBe(false);

    const theirs = await loadEntitlements(harness.db, otherAuth, otherId);
    expect(can(theirs, 'profile_boost')).toBe(true);
  });
});

describe('requireEntitlement', () => {
  it('passes when the capability is held', async () => {
    await grantEntitlement(harness.db, userId, 'incognito', true);
    await expect(
      requireEntitlement(harness.db, authId, userId, 'incognito'),
    ).resolves.toBeDefined();
    await revokeEntitlement(harness.db, userId, 'incognito');
  });

  it('throws the existing entitlement_required problem, not a bare forbidden', async () => {
    // The distinction the client needs: "you may not" versus "you may not yet".
    // One is an apology, the other is an upgrade.
    await expect(
      requireEntitlement(harness.db, authId, userId, 'profile_boost'),
    ).rejects.toMatchObject({
      status: 403,
      code: 'entitlement_required',
    });
  });

  it('names the entitlement in the message, so the client can say which', async () => {
    await expect(requireEntitlement(harness.db, authId, userId, 'who_viewed_me')).rejects.toThrow(
      /who_viewed_me/,
    );
  });
});
