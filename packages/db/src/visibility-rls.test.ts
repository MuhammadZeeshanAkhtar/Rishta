import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * Cross-user visibility: blocks, the shared predicates, and the RLS they drive.
 *
 * This is the file that proves migration 0011 did what every earlier phase
 * deferred to it. `profiles` and `photos` were owner-only precisely because a
 * permissive policy would expose everyone the moment a second member existed,
 * so the assertions that matter here are the NEGATIVE ones.
 *
 * Everything runs against real policies on a real Postgres through
 * `db.as('authenticated', …)`. Nothing here mocks a predicate: a test that
 * stubs `app.is_blocked()` proves the stub works, not the policy.
 *
 * Cast of four:
 *   alice   — approved, discoverable
 *   bilal   — approved, discoverable
 *   chloe   — approved, blocks bilal (so the block is OUTBOUND from her)
 *   dawood  — profile still `pending`, approved by nobody
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let chloe: SeededUser;
let dawood: SeededUser;

/** Inserts a profile at a chosen review status, bypassing RLS. */
async function seedProfile(user: SeededUser, reviewStatus: string): Promise<void> {
  // `profiles_complete_for_review` refuses any status but 'draft' without the
  // required fields, so the fixture satisfies it rather than working around it.
  await db.admin(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, $2::text, 'ms_never_married', 'rel_practising', $3::text)`,
    [user.userId, `A complete about-me for ${user.userId}`, reviewStatus],
  );
}

/** Distinct positions, because `photos` has a per-user position constraint. */
let position = 0;

/** Inserts a photo owned by `user`, defaulting to the visible combination. */
async function seedPhoto(
  user: SeededUser,
  overrides: { visibility?: string; moderationStatus?: string } = {},
): Promise<string> {
  const rows = await db.admin<{ id: string }>(
    `insert into public.photos
       (user_id, storage_path, content_type, visibility, moderation_status, position)
     values ($1::uuid, $2::text, 'image/jpeg', $3::text, $4::text, $5::int)
     returning id`,
    [
      user.userId,
      `${user.userId}/${crypto.randomUUID()}.jpg`,
      overrides.visibility ?? 'public',
      overrides.moderationStatus ?? 'approved',
      position++,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  await db.admin(`
    insert into public.reference_items (type, code)
    values ('marital_status', 'ms_never_married'),
           ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing
  `);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
  chloe = await seedUser(db, { displayName: 'Chloe', gender: 'female' });
  dawood = await seedUser(db, { displayName: 'Dawood', gender: 'male' });

  await seedProfile(alice, 'approved');
  await seedProfile(bilal, 'approved');
  await seedProfile(chloe, 'approved');
  await seedProfile(dawood, 'pending');

  // Chloe blocks Bilal. One row, and it must silence BOTH directions.
  await db.admin(
    `insert into public.blocks (blocker_user_id, blocked_user_id, reason_code)
     values ($1::uuid, $2::uuid, 'harassment')`,
    [chloe.userId, bilal.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// app.is_blocked — the predicate the ERD calls the likeliest bug in the schema
// ---------------------------------------------------------------------------

describe('app.is_blocked', () => {
  const isBlocked = async (a: SeededUser, b: SeededUser): Promise<boolean> => {
    const rows = await db.admin<{ v: boolean }>(`select app.is_blocked($1, $2) as v`, [
      a.userId,
      b.userId,
    ]);
    return rows[0]!.v;
  };

  it('is true in the direction the block was written', async () => {
    expect(await isBlocked(chloe, bilal)).toBe(true);
  });

  it('is true in the REVERSE direction too', async () => {
    // The whole point. One row, both directions silenced — checking a single
    // direction is the bug this function exists to make impossible.
    expect(await isBlocked(bilal, chloe)).toBe(true);
  });

  it('is false for an unrelated pair', async () => {
    expect(await isBlocked(alice, bilal)).toBe(false);
    expect(await isBlocked(bilal, alice)).toBe(false);
  });

  it('is false for someone against themselves', async () => {
    expect(await isBlocked(alice, alice)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// app.relationship
// ---------------------------------------------------------------------------

describe('app.relationship', () => {
  const relationship = async (viewer: string | null, target: string | null): Promise<string> => {
    const rows = await db.admin<{ v: string }>(`select app.relationship($1, $2) as v`, [
      viewer,
      target,
    ]);
    return rows[0]!.v;
  };

  it('returns self', async () => {
    expect(await relationship(alice.userId, alice.userId)).toBe('self');
  });

  it('returns blocked, in both directions', async () => {
    expect(await relationship(chloe.userId, bilal.userId)).toBe('blocked');
    expect(await relationship(bilal.userId, chloe.userId)).toBe('blocked');
  });

  it('returns stranger for an unrelated member', async () => {
    expect(await relationship(alice.userId, bilal.userId)).toBe('stranger');
  });

  it('returns stranger rather than failing on a null party', async () => {
    expect(await relationship(null, alice.userId)).toBe('stranger');
    expect(await relationship(alice.userId, null)).toBe('stranger');
  });

  it('produces no state whose table does not exist yet', async () => {
    // Phase 6 adds match and interest_pending. Until those tables are here,
    // emitting either would be a claim the visibility system cannot back.
    const rows = await db.admin<{ v: string }>(
      `select app.relationship(a.id, b.id) as v
         from public.users a cross join public.users b`,
    );
    const states = new Set(rows.map((r) => r.v));
    expect([...states].sort()).toEqual(['blocked', 'self', 'stranger']);
  });
});

// ---------------------------------------------------------------------------
// app.can_view_profile
// ---------------------------------------------------------------------------

describe('app.can_view_profile', () => {
  const canView = async (viewer: string | null, target: SeededUser): Promise<boolean> => {
    const rows = await db.admin<{ v: boolean }>(`select app.can_view_profile($1, $2) as v`, [
      viewer,
      target.userId,
    ]);
    return rows[0]!.v;
  };

  it('is true for an approved stranger', async () => {
    expect(await canView(alice.userId, bilal)).toBe(true);
  });

  it('is true for yourself', async () => {
    expect(await canView(alice.userId, alice)).toBe(true);
  });

  it('is true for yourself even while your profile is unapproved', async () => {
    // Owner access must not wait on review, or onboarding could not show a
    // member their own draft — and under FORCE RLS the UPDATE would fail too.
    expect(await canView(dawood.userId, dawood)).toBe(true);
  });

  it('is false in BOTH directions once blocked', async () => {
    expect(await canView(chloe.userId, bilal)).toBe(false);
    expect(await canView(bilal.userId, chloe)).toBe(false);
  });

  it('is false for a profile that has not been approved', async () => {
    expect(await canView(alice.userId, dawood)).toBe(false);
  });

  it('is false for a viewer with no identity at all', async () => {
    // app.current_user_id() is NULL for anon. A NULL viewer must refuse
    // outright rather than falling through to the discoverability test.
    expect(await canView(null, alice)).toBe(false);
  });

  it('is false once the target account stops being active', async () => {
    await db.admin(`update public.users set status = 'suspended' where id = $1`, [bilal.userId]);
    try {
      expect(await canView(alice.userId, bilal)).toBe(false);
    } finally {
      await db.admin(`update public.users set status = 'active' where id = $1`, [bilal.userId]);
    }
  });
});

// ---------------------------------------------------------------------------
// profiles — the policy itself
// ---------------------------------------------------------------------------

describe('profiles RLS', () => {
  const readProfileAs = async (viewer: SeededUser, target: SeededUser): Promise<number> => {
    const rows = await db.as(
      'authenticated',
      viewer.authUserId,
      `select user_id from public.profiles where user_id = $1`,
      [target.userId],
    );
    return rows.length;
  };

  it('lets a member read their own profile', async () => {
    expect(await readProfileAs(alice, alice)).toBe(1);
  });

  it('lets a member read an approved stranger profile', async () => {
    expect(await readProfileAs(alice, bilal)).toBe(1);
  });

  it('does NOT let a member read a profile that blocked them', async () => {
    expect(await readProfileAs(bilal, chloe)).toBe(0);
  });

  it('does NOT let the blocker read the blocked member either', async () => {
    // Bidirectional at the policy level, not just in the predicate.
    expect(await readProfileAs(chloe, bilal)).toBe(0);
  });

  it('does NOT let a member read an unapproved profile', async () => {
    expect(await readProfileAs(alice, dawood)).toBe(0);
  });

  it('does NOT let anon read any profile', async () => {
    // Refused at the GRANT, before any policy is consulted — anon holds no
    // select privilege on this table at all. Stricter than an empty result.
    await expect(db.as('anon', null, `select user_id from public.profiles`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('still lets an owner update their own profile', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.profiles set about_me = 'Edited by the owner, at sufficient length.'
        where user_id = $1 returning about_me`,
      [alice.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member update someone else, visible or not', async () => {
    // Visibility widened; write access did not. This is the assertion that
    // catches a SELECT policy accidentally pasted onto UPDATE.
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.profiles set about_me = 'Hijacked by someone who is not the owner.'
        where user_id = $1 returning about_me`,
      [bilal.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member delete any profile, including their own', async () => {
    // No DELETE grant and no DELETE policy. Deletion is the account-deletion
    // workflow, which carries a grace period and retention holds (E1).
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `delete from public.profiles where user_id = $1::uuid returning user_id`,
        [alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('hides a soft-deleted profile from its own owner', async () => {
    await db.admin(`update public.profiles set deleted_at = now() where user_id = $1`, [
      dawood.userId,
    ]);
    try {
      expect(await readProfileAs(dawood, dawood)).toBe(0);
    } finally {
      await db.admin(`update public.profiles set deleted_at = null where user_id = $1`, [
        dawood.userId,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// photos — R5, the highest-severity leak in the product
// ---------------------------------------------------------------------------

describe('photos RLS', () => {
  const readPhotosAs = async (viewer: SeededUser, owner: SeededUser): Promise<number> => {
    const rows = await db.as(
      'authenticated',
      viewer.authUserId,
      `select id from public.photos where user_id = $1`,
      [owner.userId],
    );
    return rows.length;
  };

  it('lets a member see an approved public photo on a visible profile', async () => {
    await seedPhoto(bilal);
    expect(await readPhotosAs(alice, bilal)).toBe(1);
  });

  it('does NOT let a blocked member see photos, in either direction', async () => {
    await seedPhoto(chloe);
    expect(await readPhotosAs(bilal, chloe)).toBe(0);
    expect(await readPhotosAs(chloe, bilal)).toBe(0);
  });

  it('does NOT expose a private photo to anyone but its owner', async () => {
    const owner = await seedUser(db, { displayName: 'Private Owner', gender: 'female' });
    await seedProfile(owner, 'approved');
    await seedPhoto(owner, { visibility: 'private' });

    expect(await readPhotosAs(alice, owner)).toBe(0);
    expect(await readPhotosAs(owner, owner)).toBe(1);
  });

  it('does NOT expose a photo that has not cleared moderation', async () => {
    const owner = await seedUser(db, { displayName: 'Pending Photo', gender: 'female' });
    await seedProfile(owner, 'approved');
    await seedPhoto(owner, { moderationStatus: 'pending' });

    expect(await readPhotosAs(alice, owner)).toBe(0);
    // The owner still sees their own while it waits.
    expect(await readPhotosAs(owner, owner)).toBe(1);
  });

  it('does NOT expose photos on an unapproved profile', async () => {
    await seedPhoto(dawood);
    expect(await readPhotosAs(alice, dawood)).toBe(0);
  });

  it('lets an owner INSERT a photo and read it back in the same statement', async () => {
    // The regression 0012 exists for. `insert … returning` makes the SELECT
    // policy run against the row being written, so a policy that re-reads
    // `photos` to decide cannot see it and refuses the insert. That broke
    // every upload between 0011 and 0012, and the route does exactly this.
    const owner = await seedUser(db, { displayName: 'Uploader', gender: 'male' });
    await seedProfile(owner, 'approved');

    const rows = await db.as(
      'authenticated',
      owner.authUserId,
      `insert into public.photos
         (user_id, storage_path, content_type, byte_size, position)
       values ($1::uuid, $2::text, 'image/jpeg', 1024, $3::int)
       returning id`,
      [owner.userId, `${owner.userId}/${crypto.randomUUID()}/original.jpg`, position++],
    );
    expect(rows).toHaveLength(1);
  });

  it('lets an owner read back a brand-new private, unmoderated photo', async () => {
    // A fresh row defaults to private + pending, which is precisely the
    // combination the cross-user branch refuses. The owner branch must not.
    const owner = await seedUser(db, { displayName: 'Fresh', gender: 'female' });
    await seedProfile(owner, 'approved');
    await seedPhoto(owner, { visibility: 'private', moderationStatus: 'pending' });

    const rows = await db.as(
      'authenticated',
      owner.authUserId,
      `select id from public.photos where user_id = $1::uuid`,
      [owner.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let anon read any photo', async () => {
    await expect(db.as('anon', null, `select id from public.photos`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('keeps variants in lockstep with their parent photo', async () => {
    const owner = await seedUser(db, { displayName: 'Variant Owner', gender: 'female' });
    await seedProfile(owner, 'approved');
    const photoId = await seedPhoto(owner, { visibility: 'private' });
    await db.admin(
      `insert into public.photo_variants (photo_id, variant, storage_path, width, height, byte_size)
       values ($1, 'thumb', $2, 400, 400, 1024)`,
      [photoId, `${owner.userId}/thumb.jpg`],
    );

    const asStranger = await db.as(
      'authenticated',
      alice.authUserId,
      `select id from public.photo_variants where photo_id = $1`,
      [photoId],
    );
    const asOwner = await db.as(
      'authenticated',
      owner.authUserId,
      `select id from public.photo_variants where photo_id = $1`,
      [photoId],
    );

    // A variant readable after its parent is not is exactly the leak the
    // shared `app.can_view_photo()` predicate exists to prevent.
    expect(asStranger).toHaveLength(0);
    expect(asOwner).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// blocks — the blocked party must not be able to detect the block
// ---------------------------------------------------------------------------

describe('blocks RLS', () => {
  it('lets the blocker list their own blocks', async () => {
    const rows = await db.as(
      'authenticated',
      chloe.authUserId,
      `select blocked_user_id from public.blocks`,
    );
    expect(rows).toHaveLength(1);
  });

  it('gives the BLOCKED party no read path at all', async () => {
    // A detectable block is a retaliation trigger. `app.is_blocked()` is
    // security definer so the predicate can see what Bilal cannot.
    const rows = await db.as('authenticated', bilal.authUserId, `select id from public.blocks`);
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member file a block in someone else name', async () => {
    // The WITH CHECK refuses the row outright. Someone able to write a block
    // as another member could silence a conversation they are not part of.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.blocks (blocker_user_id, blocked_user_id)
         values ($1::uuid, $2::uuid) returning id`,
        [bilal.userId, chloe.userId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does NOT let a member delete a block they did not create', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `delete from public.blocks where blocker_user_id = $1 returning id`,
      [chloe.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a self-block', async () => {
    await expect(
      db.admin(
        `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $1::uuid)`,
        [alice.userId],
      ),
    ).rejects.toThrow(/blocks_not_self/);
  });

  it('refuses a duplicate block rather than stacking rows', async () => {
    await expect(
      db.admin(
        `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
        [chloe.userId, bilal.userId],
      ),
    ).rejects.toThrow(/blocks_pair_key/);
  });

  it('restores visibility when the block is removed', async () => {
    // The round trip, so "blocked" is proven to be the cause rather than a
    // coincidence of these two fixtures.
    const edward = await seedUser(db, { displayName: 'Edward', gender: 'male' });
    await seedProfile(edward, 'approved');

    const visible = async (): Promise<number> =>
      (
        await db.as(
          'authenticated',
          alice.authUserId,
          `select user_id from public.profiles where user_id = $1`,
          [edward.userId],
        )
      ).length;

    expect(await visible()).toBe(1);

    await db.admin(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [edward.userId, alice.userId],
    );
    expect(await visible()).toBe(0);

    await db.admin(`delete from public.blocks where blocker_user_id = $1`, [edward.userId]);
    expect(await visible()).toBe(1);
  });
});
