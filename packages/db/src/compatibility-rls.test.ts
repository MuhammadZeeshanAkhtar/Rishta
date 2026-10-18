import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `compatibility_scores`, `compatibility_factors`, `match_candidates`.
 *
 * All three are system tables, and the risk they carry is FABRICATION rather
 * than disclosure. A member who could write a factor could author an
 * explanation the engine never produced — which would quietly destroy the one
 * property the deterministic design exists to guarantee, because the stored
 * facts are what makes an explanation checkable at all.
 *
 * Read access is asymmetric and that asymmetry is the second control: the
 * viewer may read what was computed FOR them, and nobody may read what was
 * computed ABOUT them. Being able to list `candidate_user_id = me` would tell
 * a member who is being shown their profile.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;
let scoreId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });

  const rows = await db.admin<{ id: string }>(
    `insert into public.compatibility_scores
       (viewer_user_id, candidate_user_id, overall, engine_version)
     values ($1::uuid, $2::uuid, 82.5, '1.0.0')
     returning id`,
    [alice.userId, bilal.userId],
  );
  scoreId = rows[0]!.id;

  await db.admin(
    `insert into public.compatibility_factors
       (score_id, dimension, sub_score, weight, is_hard, facts, explanation_key)
     values ($1::uuid, 'religious', 100, 0.16, false,
             '{"candidatePractice":"rel_practising"}'::jsonb, 'compatibility.religious')`,
    [scoreId],
  );

  await db.admin(
    `insert into public.match_candidates
       (user_id, candidate_user_id, section_key, rank, batch_id)
     values ($1::uuid, $2::uuid, 'recommended', 0, gen_random_uuid())`,
    [alice.userId, bilal.userId],
  );
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('reads', () => {
  it('lets a viewer read the scores computed FOR them', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select overall from public.compatibility_scores`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let the candidate read the score computed ABOUT them', async () => {
    // Bilal learning that Alice is being shown his profile, and what the
    // engine thinks of him, is neither his to know nor something the product
    // offers.
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select overall from public.compatibility_scores`,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a viewer read their own factors', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select dimension, facts from public.compatibility_factors`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dimension).toBe('religious');
  });

  it('does NOT let the candidate read factors about themselves', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select dimension from public.compatibility_factors`,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a viewer read their own candidate list', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select candidate_user_id from public.match_candidates`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member see whose lists they appear in', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select user_id from public.match_candidates`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let anon read any of the three', async () => {
    for (const table of ['compatibility_scores', 'compatibility_factors', 'match_candidates']) {
      await expect(db.as('anon', null, `select id from public.${table}`), table).rejects.toThrow(
        /permission denied/i,
      );
    }
  });
});

describe('a member cannot fabricate', () => {
  it('cannot insert a compatibility score', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.compatibility_scores
           (viewer_user_id, candidate_user_id, overall, engine_version)
         values ($1::uuid, $2::uuid, 100, '1.0.0')`,
        [bilal.userId, alice.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot raise a score computed for them', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.compatibility_scores set overall = 100`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot author an explanation the engine never produced', async () => {
    // The one that matters most. A fabricated factor is a fabricated reason,
    // and the stored facts are what make a reason checkable.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.compatibility_factors
           (score_id, dimension, sub_score, weight, facts, explanation_key)
         values ($1::uuid, 'lifestyle', 100, 1, '{}'::jsonb, 'compatibility.lifestyle')`,
        [scoreId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot rewrite the facts behind an existing factor', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.compatibility_factors set facts = '{"invented":true}'::jsonb`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot insert themselves into another member candidate list', async () => {
    await expect(
      db.as(
        'authenticated',
        bilal.authUserId,
        `insert into public.match_candidates
           (user_id, candidate_user_id, section_key, rank, batch_id)
         values ($1::uuid, $2::uuid, 'recommended', 0, gen_random_uuid())`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot promote themselves up a ranking', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `update public.match_candidates set rank = 0`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot delete a candidate row to hide someone', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.match_candidates`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('the service role writes', () => {
  it('can insert a score and its factors', async () => {
    const rows = await db.as(
      'service_role',
      null,
      `insert into public.compatibility_scores
         (viewer_user_id, candidate_user_id, overall, engine_version)
       values ($1::uuid, $2::uuid, 51, '1.0.0')
       returning id`,
      [bilal.userId, alice.userId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('constraints', () => {
  it('refuses a dimension the model does not define', async () => {
    // `personality` in particular: the README prose lists it, the ERD does
    // not, and a row naming it would mean engine and schema disagree.
    await expect(
      db.admin(
        `insert into public.compatibility_factors
           (score_id, dimension, sub_score, weight, facts, explanation_key)
         values ($1::uuid, 'personality', 50, 1, '{}'::jsonb, 'x')`,
        [scoreId],
      ),
    ).rejects.toThrow(/compatibility_factors_dimension_valid/);
  });

  it('refuses two rows for the same dimension on one score', async () => {
    // Two `reciprocity` rows would double its weight silently.
    await expect(
      db.admin(
        `insert into public.compatibility_factors
           (score_id, dimension, sub_score, weight, facts, explanation_key)
         values ($1::uuid, 'religious', 10, 1, '{}'::jsonb, 'x')`,
        [scoreId],
      ),
    ).rejects.toThrow(/compatibility_factors_score_dimension_key/);
  });

  it('allows a null sub_score, which means the dimension did not apply', async () => {
    const rows = await db.admin<{ sub_score: unknown }>(
      `insert into public.compatibility_factors
         (score_id, dimension, sub_score, weight, facts, explanation_key)
       values ($1::uuid, 'family', null, 0.07, '{"reason":"no data"}'::jsonb,
               'compatibility.family')
       returning sub_score`,
      [scoreId],
    );
    expect(rows[0]!.sub_score).toBeNull();
  });

  it('refuses facts that are not an object', async () => {
    await expect(
      db.admin(
        `insert into public.compatibility_factors
           (score_id, dimension, sub_score, weight, facts, explanation_key)
         values ($1::uuid, 'timeline', 50, 1, '"nope"'::jsonb, 'x')`,
        [scoreId],
      ),
    ).rejects.toThrow(/compatibility_factors_facts_object/);
  });

  it('refuses a score outside 0-100', async () => {
    await expect(
      db.admin(
        `insert into public.compatibility_scores
           (viewer_user_id, candidate_user_id, overall, engine_version)
         values ($1::uuid, $2::uuid, 101, '1.0.0')`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/compatibility_scores_overall_range/);
  });

  it('refuses a self-pairing', async () => {
    await expect(
      db.admin(
        `insert into public.compatibility_scores
           (viewer_user_id, candidate_user_id, overall, engine_version)
         values ($1::uuid, $1::uuid, 50, '1.0.0')`,
        [alice.userId],
      ),
    ).rejects.toThrow(/compatibility_scores_not_self/);
  });

  it('refuses an unknown discovery section', async () => {
    await expect(
      db.admin(
        `insert into public.match_candidates
           (user_id, candidate_user_id, section_key, rank, batch_id)
         values ($1::uuid, $2::uuid, 'made_up_section', 0, gen_random_uuid())`,
        [bilal.userId, alice.userId],
      ),
    ).rejects.toThrow(/match_candidates_section_valid/);
  });

  it('holds one row per candidate per section per viewer', async () => {
    await expect(
      db.admin(
        `insert into public.match_candidates
           (user_id, candidate_user_id, section_key, rank, batch_id)
         values ($1::uuid, $2::uuid, 'recommended', 5, gen_random_uuid())`,
        [alice.userId, bilal.userId],
      ),
    ).rejects.toThrow(/match_candidates_member_key/);
  });

  it('removes factors with their score', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.compatibility_scores
         (viewer_user_id, candidate_user_id, overall, engine_version)
       values ($1::uuid, $2::uuid, 10, '1.0.0') returning id`,
      [bilal.userId, alice.userId],
    );
    // The pair already exists from the service-role test, so this upsert-less
    // insert would collide; use the returned id only if it inserted.
    const orphanScore = rows[0]?.id;
    if (!orphanScore) return;
    await db.admin(
      `insert into public.compatibility_factors
         (score_id, dimension, sub_score, weight, facts, explanation_key)
       values ($1::uuid, 'language', 50, 1, '{}'::jsonb, 'compatibility.language')`,
      [orphanScore],
    );
    await db.admin(`delete from public.compatibility_scores where id = $1::uuid`, [orphanScore]);
    const left = await db.admin(
      `select id from public.compatibility_factors where score_id = $1::uuid`,
      [orphanScore],
    );
    expect(left).toHaveLength(0);
  });
});
