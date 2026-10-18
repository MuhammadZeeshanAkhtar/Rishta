import { randomUUID } from 'node:crypto';
import {
  ENGINE_VERSION,
  scoreCompatibility,
  type CompatibilityPreferences,
  type CompatibilityProfile,
  type CompatibilityResult,
  type CompatibilitySide,
  type DiscoverySection,
  type PreferenceRule,
} from '@nikahmate/domain';
import type { Db, DbSession } from '../db/types';

/**
 * Candidate generation: FILTER → SCORE → EXPLAIN FACTORS → RANK → STORE.
 *
 * The stages are separate functions on purpose. FILTER decides who is eligible
 * and is the stage that carries the safety rules; SCORE never re-decides
 * eligibility, and RANK never re-scores. Collapsing them would make it
 * possible for a blocked member to be scored, or for compatibility to be
 * counted twice in the final order.
 *
 * DETERMINISM. Nothing here reads a clock or a random source except
 * `batch_id`, which is an opaque grouping token that no ordering depends on.
 * Given the same database state, two runs produce the same rows in the same
 * order.
 */

// ---------------------------------------------------------------------------
// FILTER
// ---------------------------------------------------------------------------

/**
 * The eligibility query.
 *
 * Every clause here is an EXCLUSION, and the ones that matter are the safety
 * clauses rather than the preference ones:
 *
 *   * `app.can_view_profile()` — the Slice 1 predicate, which already folds in
 *     blocks in both directions, the target being an active non-deleted
 *     account, and the profile having passed review. Re-implementing any of
 *     that here would mean two sources of truth for one question, and the one
 *     that is easier to read is the one that goes stale. This is also what
 *     keeps discovery consistent with what the member could actually open.
 *   * `u.gender <> viewer.gender` — the matrimonial assumption, applied as a
 *     hard filter rather than a preference because it is not a preference.
 *   * `p.user_id <> viewer` — self exclusion.
 *
 * HARD PREFERENCES are applied here and NOWHERE ELSE. A criterion marked
 * `is_hard` in `preference_rules` excludes; a soft one does not touch this
 * query and is handled entirely by the score. Filtering on a soft preference
 * would turn a ranking signal into a deal-breaker the member never asked for.
 *
 * Age and height are filter criteria here and are NOT scoring dimensions, so
 * nothing is counted twice. Age is compared in SQL against the stored date of
 * birth, which is the one place a clock is legitimate: eligibility is a
 * question about today, whereas a score must be reproducible forever.
 */
export interface FilterOptions {
  /** Hard criteria, from `preference_rules`. Soft ones are ignored here. */
  hardCriteria: readonly string[];
  limit: number;
}

interface CandidateRow {
  user_id: string;
  gender: string | null;
  languages: string[] | null;
  marital_status_code: string | null;
  has_children: boolean | null;
  children_count: number | null;
  children_live_with_me: boolean | null;
  marriage_timeline_code: string | null;
  relocation_willingness_code: string | null;
  relocation_target_countries: string[] | null;
  education_level_code: string | null;
  field_of_study_code: string | null;
  profession_code: string | null;
  industry_code: string | null;
  religious_practice_code: string | null;
  sect_code: string | null;
  prayer_frequency_code: string | null;
  quran_level_code: string | null;
  dress_practice_code: string | null;
  hobbies: string[] | null;
  lifestyle_attributes: string[] | null;
  diet_code: string | null;
  smoking_code: string | null;
  country_code: string | null;
  region_code: string | null;
  city_name: string | null;
  profile_updated_at: string | null;
  last_seen_at: string | null;
}

interface PreferencesRow {
  country_codes: string[] | null;
  language_codes: string[] | null;
  education_level_codes: string[] | null;
  profession_codes: string[] | null;
  religious_practice_codes: string[] | null;
  sect_codes: string[] | null;
  exclude_unstated_sect: boolean | null;
  marital_status_codes: string[] | null;
  accepts_children: boolean | null;
  marriage_timeline_codes: string[] | null;
  relocation_required: boolean | null;
  age_min: number | null;
  age_max: number | null;
  height_min_cm: number | null;
  height_max_cm: number | null;
}

const CANDIDATE_COLUMNS = `
  p.user_id,
  u.gender,
  p.languages, p.marital_status_code, p.has_children, p.children_count,
  p.children_live_with_me, p.marriage_timeline_code,
  p.relocation_willingness_code, p.relocation_target_countries,
  p.education_level_code, p.field_of_study_code,
  p.profession_code, p.industry_code,
  p.religious_practice_code, p.sect_code, p.prayer_frequency_code,
  p.quran_level_code, p.dress_practice_code,
  p.hobbies, p.lifestyle_attributes, p.diet_code, p.smoking_code,
  l.country_code, l.region_code, l.city_name,
  p.updated_at as profile_updated_at,
  (select max(d.last_seen_at) from public.user_devices d
    where d.user_id = p.user_id and d.revoked_at is null) as last_seen_at
`;

/**
 * Eligible candidates for one viewer.
 *
 * Runs as the SERVICE ROLE, and the reason is worth stating because it looks
 * like the wrong choice: generation is a background computation on behalf of a
 * member, not a request made by one, and it must read `user_locations` and the
 * full candidate profile — both owner-only. The safety guarantee is therefore
 * not RLS here but `app.can_view_profile()`, called explicitly in the WHERE
 * clause, which is the same predicate the member's own reads go through.
 */
async function selectEligible(
  session: DbSession,
  viewerUserId: string,
  viewerGender: string | null,
  prefs: PreferencesRow,
  options: FilterOptions,
): Promise<CandidateRow[]> {
  const hard = new Set(options.hardCriteria);
  const conditions: string[] = [];
  const params: unknown[] = [viewerUserId];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // --- always on -----------------------------------------------------------
  conditions.push(`p.user_id <> $1::uuid`);
  conditions.push(`p.deleted_at is null`);
  // The Slice 1 predicate: blocks both ways, active account, approved profile.
  conditions.push(`app.can_view_profile($1::uuid, p.user_id)`);
  // "Not interested" is permanent (ERD §9), so a dismissed profile is dropped
  // at generation rather than filtered on every read.
  conditions.push(
    `not exists (select 1 from public.dismissed_profiles d
                  where d.user_id = $1::uuid and d.target_user_id = p.user_id)`,
  );

  // Opposite gender. A matrimonial assumption, not a preference — there is no
  // gender field on `partner_preferences` to express it as one.
  if (viewerGender) {
    conditions.push(`u.gender is not null and u.gender <> ${bind(viewerGender)}::text`);
  }

  // --- hard preferences only ----------------------------------------------
  const hardList = (
    criterion: string,
    column: string,
    values: string[] | null | undefined,
  ): void => {
    if (!hard.has(criterion) || !values || values.length === 0) return;
    conditions.push(`${column} = any(${bind(values)}::text[])`);
  };

  hardList('religious', 'p.religious_practice_code', prefs.religious_practice_codes);
  hardList('education', 'p.education_level_code', prefs.education_level_codes);
  hardList('profession', 'p.profession_code', prefs.profession_codes);
  hardList('timeline', 'p.marriage_timeline_code', prefs.marriage_timeline_codes);
  hardList('children', 'p.marital_status_code', prefs.marital_status_codes);
  hardList('location', 'l.country_code', prefs.country_codes);

  if (hard.has('religious') && prefs.sect_codes && prefs.sect_codes.length > 0) {
    // A2: a null sect is NOT STATED and is only excluded when the member
    // explicitly opted into `exclude_unstated_sect`. Dropping it by default
    // would silently remove everyone who declined to answer.
    const sects = bind(prefs.sect_codes);
    conditions.push(
      prefs.exclude_unstated_sect
        ? `p.sect_code = any(${sects}::text[])`
        : `(p.sect_code is null or p.sect_code = any(${sects}::text[]))`,
    );
  }

  if (hard.has('children') && prefs.accepts_children === false) {
    conditions.push(`coalesce(p.has_children, false) = false`);
  }

  if (hard.has('language') && prefs.language_codes && prefs.language_codes.length > 0) {
    conditions.push(`p.languages && ${bind(prefs.language_codes)}::text[]`);
  }

  if (hard.has('relocation') && prefs.relocation_required === true) {
    conditions.push(
      `(p.relocation_willingness_code is null
         or p.relocation_willingness_code not in ('reloc_no', 'no'))`,
    );
  }

  // Age and height: filter criteria, never scoring dimensions.
  //
  // `!= null` rather than `!== null` on purpose: a viewer with no
  // `partner_preferences` row at all yields an empty object, so every field is
  // `undefined` rather than null. Strict inequality let that through and bound
  // `undefined`, which Postgres received as NaN.
  if (prefs.age_min != null) {
    conditions.push(
      `u.date_of_birth is not null
         and u.date_of_birth <= (current_date - make_interval(years => ${bind(prefs.age_min)}::int))`,
    );
  }
  if (prefs.age_max != null) {
    conditions.push(
      `u.date_of_birth is not null
         and u.date_of_birth > (current_date - make_interval(years => ${bind(prefs.age_max + 1)}::int))`,
    );
  }
  if (prefs.height_min_cm != null) {
    conditions.push(`p.height_cm is not null and p.height_cm >= ${bind(prefs.height_min_cm)}::int`);
  }
  if (prefs.height_max_cm != null) {
    conditions.push(`p.height_cm is not null and p.height_cm <= ${bind(prefs.height_max_cm)}::int`);
  }

  const rows = await session.query<CandidateRow>(
    `select ${CANDIDATE_COLUMNS}
       from public.profiles p
       join public.users u on u.id = p.user_id
       left join public.user_locations l on l.user_id = p.user_id
      where ${conditions.join('\n        and ')}
      order by p.user_id
      limit ${bind(options.limit)}::int`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Row → engine input
// ---------------------------------------------------------------------------

function toProfile(row: CandidateRow): CompatibilityProfile {
  return {
    userId: row.user_id,
    languages: row.languages ?? [],
    maritalStatusCode: row.marital_status_code,
    hasChildren: row.has_children,
    childrenCount: row.children_count,
    childrenLiveWithMe: row.children_live_with_me,
    marriageTimelineCode: row.marriage_timeline_code,
    relocationWillingnessCode: row.relocation_willingness_code,
    relocationTargetCountries: row.relocation_target_countries ?? [],
    educationLevelCode: row.education_level_code,
    fieldOfStudyCode: row.field_of_study_code,
    professionCode: row.profession_code,
    industryCode: row.industry_code,
    religiousPracticeCode: row.religious_practice_code,
    sectCode: row.sect_code,
    prayerFrequencyCode: row.prayer_frequency_code,
    quranLevelCode: row.quran_level_code,
    dressPracticeCode: row.dress_practice_code,
    hobbies: row.hobbies ?? [],
    lifestyleAttributes: row.lifestyle_attributes ?? [],
    dietCode: row.diet_code,
    smokingCode: row.smoking_code,
    location: row.country_code
      ? {
          countryCode: row.country_code,
          regionCode: row.region_code,
          cityName: row.city_name,
        }
      : null,
  };
}

function toPreferences(row: PreferencesRow | undefined): CompatibilityPreferences {
  return {
    countryCodes: row?.country_codes ?? [],
    languageCodes: row?.language_codes ?? [],
    educationLevelCodes: row?.education_level_codes ?? [],
    professionCodes: row?.profession_codes ?? [],
    religiousPracticeCodes: row?.religious_practice_codes ?? [],
    sectCodes: row?.sect_codes ?? [],
    excludeUnstatedSect: row?.exclude_unstated_sect ?? false,
    maritalStatusCodes: row?.marital_status_codes ?? [],
    acceptsChildren: row?.accepts_children ?? null,
    marriageTimelineCodes: row?.marriage_timeline_codes ?? [],
    relocationRequired: row?.relocation_required ?? null,
  };
}

const PREFERENCE_COLUMNS = `
  country_codes, language_codes, education_level_codes, profession_codes,
  religious_practice_codes, sect_codes, exclude_unstated_sect,
  marital_status_codes, accepts_children, marriage_timeline_codes,
  relocation_required, age_min, age_max, height_min_cm, height_max_cm
`;

// ---------------------------------------------------------------------------
// RANK
// ---------------------------------------------------------------------------

/**
 * One scored candidate, with the inputs ranking is allowed to use.
 */
export interface RankedCandidate {
  candidateUserId: string;
  result: CompatibilityResult;
  /** `profiles.updated_at`. The ADR's "freshness". */
  freshness: string | null;
  /** Newest device heartbeat. The ADR's "activity". */
  activity: string | null;
}

/**
 * Final order.
 *
 * ADR 0001 names four ranking inputs — reciprocity, freshness, activity and
 * diversity. Two of them are not applied here, and both omissions are
 * deliberate:
 *
 *   * **Reciprocity is already a compatibility dimension**, and the heaviest
 *     one. Applying it again as a ranking multiplier would double its weight
 *     through the back door, which is precisely what the product owner ruled
 *     out. It reaches the order through `overall`, once.
 *   * **Diversity has no input.** There is no attribute in the schema that
 *     says what a result set should be diversified across, and inventing one
 *     would be inventing values for data that does not exist.
 *
 * Freshness and activity are real columns, so they are used — but as
 * TIEBREAKS rather than as terms in a second score. Blending them into a
 * weighted total would be a second scoring system competing with the engine,
 * and the engine is the thing that has to be explainable.
 *
 * `candidateUserId` is the final tiebreak, so the order is total: two
 * candidates identical on every signal still sort the same way on every run.
 */
export function rankCandidates(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  const byTime = (value: string | null): number => {
    if (!value) return -1;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? -1 : parsed;
  };

  return [...candidates].sort((a, b) => {
    if (b.result.overall !== a.result.overall) return b.result.overall - a.result.overall;
    const freshness = byTime(b.freshness) - byTime(a.freshness);
    if (freshness !== 0) return freshness;
    const activity = byTime(b.activity) - byTime(a.activity);
    if (activity !== 0) return activity;
    return a.candidateUserId < b.candidateUserId
      ? -1
      : a.candidateUserId > b.candidateUserId
        ? 1
        : 0;
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Upper bound on candidates considered. */
  limit?: number;
  /** Sections to write. Only `recommended` is derivable today. */
  sections?: readonly DiscoverySection[];
}

export interface GenerateReport {
  viewerUserId: string;
  batchId: string;
  eligible: number;
  scored: number;
  engineVersion: string;
  sections: Record<string, number>;
}

const DEFAULT_LIMIT = 500;

/**
 * Generates one viewer's candidates, end to end.
 *
 * IDEMPOTENT by construction. Scores upsert on `(viewer, candidate)` and
 * factors are deleted and rewritten per score, so a rerun against unchanged
 * data converges on the same rows rather than accumulating them. Candidates
 * are replaced per batch inside a single transaction: the new rows are
 * inserted and every earlier batch for that viewer and section is deleted
 * together, so a reader never observes a section half-built or doubled.
 *
 * Exposed as a plain function rather than wired to a schedule. The nightly job
 * is a later decision (ADR 0007 is deferred, and pg-boss is not installed);
 * this is what that job, or an API route, will call.
 */
export async function generateCandidates(
  db: Db,
  viewerUserId: string,
  options: GenerateOptions = {},
): Promise<GenerateReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sections = options.sections ?? (['recommended'] as const);
  const batchId = randomUUID();

  // --- FILTER --------------------------------------------------------------
  const { viewer, eligible, rules } = await db.asService(
    'compatibility.write_scores',
    async (session) => {
      const viewerRows = await session.query<
        CandidateRow & PreferencesRow & { height_cm: number | null }
      >(
        `select ${CANDIDATE_COLUMNS}, p.height_cm
           from public.profiles p
           join public.users u on u.id = p.user_id
           left join public.user_locations l on l.user_id = p.user_id
          where p.user_id = $1::uuid and p.deleted_at is null`,
        [viewerUserId],
      );
      const viewerRow = viewerRows[0];
      if (!viewerRow) {
        return { viewer: null, eligible: [] as CandidateRow[], rules: [] as PreferenceRule[] };
      }

      const prefRows = await session.query<PreferencesRow>(
        `select ${PREFERENCE_COLUMNS} from public.partner_preferences where user_id = $1::uuid`,
        [viewerUserId],
      );
      const prefs = prefRows[0] ?? ({} as PreferencesRow);

      const ruleRows = await session.query<{
        criterion: string;
        is_hard: boolean;
        weight: string | number;
      }>(
        `select criterion, is_hard, weight from public.preference_rules where user_id = $1::uuid`,
        [viewerUserId],
      );
      const parsedRules: PreferenceRule[] = ruleRows.map((r) => ({
        criterion: r.criterion,
        isHard: r.is_hard,
        weight: typeof r.weight === 'number' ? r.weight : Number.parseFloat(r.weight),
      }));

      const candidates = await selectEligible(session, viewerUserId, viewerRow.gender, prefs, {
        hardCriteria: parsedRules.filter((r) => r.isHard).map((r) => r.criterion),
        limit,
      });

      return {
        viewer: { row: viewerRow, preferences: toPreferences(prefs) },
        eligible: candidates,
        rules: parsedRules,
      };
    },
  );

  if (!viewer) {
    return {
      viewerUserId,
      batchId,
      eligible: 0,
      scored: 0,
      engineVersion: ENGINE_VERSION,
      sections: Object.fromEntries(sections.map((s) => [s, 0])),
    };
  }

  const viewerSide: CompatibilitySide = {
    profile: toProfile(viewer.row),
    preferences: viewer.preferences,
    rules,
  };

  // --- SCORE ---------------------------------------------------------------
  //
  // Candidate preferences are needed for the reciprocity dimension: it asks
  // whether the CANDIDATE would accept the VIEWER, so it reads their side.
  const scored: RankedCandidate[] = [];
  if (eligible.length > 0) {
    const candidatePrefs = await db.asService('compatibility.write_scores', async (session) => {
      const rows = await session.query<PreferencesRow & { user_id: string }>(
        `select user_id, ${PREFERENCE_COLUMNS}
           from public.partner_preferences where user_id = any($1::uuid[])`,
        [eligible.map((c) => c.user_id)],
      );
      return new Map(rows.map((r) => [r.user_id, r]));
    });

    for (const row of eligible) {
      const candidateSide: CompatibilitySide = {
        profile: toProfile(row),
        preferences: toPreferences(candidatePrefs.get(row.user_id)),
      };
      scored.push({
        candidateUserId: row.user_id,
        result: scoreCompatibility(viewerSide, candidateSide),
        freshness: row.profile_updated_at,
        activity: row.last_seen_at,
      });
    }
  }

  // --- RANK ----------------------------------------------------------------
  const ranked = rankCandidates(scored);

  // --- STORE ---------------------------------------------------------------
  await db.asService('compatibility.write_scores', async (session) => {
    for (const candidate of ranked) {
      const scoreRows = await session.query<{ id: string }>(
        `insert into public.compatibility_scores
           (viewer_user_id, candidate_user_id, overall, engine_version, computed_at)
         values ($1::uuid, $2::uuid, $3::numeric, $4::text, now())
         on conflict (viewer_user_id, candidate_user_id) do update
           set overall = excluded.overall,
               engine_version = excluded.engine_version,
               computed_at = excluded.computed_at
         returning id`,
        [viewerUserId, candidate.candidateUserId, candidate.result.overall, ENGINE_VERSION],
      );
      const scoreId = scoreRows[0]!.id;

      // Rewritten wholesale rather than upserted per dimension: a dimension
      // that stopped applying must disappear, not linger with a stale
      // sub-score that no longer reflects any comparison.
      await session.query(`delete from public.compatibility_factors where score_id = $1::uuid`, [
        scoreId,
      ]);

      for (const factor of candidate.result.factors) {
        await session.query(
          `insert into public.compatibility_factors
             (score_id, dimension, sub_score, weight, is_hard, facts, explanation_key)
           values ($1::uuid, $2::text, $3::numeric, $4::numeric, $5::boolean, $6::jsonb, $7::text)`,
          [
            scoreId,
            factor.dimension,
            factor.subScore,
            factor.weight,
            factor.isHard,
            JSON.stringify(factor.facts),
            factor.explanationKey,
          ],
        );
      }
    }
  });

  const written: Record<string, number> = {};
  await db.asService('discovery.write_candidates', async (session) => {
    for (const section of sections) {
      const members = ranked;
      for (const [index, candidate] of members.entries()) {
        await session.query(
          `insert into public.match_candidates
             (user_id, candidate_user_id, section_key, rank, batch_id)
           values ($1::uuid, $2::uuid, $3::text, $4::int, $5::uuid)
           on conflict (user_id, section_key, candidate_user_id) do update
             set rank = excluded.rank, batch_id = excluded.batch_id`,
          [viewerUserId, candidate.candidateUserId, section, index, batchId],
        );
      }

      // The atomic swap. Anything still carrying an older batch was not
      // regenerated, so it is stale by definition — a candidate who has since
      // blocked the viewer, had their profile unapproved, or simply dropped
      // out of the filter. Deleting inside the same transaction as the insert
      // is what stops a reader seeing the section empty or doubled.
      const removed = await session.query<{ id: string }>(
        `delete from public.match_candidates
          where user_id = $1::uuid and section_key = $2::text and batch_id <> $3::uuid
          returning id`,
        [viewerUserId, section, batchId],
      );
      void removed;
      written[section] = members.length;
    }
  });

  return {
    viewerUserId,
    batchId,
    eligible: eligible.length,
    scored: ranked.length,
    engineVersion: ENGINE_VERSION,
    sections: written,
  };
}

// ---------------------------------------------------------------------------
// The production trigger
// ---------------------------------------------------------------------------

/**
 * How long a completed run suppresses the next one.
 *
 * Long enough that opening Discover repeatedly costs nothing, short enough
 * that a member who has just widened their preferences sees the effect within
 * one coffee. `POST /compatibility/recompute` (Phase 7b) is the escape hatch
 * for "I want it now", which is why this can afford to be generous.
 */
const COOLDOWN_MINUTES = 15;

/**
 * When an in-flight run is presumed dead.
 *
 * A claim with no `finished_at` blocks every later request, so an abandoned
 * one — process killed, request cancelled, unhandled throw — would freeze a
 * member's feed permanently. Nothing sweeps this table (ADR 0007 deferred,
 * pg-boss not installed), so the reclaim has to happen on the next read.
 *
 * Two minutes is comfortably longer than a 500-candidate generation and short
 * enough that a real abandonment costs one Discover open.
 */
const STALE_MINUTES = 2;

export interface EnsureReport {
  /** True when this call performed the generation. */
  generated: boolean;
  /** Why generation was skipped, for logs and tests. */
  reason: 'generated' | 'cooldown' | 'in_flight' | 'failed';
  report: GenerateReport | null;
}

/**
 * Generate this viewer's candidates if nobody has recently, and nobody is
 * already doing it.
 *
 * WHY THIS EXISTS AT ALL. `generateCandidates()` was written in Phase 5 and
 * never called outside a test, so `match_candidates` stayed empty and every
 * real member's Discover feed was blank. This is the missing call site.
 *
 * WHY THE CLAIM IS A ROW AND NOT AN ADVISORY LOCK. `db.asService()` takes a
 * connection from the pool, opens a transaction, commits and releases it, and
 * `generateCandidates()` spans four such calls. A transaction-scoped advisory
 * lock would release at the first commit; a session-scoped one would ride a
 * pooled connection back into the pool still held, and could not be released
 * from the next connection. The conditional UPDATE below is atomic, survives
 * all four transactions, works across processes, and cannot collide the way a
 * hashed advisory key can.
 *
 * NEVER THROWS. This runs on the read path of a feed that already renders
 * correctly when empty. A generation failure should cost the member a blank
 * section and the operator a log line — not a 500 on a GET.
 *
 * NOT IN A TRANSACTION, and that matters. Every step closes its transaction
 * before the next opens, so a cold read never holds one pooled connection
 * while generation acquires four more. The pool is `max: 10`; nesting would
 * deadlock it under ten concurrent cold reads.
 */
export async function ensureCandidates(
  db: Db,
  viewerUserId: string,
  section: DiscoverySection = 'recommended',
  options: GenerateOptions = {},
): Promise<EnsureReport> {
  // THE CLAIM. One statement, and the race is decided by Postgres rather than
  // by read-then-write in the application.
  //
  // `on conflict do update` with a WHERE is the whole mechanism: the insert
  // wins for a viewer who has never generated; the update wins only when the
  // existing row is outside the cooldown OR was abandoned mid-flight. A second
  // concurrent request matches neither and gets zero rows back.
  const claimed = await db.asService('discovery.claim_generation', async (session) => {
    const rows = await session.query<{ user_id: string }>(
      `insert into public.discovery_generation_runs (user_id, section_key, started_at, finished_at)
       values ($1::uuid, $2::text, now(), null)
       on conflict (user_id, section_key) do update
          set started_at  = now(),
              finished_at = null,
              batch_id    = null,
              candidates  = null
        where (
                -- Finished, and the cooldown has expired.
                public.discovery_generation_runs.finished_at is not null
                and public.discovery_generation_runs.started_at
                      < now() - make_interval(mins => $3::int)
              )
           or (
                -- In flight, but abandoned.
                public.discovery_generation_runs.finished_at is null
                and public.discovery_generation_runs.started_at
                      < now() - make_interval(mins => $4::int)
              )
        returning user_id`,
      [viewerUserId, section, COOLDOWN_MINUTES, STALE_MINUTES],
    );
    return rows.length > 0;
  });

  if (!claimed) {
    // Someone generated recently, or someone is generating now. Either way the
    // caller serves whatever the feed currently holds rather than waiting —
    // a Discover open must not block on another request's work.
    return { generated: false, reason: 'cooldown', report: null };
  }

  try {
    const report = await generateCandidates(db, viewerUserId, {
      ...options,
      sections: [section],
    });

    await db.asService('discovery.claim_generation', (session) =>
      session.query(
        `update public.discovery_generation_runs
            set finished_at = now(), batch_id = $3::uuid, candidates = $4::int
          where user_id = $1::uuid and section_key = $2::text`,
        [viewerUserId, section, report.batchId, report.sections[section] ?? 0],
      ),
    );

    return { generated: true, reason: 'generated', report };
  } catch (error) {
    // Release the claim so the next read retries rather than waiting out the
    // stale window. `finished_at` is set with no `batch_id`, which also starts
    // the cooldown — a viewer whose generation fails repeatedly does not get to
    // retry on every request.
    await db
      .asService('discovery.claim_generation', (session) =>
        session.query(
          `update public.discovery_generation_runs
              set finished_at = now()
            where user_id = $1::uuid and section_key = $2::text`,
          [viewerUserId, section],
        ),
      )
      .catch(() => {
        // The release failing means the database is unreachable, which the
        // caller is about to discover anyway. The stale window is the backstop.
      });

    // Swallowed deliberately — see the doc comment. Rethrown to the caller
    // would turn a cold Discover read into a 500 for a feed that renders
    // correctly when empty.
    void error;
    return { generated: false, reason: 'failed', report: null };
  }
}
