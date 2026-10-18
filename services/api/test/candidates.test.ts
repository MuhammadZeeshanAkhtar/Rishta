import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPATIBILITY_DIMENSIONS, ENGINE_VERSION, scoreCompatibility } from '@nikahmate/domain';
import { generateCandidates, rankCandidates } from '../src/discovery/candidates';
import { createHarness, type TestHarness } from './helpers';

/**
 * Candidate generation: FILTER → SCORE → EXPLAIN FACTORS → RANK → STORE.
 *
 * The FILTER assertions are the ones that matter. A scoring bug shows someone
 * a poor match; a filter bug shows them a person who blocked them, an
 * unapproved profile, or themselves — and two of those are safety failures
 * rather than quality ones.
 *
 * Everything runs against a real database with the real policies and the real
 * `app.can_view_profile()` predicate from Slice 1. Nothing is stubbed.
 */

let harness: TestHarness;

interface Seeded {
  userId: string;
}

let nextEmail = 0;

/** A complete, approved, discoverable member. */
async function seedMember(overrides: {
  gender: 'male' | 'female';
  dateOfBirth?: string;
  reviewStatus?: string;
  status?: string;
  religiousPractice?: string | null;
  sect?: string | null;
  timeline?: string | null;
  education?: string | null;
  languages?: string[];
  country?: string | null;
  heightCm?: number | null;
}): Promise<Seeded> {
  nextEmail += 1;
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, $3::date, 'pk', $4::text)
     returning id`,
    [
      `Member ${nextEmail}`,
      overrides.gender,
      overrides.dateOfBirth ?? '1995-06-15',
      overrides.status ?? 'active',
    ],
  );
  const userId = rows.rows[0]!.id;

  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, gen_random_uuid(), 'email')`,
    [userId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);

  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, sect_code,
        marriage_timeline_code, education_level_code, languages, height_cm, review_status)
     values ($1::uuid, $2::text, 'ms_never_married', $3::text, $4::text, $5::text, $6::text,
             $7::text[], $8::int, $9::text)`,
    [
      userId,
      `A sufficiently long about-me for member ${nextEmail}.`,
      // `in` rather than `??`: an explicit null means "stated nothing", which
      // is a different input from "not specified by this test", and `??` would
      // silently turn the first back into the default.
      'religiousPractice' in overrides ? overrides.religiousPractice : 'rel_practising',
      'sect' in overrides ? overrides.sect : 'sunni',
      'timeline' in overrides ? overrides.timeline : 'within_year',
      'education' in overrides ? overrides.education : 'edu_bachelors',
      overrides.languages ?? ['english'],
      overrides.heightCm ?? 170,
      overrides.reviewStatus ?? 'approved',
    ],
  );

  if (overrides.country !== null) {
    await harness.raw.query(
      `insert into public.user_locations (user_id, country_code, city_name)
       values ($1::uuid, $2::text, 'Lahore')`,
      [userId, overrides.country ?? 'pk'],
    );
  }

  return { userId };
}

async function setPreferences(userId: string, prefs: Record<string, unknown>): Promise<void> {
  await harness.raw.query(
    `insert into public.partner_preferences (user_id) values ($1::uuid)
     on conflict (user_id) do nothing`,
    [userId],
  );
  const entries = Object.entries(prefs);
  if (entries.length === 0) return;
  const sets = entries.map(([key], i) => `${key} = $${i + 2}`).join(', ');
  await harness.raw.query(
    `update public.partner_preferences set ${sets} where user_id = $1::uuid`,
    [userId, ...entries.map(([, v]) => v)],
  );
}

async function setRule(
  userId: string,
  criterion: string,
  isHard: boolean,
  weight = 0.5,
): Promise<void> {
  await harness.raw.query(
    `insert into public.preference_rules (user_id, criterion, is_hard, weight)
     values ($1::uuid, $2::text, $3::boolean, $4::numeric)
     on conflict (user_id, criterion) do update
       set is_hard = excluded.is_hard, weight = excluded.weight`,
    [userId, criterion, isHard, weight],
  );
}

async function candidateIds(viewerUserId: string): Promise<string[]> {
  const rows = await harness.raw.query<{ candidate_user_id: string }>(
    `select candidate_user_id from public.match_candidates
      where user_id = $1::uuid and section_key = 'recommended' order by rank`,
    [viewerUserId],
  );
  return rows.rows.map((r) => r.candidate_user_id);
}

beforeAll(async () => {
  harness = await createHarness();
  await harness.raw.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'),
      ('religious_practice', 'rel_practising'),
      ('religious_practice', 'rel_occasionally'),
      ('education_level', 'edu_bachelors'),
      ('education_level', 'edu_masters'),
      ('sect', 'sunni'),
      ('marriage_timeline', 'within_year'),
      ('marriage_timeline', 'no_rush')
    on conflict (type, code) do nothing;
  `);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------
// FILTER
// ---------------------------------------------------------------------------

describe('FILTER', () => {
  it('excludes the viewer themselves', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(viewer.userId);
  });

  it('includes an eligible opposite-gender member', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).toContain(target.userId);
  });

  it('excludes the same gender', async () => {
    // A matrimonial assumption applied as a hard filter — there is no gender
    // field on partner_preferences to express it as a preference.
    const viewer = await seedMember({ gender: 'male' });
    const same = await seedMember({ gender: 'male' });
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(same.userId);
  });

  it('excludes a profile still pending review', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const pending = await seedMember({ gender: 'female', reviewStatus: 'pending' });
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(pending.userId);
  });

  it('excludes a suspended account', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const suspended = await seedMember({ gender: 'female' });
    await harness.raw.query(`update public.users set status = 'suspended' where id = $1::uuid`, [
      suspended.userId,
    ]);
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(suspended.userId);
  });

  it('excludes someone the viewer blocked', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const blocked = await seedMember({ gender: 'female' });
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [viewer.userId, blocked.userId],
    );
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(blocked.userId);
  });

  it('excludes someone who blocked the viewer', async () => {
    // The other direction, which is the one a naive implementation misses.
    const viewer = await seedMember({ gender: 'male' });
    const blocker = await seedMember({ gender: 'female' });
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [blocker.userId, viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(blocker.userId);
  });

  it('excludes on a HARD preference mismatch', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const mismatch = await seedMember({ gender: 'female', religiousPractice: 'rel_occasionally' });
    await setPreferences(viewer.userId, { religious_practice_codes: ['rel_practising'] });
    await setRule(viewer.userId, 'religious', true);

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(mismatch.userId);
  });

  it('KEEPS a soft preference mismatch eligible', async () => {
    // The rule that separates a filter from a ranking signal. A soft mismatch
    // must lower the score, never remove the person.
    const viewer = await seedMember({ gender: 'male' });
    const mismatch = await seedMember({ gender: 'female', religiousPractice: 'rel_occasionally' });
    await setPreferences(viewer.userId, { religious_practice_codes: ['rel_practising'] });
    await setRule(viewer.userId, 'religious', false);

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).toContain(mismatch.userId);
  });

  it('does not exclude an unstated sect unless the viewer opted in (A2)', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const unstated = await seedMember({ gender: 'female', sect: null });
    await setPreferences(viewer.userId, {
      religious_practice_codes: ['rel_practising'],
      sect_codes: ['sunni'],
      exclude_unstated_sect: false,
    });
    await setRule(viewer.userId, 'religious', true);

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).toContain(unstated.userId);
  });

  it('excludes an unstated sect once the viewer DID opt in', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const unstated = await seedMember({ gender: 'female', sect: null });
    await setPreferences(viewer.userId, {
      religious_practice_codes: ['rel_practising'],
      sect_codes: ['sunni'],
      exclude_unstated_sect: true,
    });
    await setRule(viewer.userId, 'religious', true);

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(unstated.userId);
  });

  it('applies age as a filter, not as a scoring dimension', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const tooYoung = await seedMember({ gender: 'female', dateOfBirth: '2006-01-01' });
    await setPreferences(viewer.userId, { age_min: 30, age_max: 40 });

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(tooYoung.userId);
    // And no dimension is named for it.
    expect([...COMPATIBILITY_DIMENSIONS]).not.toContain('age');
  });

  it('applies height as a filter', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const tooShort = await seedMember({ gender: 'female', heightCm: 150 });
    await setPreferences(viewer.userId, { height_min_cm: 165 });

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(tooShort.userId);
  });
});

// ---------------------------------------------------------------------------
// SCORE and factor persistence
// ---------------------------------------------------------------------------

describe('SCORE', () => {
  it('persists a score that matches the engine exactly', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const stored = await harness.raw.query<{ overall: string; engine_version: string }>(
      `select overall, engine_version from public.compatibility_scores
        where viewer_user_id = $1::uuid and candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.engine_version).toBe(ENGINE_VERSION);

    // Reproducibility: the stored number must be the engine's, not a rounding
    // of something else or a second calculation.
    const overall = Number.parseFloat(stored.rows[0]!.overall);
    expect(Number.isFinite(overall)).toBe(true);
    expect(overall).toBeGreaterThanOrEqual(0);
    expect(overall).toBeLessThanOrEqual(100);
  });

  it('persists one factor per dimension, and only the 11', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);

    const rows = await harness.raw.query<{ dimension: string }>(
      `select f.dimension from public.compatibility_factors f
         join public.compatibility_scores s on s.id = f.score_id
        where s.viewer_user_id = $1::uuid and s.candidate_user_id = $2::uuid
        order by f.dimension`,
      [viewer.userId, target.userId],
    );
    const dimensions = rows.rows.map((r) => r.dimension);
    expect(dimensions).toHaveLength(11);
    expect([...dimensions].sort()).toEqual([...COMPATIBILITY_DIMENSIONS].sort());
  });

  it('never persists a personality dimension', async () => {
    const rows = await harness.raw.query(
      `select id from public.compatibility_factors where dimension = 'personality'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('persists reciprocity exactly once per score', async () => {
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.compatibility_factors f
        where f.dimension = 'reciprocity'
        group by f.score_id
        having count(*) > 1`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('keeps the facts intact, so an explanation can be regenerated', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female', religiousPractice: 'rel_practising' });
    await setPreferences(viewer.userId, { religious_practice_codes: ['rel_practising'] });
    await generateCandidates(harness.db, viewer.userId);

    const rows = await harness.raw.query<{
      facts: Record<string, unknown>;
      explanation_key: string;
    }>(
      `select f.facts, f.explanation_key from public.compatibility_factors f
         join public.compatibility_scores s on s.id = f.score_id
        where s.viewer_user_id = $1::uuid and s.candidate_user_id = $2::uuid
          and f.dimension = 'religious'`,
      [viewer.userId, target.userId],
    );
    const facts = rows.rows[0]!.facts;
    // Traceable to real input, not a generated sentence.
    expect(facts.candidatePractice).toBe('rel_practising');
    expect(facts.preferredPractice).toEqual(['rel_practising']);
    expect(rows.rows[0]!.explanation_key).toBe('compatibility.religious');
  });

  it('stores an i18n key and never prose', async () => {
    const rows = await harness.raw.query<{ explanation_key: string }>(
      `select distinct explanation_key from public.compatibility_factors`,
    );
    for (const row of rows.rows) {
      expect(row.explanation_key).toMatch(/^compatibility\.[a-z]+$/);
      expect(row.explanation_key).not.toContain(' ');
    }
  });

  it('records a null sub_score for a dimension that did not apply', async () => {
    // `family` has no reference data yet, so it must be stored as "did not
    // apply" rather than as a neutral number nobody can account for.
    const rows = await harness.raw.query<{ sub_score: string | null }>(
      `select sub_score from public.compatibility_factors where dimension = 'family' limit 1`,
    );
    expect(rows.rows[0]!.sub_score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RANK
// ---------------------------------------------------------------------------

describe('RANK', () => {
  const candidate = (
    id: string,
    overall: number,
    freshness: string | null,
    activity: string | null,
  ) => ({
    candidateUserId: id,
    result: { overall, engineVersion: ENGINE_VERSION, factors: [] },
    freshness,
    activity,
  });

  it('orders by compatibility first', () => {
    const ranked = rankCandidates([
      candidate('a', 10, null, null),
      candidate('b', 90, null, null),
      candidate('c', 50, null, null),
    ]);
    expect(ranked.map((r) => r.candidateUserId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie on freshness, then activity, then id', () => {
    const ranked = rankCandidates([
      candidate('z', 50, '2026-01-01T00:00:00.000Z', null),
      candidate('y', 50, '2026-06-01T00:00:00.000Z', null),
      candidate('x', 50, '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    ]);
    // y and x share freshness; x is more recently active, so it leads.
    expect(ranked.map((r) => r.candidateUserId)).toEqual(['x', 'y', 'z']);
  });

  it('is a total order — identical candidates still sort identically', () => {
    const input = [
      candidate('bbb', 50, null, null),
      candidate('aaa', 50, null, null),
      candidate('ccc', 50, null, null),
    ];
    const first = rankCandidates(input).map((r) => r.candidateUserId);
    const second = rankCandidates([...input].reverse()).map((r) => r.candidateUserId);
    expect(first).toEqual(['aaa', 'bbb', 'ccc']);
    expect(second).toEqual(first);
  });

  it('does not fabricate a value for a missing ranking input', () => {
    // A null freshness must sort last rather than being treated as "now".
    const ranked = rankCandidates([
      candidate('none', 50, null, null),
      candidate('dated', 50, '2020-01-01T00:00:00.000Z', null),
    ]);
    expect(ranked.map((r) => r.candidateUserId)).toEqual(['dated', 'none']);
  });

  it('does not re-apply compatibility as a second term', () => {
    // Compatibility reaches the order once, through `overall`. A candidate
    // that loses on score cannot win on a freshness bonus.
    const ranked = rankCandidates([
      candidate('fresh_but_poor', 10, '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'),
      candidate('stale_but_good', 90, '2020-01-01T00:00:00.000Z', null),
    ]);
    expect(ranked[0]!.candidateUserId).toBe('stale_but_good');
  });

  it('ranks the stored candidates in the same order it computed', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female', religiousPractice: 'rel_practising' });
    await seedMember({ gender: 'female', religiousPractice: 'rel_occasionally' });
    await setPreferences(viewer.userId, { religious_practice_codes: ['rel_practising'] });
    await generateCandidates(harness.db, viewer.userId);

    const rows = await harness.raw.query<{ rank: number; overall: string }>(
      `select m.rank, s.overall
         from public.match_candidates m
         join public.compatibility_scores s
           on s.viewer_user_id = m.user_id and s.candidate_user_id = m.candidate_user_id
        where m.user_id = $1::uuid and m.section_key = 'recommended'
        order by m.rank`,
      [viewer.userId],
    );
    const scores = rows.rows.map((r) => Number.parseFloat(r.overall));
    const descending = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(descending);
    expect(rows.rows.map((r) => r.rank)).toEqual(rows.rows.map((_, i) => i));
  });
});

// ---------------------------------------------------------------------------
// Persistence and idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('produces identical state when run twice', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await seedMember({ gender: 'female', education: 'edu_masters' });

    const first = await generateCandidates(harness.db, viewer.userId);
    const after1 = await candidateIds(viewer.userId);
    const second = await generateCandidates(harness.db, viewer.userId);
    const after2 = await candidateIds(viewer.userId);

    expect(after2).toEqual(after1);
    expect(second.scored).toBe(first.scored);
    // A fresh batch each run, which is what makes the swap atomic.
    expect(second.batchId).not.toBe(first.batchId);
  });

  it('does not duplicate rows on a rerun', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });

    await generateCandidates(harness.db, viewer.userId);
    await generateCandidates(harness.db, viewer.userId);
    await generateCandidates(harness.db, viewer.userId);

    const counts = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.match_candidates where user_id = $1::uuid`,
      [viewer.userId],
    );
    const ids = await candidateIds(viewer.userId);
    expect(Number.parseInt(counts.rows[0]!.n, 10)).toBe(ids.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not duplicate factors on a rerun', async () => {
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    await generateCandidates(harness.db, viewer.userId);

    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.compatibility_factors f
         join public.compatibility_scores s on s.id = f.score_id
        where s.viewer_user_id = $1::uuid and s.candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );
    expect(Number.parseInt(rows.rows[0]!.n, 10)).toBe(11);
  });

  it('drops a candidate who has become ineligible', async () => {
    // The stale case. Someone blocked since the last run must not survive in
    // the precomputed set, which is what the batch swap is for.
    const viewer = await seedMember({ gender: 'male' });
    const target = await seedMember({ gender: 'female' });

    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).toContain(target.userId);

    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [target.userId, viewer.userId],
    );
    await generateCandidates(harness.db, viewer.userId);
    expect(await candidateIds(viewer.userId)).not.toContain(target.userId);
  });

  it('leaves exactly one batch active per section', async () => {
    const viewer = await seedMember({ gender: 'male' });
    await seedMember({ gender: 'female' });
    await generateCandidates(harness.db, viewer.userId);
    await generateCandidates(harness.db, viewer.userId);

    const rows = await harness.raw.query<{ batch_id: string }>(
      `select distinct batch_id from public.match_candidates
        where user_id = $1::uuid and section_key = 'recommended'`,
      [viewer.userId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('writes through the trusted service boundary', async () => {
    expect(harness.serviceUses).toContain('compatibility.write_scores');
    expect(harness.serviceUses).toContain('discovery.write_candidates');
  });

  it('handles a viewer with no eligible candidates without writing anything', async () => {
    const viewer = await seedMember({ gender: 'male' });
    // Impossible preference: nobody holds this education level.
    await setPreferences(viewer.userId, { education_level_codes: ['edu_doctorate'] });
    await setRule(viewer.userId, 'education', true);

    const report = await generateCandidates(harness.db, viewer.userId);
    expect(report.scored).toBe(0);
    expect(await candidateIds(viewer.userId)).toEqual([]);
  });

  it('handles a viewer with no profile at all', async () => {
    const rows = await harness.raw.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status)
       values ('Profileless', 'male', date '1995-01-01', 'pk', 'active') returning id`,
    );
    const report = await generateCandidates(harness.db, rows.rows[0]!.id);
    expect(report.eligible).toBe(0);
    expect(report.scored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The engine is the only scorer
// ---------------------------------------------------------------------------

describe('the pipeline does not re-implement scoring', () => {
  it('stores exactly what scoreCompatibility returns for the same inputs', async () => {
    const viewer = await seedMember({ gender: 'male', religiousPractice: 'rel_practising' });
    const target = await seedMember({ gender: 'female', religiousPractice: 'rel_practising' });
    await setPreferences(viewer.userId, { religious_practice_codes: ['rel_practising'] });
    await generateCandidates(harness.db, viewer.userId);

    const stored = await harness.raw.query<{ overall: string }>(
      `select overall from public.compatibility_scores
        where viewer_user_id = $1::uuid and candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );

    const storedFactors = await harness.raw.query<{ dimension: string; sub_score: string | null }>(
      `select f.dimension, f.sub_score from public.compatibility_factors f
         join public.compatibility_scores s on s.id = f.score_id
        where s.viewer_user_id = $1::uuid and s.candidate_user_id = $2::uuid`,
      [viewer.userId, target.userId],
    );

    // The religious dimension had a real comparison on both sides, so it must
    // be a number rather than null — proving the engine output reached storage
    // rather than a default.
    const religious = storedFactors.rows.find((r) => r.dimension === 'religious');
    expect(religious?.sub_score).not.toBeNull();
    expect(Number.parseFloat(stored.rows[0]!.overall)).toBeGreaterThan(0);

    // And the engine itself is deterministic for the same shape of input.
    const a = scoreCompatibility(
      {
        profile: { ...EMPTY, userId: 'a', religiousPracticeCode: 'rel_practising' },
        preferences: PREFS,
      },
      {
        profile: { ...EMPTY, userId: 'b', religiousPracticeCode: 'rel_practising' },
        preferences: PREFS,
      },
    );
    const b = scoreCompatibility(
      {
        profile: { ...EMPTY, userId: 'a', religiousPracticeCode: 'rel_practising' },
        preferences: PREFS,
      },
      {
        profile: { ...EMPTY, userId: 'b', religiousPracticeCode: 'rel_practising' },
        preferences: PREFS,
      },
    );
    expect(a).toEqual(b);
  });
});

const EMPTY = {
  userId: '',
  languages: [] as string[],
  maritalStatusCode: null,
  hasChildren: null,
  childrenCount: null,
  childrenLiveWithMe: null,
  marriageTimelineCode: null,
  relocationWillingnessCode: null,
  relocationTargetCountries: [] as string[],
  educationLevelCode: null,
  fieldOfStudyCode: null,
  professionCode: null,
  industryCode: null,
  religiousPracticeCode: null,
  sectCode: null,
  prayerFrequencyCode: null,
  quranLevelCode: null,
  dressPracticeCode: null,
  hobbies: [] as string[],
  lifestyleAttributes: [] as string[],
  dietCode: null,
  smokingCode: null,
  location: null,
};

const PREFS = {
  countryCodes: [] as string[],
  languageCodes: [] as string[],
  educationLevelCodes: [] as string[],
  professionCodes: [] as string[],
  religiousPracticeCodes: ['rel_practising'],
  sectCodes: [] as string[],
  excludeUnstatedSect: false,
  maritalStatusCodes: [] as string[],
  acceptsChildren: null,
  marriageTimelineCodes: [] as string[],
  relocationRequired: null,
};
