/**
 * The deterministic compatibility engine (ADR 0001, README §10.1).
 *
 * Compatibility is scored by a weighted engine across 11 dimensions, and
 * explanations are rendered later from the FACTS this produces rather than
 * narrated over the score. That is the whole bargain: an explanation that is a
 * by-product of the computation is true by construction, and a complaint
 * months later can be investigated line by line.
 *
 * This file is the SCORE stage of FILTER → SCORE → EXPLAIN → RANK. It holds no
 * database access, no I/O and no clock.
 *
 * DETERMINISM IS A PROPERTY, NOT AN ASPIRATION. Nothing here reads
 * `Date.now()`, `Math.random()`, the locale or the environment. Age is taken
 * as an input rather than derived from a birth date, precisely so that the
 * same two profiles score identically today and next year. Every set
 * comparison sorts before it reports, so the facts are byte-stable and can be
 * compared across runs and engine versions.
 *
 * WHAT IS DELIBERATELY NOT SCORED HERE. Age, height and distance are FILTER
 * criteria — deal-breakers that exclude a candidate from the set — not
 * dimensions that shade a score. Scoring them twice, once as a filter and
 * again as a dimension, would double their influence.
 */

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * The 11 dimensions, exactly as `compatibility_factors.dimension` enumerates
 * them in ERD §9.
 *
 * `personality` is NOT one of them. README §10.1 prose lists it, the ERD
 * enumeration does not, and the product owner confirmed the ERD. The profile
 * still carries `personalityTraits`; nothing scores it.
 *
 * `reciprocity` appears here ONCE. It is a dimension, not an additional
 * ranking multiplier — counting it in both places would silently double the
 * weight of the thing this engine is most careful about.
 */
export const COMPATIBILITY_DIMENSIONS = [
  'religious',
  'timeline',
  'relocation',
  'children',
  'family',
  'language',
  'location',
  'education',
  'profession',
  'lifestyle',
  'reciprocity',
] as const;
export type CompatibilityDimension = (typeof COMPATIBILITY_DIMENSIONS)[number];

/**
 * Engine version, stored beside every score (ERD §9).
 *
 * BUMP THIS whenever a weight, a rule or a normalisation changes. Without it,
 * "why did my matches change?" has no answer, and two engine versions cannot
 * be compared against real accept rates (ADR 0001, ERD E4).
 */
/**
 * Discovery sections, exactly as the `sectionKey` enum in docs/openapi.yaml
 * lists them. Declared here so the generator, the schema CHECK and the API
 * path parameter cannot drift apart.
 *
 * Only `recommended` is GENERATED today — it is the plain ranked output of the
 * pipeline and needs no semantics beyond the score. The rest are named by the
 * contract but not yet defined by it, and `nearby` cannot be computed at all:
 * `user_locations` stores country, region and city, never coordinates.
 */
export const DISCOVERY_SECTIONS = [
  'recommended',
  'highly_compatible',
  'nearby',
  'verified',
  'recently_joined',
  'same_language',
  'same_country',
  'open_to_relocation',
] as const;
export type DiscoverySection = (typeof DISCOVERY_SECTIONS)[number];

export const ENGINE_VERSION = '1.0.0';

/**
 * Hand-tuned, and initially unvalidated — ADR 0001 records that as the cost of
 * choosing a deterministic engine, and ERD E4 is the open item to revisit them
 * against real accept rates.
 *
 * Reciprocity carries the largest share on purpose. Showing someone a profile
 * that would never accept them is worse than showing nothing, and it is the
 * failure most products make.
 *
 * These are relative, not absolute: the overall score renormalises over the
 * dimensions that actually applied, so these never have to sum to anything in
 * particular.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<CompatibilityDimension, number>> = {
  reciprocity: 0.18,
  religious: 0.16,
  timeline: 0.12,
  children: 0.1,
  location: 0.09,
  relocation: 0.08,
  language: 0.08,
  family: 0.07,
  education: 0.05,
  profession: 0.04,
  lifestyle: 0.03,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Location as the schema actually stores it — no coordinates exist. */
export interface CompatibilityLocation {
  countryCode: string;
  regionCode: string | null;
  cityName: string | null;
}

/**
 * The profile fields that bear on compatibility.
 *
 * A structural subset of `OwnProfile`, so one is assignable to the other
 * without a mapping layer, plus the two family codes. Those exist as columns
 * on `profiles` but are not surfaced by `ownProfileSchema` yet, so they are
 * optional here — the family dimension becomes discriminating the day they are
 * populated, with no change to this engine.
 *
 * `age` is supplied by the caller rather than derived from `dateOfBirth`. That
 * is what keeps the engine free of a clock.
 */
export interface CompatibilityProfile {
  userId: string;
  age?: number | null;
  languages: readonly string[];
  maritalStatusCode: string | null;
  hasChildren: boolean | null;
  childrenCount: number | null;
  childrenLiveWithMe: boolean | null;
  marriageTimelineCode: string | null;
  relocationWillingnessCode: string | null;
  relocationTargetCountries: readonly string[];
  educationLevelCode: string | null;
  fieldOfStudyCode: string | null;
  professionCode: string | null;
  industryCode: string | null;
  religiousPracticeCode: string | null;
  /** Null means NOT STATED and is never penalised on its own (A2). */
  sectCode: string | null;
  prayerFrequencyCode: string | null;
  quranLevelCode: string | null;
  dressPracticeCode: string | null;
  familyReligiosityCode?: string | null;
  livingWithFamilyExpectationCode?: string | null;
  hobbies: readonly string[];
  lifestyleAttributes: readonly string[];
  dietCode: string | null;
  smokingCode: string | null;
  location: CompatibilityLocation | null;
}

/**
 * The preference fields that bear on scoring.
 *
 * `ageMin`/`ageMax`, `heightMinCm`/`heightMaxCm` and `maxDistanceKm` are
 * absent by design — they are filter criteria. `maxDistanceKm` additionally
 * has nothing to compute against: `user_locations` stores country, region and
 * city, never coordinates.
 */
export interface CompatibilityPreferences {
  countryCodes: readonly string[];
  languageCodes: readonly string[];
  educationLevelCodes: readonly string[];
  professionCodes: readonly string[];
  religiousPracticeCodes: readonly string[];
  sectCodes: readonly string[];
  excludeUnstatedSect: boolean;
  maritalStatusCodes: readonly string[];
  acceptsChildren: boolean | null;
  marriageTimelineCodes: readonly string[];
  relocationRequired: boolean | null;
  livingWithFamilyCodes?: readonly string[];
}

/**
 * One member's `preference_rules` row: is this criterion a deal-breaker, and
 * how much should it count when it is not.
 *
 * The engine NEVER excludes on a hard rule. Hard means FILTER drops the
 * candidate before scoring; by the time a pair reaches here that decision has
 * been made elsewhere. What the engine does is record `isHard` in the facts,
 * so the filter stage and a later investigation can both see which rules
 * applied, and honour `weight` as a per-member override of the default.
 */
export interface PreferenceRule {
  criterion: string;
  isHard: boolean;
  /** 0..1. Overrides `DIMENSION_WEIGHTS` for that dimension. */
  weight: number;
}

/** One side of the comparison. */
export interface CompatibilitySide {
  profile: CompatibilityProfile;
  preferences: CompatibilityPreferences;
  rules?: readonly PreferenceRule[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * The facts behind one sub-score — `compatibility_factors.facts` in ERD §9.
 *
 * This is what makes an explanation truthful rather than plausible: it stores
 * what was actually compared, so the reason shown is regenerated from the
 * comparison rather than written about it.
 */
export type CompatibilityFacts = Readonly<Record<string, unknown>>;

export interface CompatibilityFactor {
  dimension: CompatibilityDimension;
  /** 0–100, or null when the dimension could not discriminate. */
  subScore: number | null;
  /** False when neither side supplied anything to compare. */
  applicable: boolean;
  /** Effective weight after any `preference_rules` override. */
  weight: number;
  /** Whether the viewer marked this criterion a deal-breaker. */
  isHard: boolean;
  facts: CompatibilityFacts;
  /** i18n key for EXPLAIN. The wording lives in the catalogs, never here. */
  explanationKey: string;
}

export interface CompatibilityResult {
  /** 0–100, weighted mean over the dimensions that applied. */
  overall: number;
  engineVersion: string;
  factors: readonly CompatibilityFactor[];
}

// ---------------------------------------------------------------------------
// Helpers — small, total, and free of surprises
// ---------------------------------------------------------------------------

/** Sorted, de-duplicated, blank-free. Sorting is what makes facts stable. */
function normalise(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))].sort();
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((v) => other.has(v));
}

/** Jaccard. 1 when the sets agree, 0 when they are disjoint. */
function overlapRatio(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const shared = intersect(a, b).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** One decimal. Enough to rank by, stable to serialise and compare. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Does a stated value satisfy a preference list?
 *
 * An EMPTY list is not a failed match — it means the member stated no
 * constraint, so the signal does not apply. Treating "no preference" as "no
 * match" would punish the most open members, which is backwards.
 */
type Signal = { score: number; weight: number } | null;

function preferenceSignal(
  preferred: readonly string[],
  value: string | null | undefined,
  weight = 1,
): Signal {
  if (preferred.length === 0) return null;
  if (value === null || value === undefined || value === '') return null;
  return { score: preferred.includes(value) ? 100 : 0, weight };
}

/** Both sides stated something, and they agree. */
function sameValueSignal(
  a: string | null | undefined,
  b: string | null | undefined,
  weight = 1,
): Signal {
  if (!a || !b) return null;
  return { score: a === b ? 100 : 0, weight };
}

/** Combines signals into a sub-score, or null when none applied. */
function combine(signals: readonly Signal[]): number | null {
  const live = signals.filter((s): s is NonNullable<Signal> => s !== null);
  if (live.length === 0) return null;
  const total = live.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return null;
  return clamp(live.reduce((sum, s) => sum + s.score * s.weight, 0) / total);
}

function ruleFor(
  rules: readonly PreferenceRule[] | undefined,
  dimension: CompatibilityDimension,
): PreferenceRule | undefined {
  return rules?.find((r) => r.criterion === dimension);
}

// ---------------------------------------------------------------------------
// The dimensions
// ---------------------------------------------------------------------------

interface DimensionOutcome {
  subScore: number | null;
  facts: CompatibilityFacts;
}

/**
 * Religious practice, sect and observance.
 *
 * **A2 is the rule that matters here.** A null `sectCode` means NOT STATED,
 * and must never be penalised on its own — in a product where sect is
 * sensitive, declining to state it is a legitimate choice. It counts against a
 * candidate only when the viewer has explicitly opted into
 * `excludeUnstatedSect`, and even then it is recorded as a stated preference
 * rather than an inference.
 */
function scoreReligious(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const p = candidate.profile;
  const prefs = viewer.preferences;
  const practice = preferenceSignal(
    normalise(prefs.religiousPracticeCodes),
    p.religiousPracticeCode,
    2,
  );

  const preferredSects = normalise(prefs.sectCodes);
  const sectStated = p.sectCode !== null && p.sectCode !== undefined;
  let sect: Signal = null;
  if (!sectStated) {
    sect = prefs.excludeUnstatedSect ? { score: 0, weight: 2 } : null;
  } else if (preferredSects.length > 0) {
    sect = { score: preferredSects.includes(p.sectCode as string) ? 100 : 0, weight: 2 };
  }

  const subScore = combine([
    practice,
    sect,
    sameValueSignal(viewer.profile.prayerFrequencyCode, p.prayerFrequencyCode),
    sameValueSignal(viewer.profile.quranLevelCode, p.quranLevelCode),
    sameValueSignal(viewer.profile.dressPracticeCode, p.dressPracticeCode),
  ]);

  return {
    subScore,
    facts: {
      preferredPractice: normalise(prefs.religiousPracticeCodes),
      candidatePractice: p.religiousPracticeCode,
      preferredSects,
      candidateSect: p.sectCode,
      sectStated,
      excludeUnstatedSect: prefs.excludeUnstatedSect,
      viewerPrayerFrequency: viewer.profile.prayerFrequencyCode,
      candidatePrayerFrequency: p.prayerFrequencyCode,
      viewerQuranLevel: viewer.profile.quranLevelCode,
      candidateQuranLevel: p.quranLevelCode,
      viewerDressPractice: viewer.profile.dressPracticeCode,
      candidateDressPractice: p.dressPracticeCode,
    },
  };
}

/** When each wants to marry. Agreement counts for more than either preference. */
function scoreTimeline(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const preferred = normalise(viewer.preferences.marriageTimelineCodes);
  const subScore = combine([
    preferenceSignal(preferred, candidate.profile.marriageTimelineCode),
    sameValueSignal(viewer.profile.marriageTimelineCode, candidate.profile.marriageTimelineCode, 2),
  ]);
  return {
    subScore,
    facts: {
      preferredTimelines: preferred,
      viewerTimeline: viewer.profile.marriageTimelineCode,
      candidateTimeline: candidate.profile.marriageTimelineCode,
      sameTimeline:
        viewer.profile.marriageTimelineCode !== null &&
        viewer.profile.marriageTimelineCode === candidate.profile.marriageTimelineCode,
    },
  };
}

/**
 * Willingness to move, and where to.
 *
 * `relocationRequired` is the viewer's stated need. Overlapping target
 * countries is independent evidence that two people would end up in the same
 * place, which is the question underneath the preference.
 */
function scoreRelocation(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
): DimensionOutcome {
  const viewerTargets = normalise(viewer.profile.relocationTargetCountries);
  const candidateTargets = normalise(candidate.profile.relocationTargetCountries);
  const sharedTargets = intersect(viewerTargets, candidateTargets);

  const required = viewer.preferences.relocationRequired;
  const willingness = candidate.profile.relocationWillingnessCode;

  let requirement: Signal = null;
  if (required !== null && required !== undefined && willingness) {
    // Only an explicit refusal fails an explicit requirement. Any other stated
    // willingness is treated as compatible rather than guessed at, because the
    // reference codes are data and this engine does not rank them.
    const refuses = willingness === 'reloc_no' || willingness === 'no';
    requirement = { score: required ? (refuses ? 0 : 100) : 100, weight: 2 };
  }

  const targets: Signal =
    viewerTargets.length > 0 && candidateTargets.length > 0
      ? { score: clamp(overlapRatio(viewerTargets, candidateTargets) * 100), weight: 1 }
      : null;

  return {
    subScore: combine([
      requirement,
      targets,
      sameValueSignal(viewer.profile.relocationWillingnessCode, willingness),
    ]),
    facts: {
      relocationRequired: required,
      viewerWillingness: viewer.profile.relocationWillingnessCode,
      candidateWillingness: willingness,
      viewerTargetCountries: viewerTargets,
      candidateTargetCountries: candidateTargets,
      sharedTargetCountries: sharedTargets,
    },
  };
}

/**
 * Children, present and expected.
 *
 * `acceptsChildren` is the viewer's position on a candidate who already has
 * them. A candidate with no children is compatible with either position — the
 * preference constrains one case, not both.
 */
function scoreChildren(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const accepts = viewer.preferences.acceptsChildren;
  const has = candidate.profile.hasChildren;

  let acceptance: Signal = null;
  if (accepts !== null && accepts !== undefined && has !== null && has !== undefined) {
    acceptance = { score: has && !accepts ? 0 : 100, weight: 3 };
  }

  const marital = preferenceSignal(
    normalise(viewer.preferences.maritalStatusCodes),
    candidate.profile.maritalStatusCode,
  );

  return {
    subScore: combine([acceptance, marital]),
    facts: {
      acceptsChildren: accepts,
      candidateHasChildren: has,
      candidateChildrenCount: candidate.profile.childrenCount,
      candidateChildrenLiveWithThem: candidate.profile.childrenLiveWithMe,
      preferredMaritalStatuses: normalise(viewer.preferences.maritalStatusCodes),
      candidateMaritalStatus: candidate.profile.maritalStatusCode,
    },
  };
}

/**
 * Family expectations.
 *
 * Thin on purpose, and honestly so. `profiles.family_religiosity_code` and
 * `profiles.living_with_family_expectation_code` exist as columns and
 * `partner_preferences.living_with_family_codes` exists beside them, but none
 * of the three reference types has been seeded and none is surfaced by the
 * Phase 3 contracts. Until they are, this dimension has nothing to compare and
 * reports `applicable: false` rather than inventing a signal from free text.
 *
 * The facts say which inputs were missing, so the gap is visible in stored
 * data rather than hidden behind a neutral 50.
 */
function scoreFamily(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const preferredLiving = normalise(viewer.preferences.livingWithFamilyCodes);
  const subScore = combine([
    preferenceSignal(preferredLiving, candidate.profile.livingWithFamilyExpectationCode, 2),
    sameValueSignal(
      viewer.profile.livingWithFamilyExpectationCode,
      candidate.profile.livingWithFamilyExpectationCode,
      2,
    ),
    sameValueSignal(viewer.profile.familyReligiosityCode, candidate.profile.familyReligiosityCode),
  ]);

  return {
    subScore,
    facts: {
      preferredLivingArrangements: preferredLiving,
      viewerLivingExpectation: viewer.profile.livingWithFamilyExpectationCode ?? null,
      candidateLivingExpectation: candidate.profile.livingWithFamilyExpectationCode ?? null,
      viewerFamilyReligiosity: viewer.profile.familyReligiosityCode ?? null,
      candidateFamilyReligiosity: candidate.profile.familyReligiosityCode ?? null,
      reason: subScore === null ? 'family reference data not yet collected' : null,
    },
  };
}

/** Shared languages. A conversation needs at least one. */
function scoreLanguage(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const viewerLanguages = normalise(viewer.profile.languages);
  const candidateLanguages = normalise(candidate.profile.languages);
  const shared = intersect(viewerLanguages, candidateLanguages);
  const preferred = normalise(viewer.preferences.languageCodes);
  const preferredShared = intersect(preferred, candidateLanguages);

  const spoken: Signal =
    viewerLanguages.length > 0 && candidateLanguages.length > 0
      ? {
          // Any shared language carries most of the value; the rest rewards a
          // wider overlap without letting a long list beat a common tongue.
          score:
            shared.length > 0
              ? clamp(70 + overlapRatio(viewerLanguages, candidateLanguages) * 30)
              : 0,
          weight: 2,
        }
      : null;

  const wanted: Signal =
    preferred.length > 0 && candidateLanguages.length > 0
      ? { score: preferredShared.length > 0 ? 100 : 0, weight: 1 }
      : null;

  return {
    subScore: combine([spoken, wanted]),
    facts: {
      viewerLanguages,
      candidateLanguages,
      sharedLanguages: shared,
      preferredLanguages: preferred,
      preferredSharedLanguages: preferredShared,
    },
  };
}

/**
 * Where each lives.
 *
 * Tiered rather than measured, because `user_locations` stores country, region
 * and city and never coordinates. `maxDistanceKm` therefore has nothing to
 * compute against and is not consulted — a kilometre radius would be a number
 * invented from a city name.
 */
function scoreLocation(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const a = viewer.profile.location;
  const b = candidate.profile.location;
  const preferredCountries = normalise(viewer.preferences.countryCodes);

  const preference = preferenceSignal(preferredCountries, b?.countryCode ?? null, 2);

  let proximity: Signal = null;
  let tier: string | null = null;
  if (a && b) {
    if (a.countryCode !== b.countryCode) {
      tier = 'different_country';
      proximity = { score: 20, weight: 2 };
    } else if (a.cityName && b.cityName && a.cityName === b.cityName) {
      tier = 'same_city';
      proximity = { score: 100, weight: 2 };
    } else if (a.regionCode && b.regionCode && a.regionCode === b.regionCode) {
      tier = 'same_region';
      proximity = { score: 80, weight: 2 };
    } else {
      tier = 'same_country';
      proximity = { score: 60, weight: 2 };
    }
  }

  return {
    subScore: combine([proximity, preference]),
    facts: {
      viewerCountry: a?.countryCode ?? null,
      candidateCountry: b?.countryCode ?? null,
      viewerRegion: a?.regionCode ?? null,
      candidateRegion: b?.regionCode ?? null,
      viewerCity: a?.cityName ?? null,
      candidateCity: b?.cityName ?? null,
      proximityTier: tier,
      preferredCountries,
    },
  };
}

/** Education level against the stated preference, plus a shared field. */
function scoreEducation(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const preferred = normalise(viewer.preferences.educationLevelCodes);
  return {
    subScore: combine([
      preferenceSignal(preferred, candidate.profile.educationLevelCode, 2),
      sameValueSignal(viewer.profile.fieldOfStudyCode, candidate.profile.fieldOfStudyCode),
    ]),
    facts: {
      preferredEducationLevels: preferred,
      viewerEducationLevel: viewer.profile.educationLevelCode,
      candidateEducationLevel: candidate.profile.educationLevelCode,
      viewerFieldOfStudy: viewer.profile.fieldOfStudyCode,
      candidateFieldOfStudy: candidate.profile.fieldOfStudyCode,
    },
  };
}

/** Profession against the stated preference, plus a shared industry. */
function scoreProfession(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
): DimensionOutcome {
  const preferred = normalise(viewer.preferences.professionCodes);
  return {
    subScore: combine([
      preferenceSignal(preferred, candidate.profile.professionCode, 2),
      sameValueSignal(viewer.profile.industryCode, candidate.profile.industryCode),
    ]),
    facts: {
      preferredProfessions: preferred,
      viewerProfession: viewer.profile.professionCode,
      candidateProfession: candidate.profile.professionCode,
      viewerIndustry: viewer.profile.industryCode,
      candidateIndustry: candidate.profile.industryCode,
    },
  };
}

/**
 * Day-to-day life: interests, habits, diet, smoking.
 *
 * Profile-to-profile only. There is no preference field for any of it, which
 * is why this carries the smallest weight — it is the softest evidence the
 * engine has.
 */
function scoreLifestyle(viewer: CompatibilitySide, candidate: CompatibilitySide): DimensionOutcome {
  const viewerHobbies = normalise(viewer.profile.hobbies);
  const candidateHobbies = normalise(candidate.profile.hobbies);
  const viewerAttributes = normalise(viewer.profile.lifestyleAttributes);
  const candidateAttributes = normalise(candidate.profile.lifestyleAttributes);

  const hobbies: Signal =
    viewerHobbies.length > 0 && candidateHobbies.length > 0
      ? { score: clamp(overlapRatio(viewerHobbies, candidateHobbies) * 100), weight: 1 }
      : null;
  const attributes: Signal =
    viewerAttributes.length > 0 && candidateAttributes.length > 0
      ? { score: clamp(overlapRatio(viewerAttributes, candidateAttributes) * 100), weight: 1 }
      : null;

  return {
    subScore: combine([
      hobbies,
      attributes,
      sameValueSignal(viewer.profile.dietCode, candidate.profile.dietCode, 2),
      sameValueSignal(viewer.profile.smokingCode, candidate.profile.smokingCode, 2),
    ]),
    facts: {
      sharedHobbies: intersect(viewerHobbies, candidateHobbies),
      sharedLifestyleAttributes: intersect(viewerAttributes, candidateAttributes),
      viewerDiet: viewer.profile.dietCode,
      candidateDiet: candidate.profile.dietCode,
      viewerSmoking: viewer.profile.smokingCode,
      candidateSmoking: candidate.profile.smokingCode,
    },
  };
}

/**
 * Would the CANDIDATE accept the VIEWER?
 *
 * The one most products get wrong, and the reason it carries the heaviest
 * weight: showing someone a profile that would never accept them is worse than
 * showing nothing.
 *
 * This is the mirror of the preference checks above, run in the other
 * direction — the candidate's stated preferences against the viewer's actual
 * profile. Age is included only when the caller supplied it; the engine does
 * not compute it, because that would mean reading a clock.
 */
function scoreReciprocity(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
): DimensionOutcome {
  const theirs = candidate.preferences;
  const mine = viewer.profile;

  const practice = preferenceSignal(
    normalise(theirs.religiousPracticeCodes),
    mine.religiousPracticeCode,
    2,
  );
  const preferredSects = normalise(theirs.sectCodes);
  const sectStated = mine.sectCode !== null && mine.sectCode !== undefined;
  let sect: Signal = null;
  if (!sectStated) {
    sect = theirs.excludeUnstatedSect ? { score: 0, weight: 2 } : null;
  } else if (preferredSects.length > 0) {
    sect = { score: preferredSects.includes(mine.sectCode as string) ? 100 : 0, weight: 2 };
  }

  let acceptance: Signal = null;
  if (
    theirs.acceptsChildren !== null &&
    theirs.acceptsChildren !== undefined &&
    mine.hasChildren !== null &&
    mine.hasChildren !== undefined
  ) {
    acceptance = { score: mine.hasChildren && !theirs.acceptsChildren ? 0 : 100, weight: 2 };
  }

  const subScore = combine([
    practice,
    sect,
    acceptance,
    preferenceSignal(normalise(theirs.maritalStatusCodes), mine.maritalStatusCode),
    preferenceSignal(normalise(theirs.marriageTimelineCodes), mine.marriageTimelineCode),
    preferenceSignal(normalise(theirs.educationLevelCodes), mine.educationLevelCode),
    preferenceSignal(normalise(theirs.professionCodes), mine.professionCode),
    preferenceSignal(normalise(theirs.countryCodes), mine.location?.countryCode ?? null),
    normalise(theirs.languageCodes).length > 0 && normalise(mine.languages).length > 0
      ? {
          score:
            intersect(normalise(theirs.languageCodes), normalise(mine.languages)).length > 0
              ? 100
              : 0,
          weight: 1,
        }
      : null,
  ]);

  return {
    subScore,
    facts: {
      candidatePreferredPractice: normalise(theirs.religiousPracticeCodes),
      viewerPractice: mine.religiousPracticeCode,
      candidatePreferredSects: preferredSects,
      viewerSect: mine.sectCode,
      viewerSectStated: sectStated,
      candidateExcludesUnstatedSect: theirs.excludeUnstatedSect,
      candidateAcceptsChildren: theirs.acceptsChildren,
      viewerHasChildren: mine.hasChildren,
      candidatePreferredMaritalStatuses: normalise(theirs.maritalStatusCodes),
      viewerMaritalStatus: mine.maritalStatusCode,
      candidatePreferredTimelines: normalise(theirs.marriageTimelineCodes),
      viewerTimeline: mine.marriageTimelineCode,
      candidatePreferredEducationLevels: normalise(theirs.educationLevelCodes),
      viewerEducationLevel: mine.educationLevelCode,
      candidatePreferredProfessions: normalise(theirs.professionCodes),
      viewerProfession: mine.professionCode,
      candidatePreferredCountries: normalise(theirs.countryCodes),
      viewerCountry: mine.location?.countryCode ?? null,
      candidatePreferredLanguages: normalise(theirs.languageCodes),
      viewerLanguages: normalise(mine.languages),
      viewerAge: mine.age ?? null,
    },
  };
}

const SCORERS: Readonly<
  Record<CompatibilityDimension, (v: CompatibilitySide, c: CompatibilitySide) => DimensionOutcome>
> = {
  religious: scoreReligious,
  timeline: scoreTimeline,
  relocation: scoreRelocation,
  children: scoreChildren,
  family: scoreFamily,
  language: scoreLanguage,
  location: scoreLocation,
  education: scoreEducation,
  profession: scoreProfession,
  lifestyle: scoreLifestyle,
  reciprocity: scoreReciprocity,
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Scores one directed pair.
 *
 * DIRECTIONAL, like `compatibility_scores` itself: A's score for B differs
 * from B's for A, because the preferences differ. Scoring a pair once and
 * showing both people the same number would mean one of them is reading
 * someone else's answer.
 *
 * A dimension that found nothing to compare is EXCLUDED from the mean rather
 * than scored as zero or as fifty. A missing optional field is an absence of
 * evidence, and letting it pull the score toward either end would make an
 * incomplete profile look incompatible rather than unknown. The weights are
 * renormalised over whatever did apply.
 *
 * With no applicable dimension at all the overall score is 0 — the engine
 * fails closed, and the factors say exactly why.
 */
export function scoreCompatibility(
  viewer: CompatibilitySide,
  candidate: CompatibilitySide,
): CompatibilityResult {
  const factors: CompatibilityFactor[] = COMPATIBILITY_DIMENSIONS.map((dimension) => {
    const outcome = SCORERS[dimension](viewer, candidate);
    const rule = ruleFor(viewer.rules, dimension);
    const weight =
      rule && Number.isFinite(rule.weight) && rule.weight >= 0
        ? rule.weight
        : DIMENSION_WEIGHTS[dimension];

    return {
      dimension,
      subScore: outcome.subScore === null ? null : round(outcome.subScore),
      applicable: outcome.subScore !== null,
      weight,
      isHard: rule?.isHard ?? false,
      facts: outcome.facts,
      explanationKey: `compatibility.${dimension}`,
    };
  });

  const applied = factors.filter((f) => f.applicable && f.weight > 0);
  const totalWeight = applied.reduce((sum, f) => sum + f.weight, 0);
  const overall =
    totalWeight > 0
      ? round(
          clamp(
            applied.reduce((sum, f) => sum + (f.subScore as number) * f.weight, 0) / totalWeight,
          ),
        )
      : 0;

  return { overall, engineVersion: ENGINE_VERSION, factors };
}
