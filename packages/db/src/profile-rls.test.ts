import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * RLS and constraint tests for the Phase 3 tables.
 *
 * `profiles` became `shared` in migration 0011 — see visibility-rls.test.ts
 * for the cross-user half. What this file still pins is that widening SELECT
 * changed nothing else: writes stay owner-only, and a profile that has not
 * been approved is invisible to everyone but its owner, which is why the
 * negative assertions below still hold with the new policy in place.
 *
 * `user_locations` remains owner-only on purpose. `display_precision` means
 * returning a COARSER value to a stranger, not hiding a row, and RLS decides
 * rows — so the coarsened read belongs to the scoring slice and the API.
 *
 * Every positive assertion has a negative twin, because the risk (R6) is not
 * "can I see my own data" but "can I see someone else's".
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  // The codes the Phase 3 tables reference. The real seed migration provides
  // these too; inserting them here keeps this file independent of its size.
  await db.admin(`
    insert into public.reference_items (type, code)
    values ('marital_status', 'ms_never_married'),
           ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing
  `);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });

  await db.admin(
    `insert into public.profiles (user_id, about_me, marital_status_code)
     values ($1, 'Alice profile', 'ms_never_married')`,
    [alice.userId],
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('profiles', () => {
  it('lets a member read their own profile', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select about_me from public.profiles`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member read another member profile', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select about_me from public.profiles`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let an anonymous caller read any profile', async () => {
    await expect(db.as('anon', null, `select about_me from public.profiles`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lets a member create their own profile row', async () => {
    const fresh = await seedUser(db, { displayName: 'Fresh' });
    const rows = await db.as(
      'authenticated',
      fresh.authUserId,
      `insert into public.profiles (user_id, about_me) values ($1, 'mine') returning user_id`,
      [fresh.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member create a profile for someone else', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.profiles (user_id, about_me) values ($1, 'not mine')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('does NOT let a member approve their own profile', async () => {
    // review_status carries no column grant, so this is refused before RLS is
    // even consulted. A member who could write it would be discoverable
    // without ever passing review.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.profiles set review_status = 'approved'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member inflate their completion score', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `update public.profiles set completion_score = 100`),
    ).rejects.toThrow(/permission denied/);
  });

  it('does NOT let a member soft-delete their profile directly', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `update public.profiles set deleted_at = now()`),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses to leave draft without what review requires', async () => {
    // profiles_complete_for_review, enforced in the database — so an API bug
    // cannot submit an empty profile for review.
    await expect(
      db.admin(`update public.profiles set review_status = 'pending' where user_id = $1`, [
        alice.userId,
      ]),
    ).rejects.toThrow(/profiles_complete_for_review/);
  });

  it('rejects a reference code of the wrong type', async () => {
    // The composite FK from ERD E2: a country code cannot be a marital status.
    await expect(
      db.admin(`update public.profiles set marital_status_code = 'pk' where user_id = $1`, [
        alice.userId,
      ]),
    ).rejects.toThrow(/profiles_marital_status_fk/);
  });

  it('rejects children answers that contradict each other', async () => {
    await expect(
      db.admin(
        `update public.profiles set has_children = false, children_count = 3 where user_id = $1`,
        [alice.userId],
      ),
    ).rejects.toThrow(/profiles_no_children_has_no_count/);
  });
});

describe('profile_sensitive — restricted', () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.profile_sensitive (user_id, phone_e164) values ($1, '+923001234567')`,
      [alice.userId],
    );
  });

  it('is unreachable even by the member it describes', async () => {
    // Not "returns nothing" — unreachable. There is no grant and no policy,
    // which is what makes "hide my workplace" structurally true.
    await expect(
      db.as('authenticated', alice.authUserId, `select phone_e164 from public.profile_sensitive`),
    ).rejects.toThrow(/permission denied/);
  });

  it('is unreachable by an anonymous caller', async () => {
    await expect(
      db.as('anon', null, `select phone_e164 from public.profile_sensitive`),
    ).rejects.toThrow(/permission denied/);
  });

  it('is reachable by the service role', async () => {
    const rows = await db.as(
      'service_role',
      null,
      `select phone_e164 from public.profile_sensitive`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a phone number that is not E.164', async () => {
    await expect(
      db.admin(
        `update public.profile_sensitive set phone_e164 = '03001234567' where user_id = $1`,
        [alice.userId],
      ),
    ).rejects.toThrow(/phone_shape/);
  });
});

describe('partner_preferences', () => {
  beforeAll(async () => {
    await db.admin(`insert into public.partner_preferences (user_id) values ($1)`, [alice.userId]);
  });

  it('defaults exclude_unstated_sect to false — the A2 guard in the schema', async () => {
    // Someone who states a sect preference must still see profiles that left
    // it blank. Leaving a field blank must not cost a person visibility.
    const rows = await db.as<{ exclude_unstated_sect: boolean }>(
      'authenticated',
      alice.authUserId,
      `select exclude_unstated_sect from public.partner_preferences`,
    );
    expect(rows[0]?.exclude_unstated_sect).toBe(false);
  });

  it('does NOT expose another member preferences', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select user_id from public.partner_preferences`,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a member edit their own preferences', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.partner_preferences set age_min = 25, age_max = 35 returning age_min`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects an age range below the product floor', async () => {
    await expect(
      db.admin(`update public.partner_preferences set age_min = 16 where user_id = $1`, [
        alice.userId,
      ]),
    ).rejects.toThrow(/age_min_floor/);
  });

  it('rejects an inverted age range', async () => {
    await expect(
      db.admin(
        `update public.partner_preferences set age_min = 40, age_max = 30 where user_id = $1`,
        [alice.userId],
      ),
    ).rejects.toThrow(/age_range/);
  });
});

describe('user_locations and preference_rules', () => {
  it('lets a member write their own location', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `insert into public.user_locations (user_id, country_code, city_name)
       values ($1, 'pk', 'Lahore') returning user_id`,
      [alice.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member write a location for someone else', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.user_locations (user_id, country_code) values ($1, 'pk')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('does NOT let a member see another member location', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select country_code from public.user_locations`,
    );
    expect(rows).toHaveLength(0);
  });

  it('keeps preference rules scoped to their owner', async () => {
    await db.admin(
      `insert into public.preference_rules (user_id, criterion, is_hard) values ($1, 'age', true)`,
      [alice.userId],
    );
    const mine = await db.as(
      'authenticated',
      alice.authUserId,
      `select criterion from public.preference_rules`,
    );
    const theirs = await db.as(
      'authenticated',
      bilal.authUserId,
      `select criterion from public.preference_rules`,
    );
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('rejects a display precision outside the allowed set', async () => {
    // Seeded through `admin`, not through the test above: every `db.as()` call
    // runs inside a transaction that is rolled back, so nothing a role-scoped
    // test writes survives it. That isolation is the point — it just means
    // fixtures have to be arranged deliberately.
    await db.admin(
      `insert into public.user_locations (user_id, country_code) values ($1, 'pk')
       on conflict (user_id) do nothing`,
      [alice.userId],
    );
    await expect(
      db.admin(`update public.user_locations set display_precision = 'street' where user_id = $1`, [
        alice.userId,
      ]),
    ).rejects.toThrow(/precision_valid/);
  });
});

describe('profile_field_visibility', () => {
  it('accepts a valid key and visibility', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `insert into public.profile_field_visibility (user_id, field_key, visibility)
       values ($1, 'profession', 'matched_only') returning field_key`,
      [alice.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a field key outside the fourteen controllable ones', async () => {
    await expect(
      db.admin(
        `insert into public.profile_field_visibility (user_id, field_key, visibility)
         values ($1, 'date_of_birth', 'private')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/key_valid/);
  });

  it('refuses to hide about_me entirely', async () => {
    // E6: a profile with no words is not a profile. about_me is limited to
    // public or matched_only.
    await expect(
      db.admin(
        `insert into public.profile_field_visibility (user_id, field_key, visibility)
         values ($1, 'about_me', 'private')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/about_me_limited/);
  });

  it('does NOT expose another member visibility settings', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select field_key from public.profile_field_visibility`,
    );
    expect(rows).toHaveLength(0);
  });
});
