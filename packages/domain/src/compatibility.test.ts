import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_DIMENSIONS,
  DIMENSION_WEIGHTS,
  ENGINE_VERSION,
  scoreCompatibility,
  type CompatibilityDimension,
  type CompatibilityPreferences,
  type CompatibilityProfile,
  type CompatibilitySide,
} from './compatibility';
import type { OwnProfile, Preferences } from './profile';

/**
 * The deterministic compatibility engine.
 *
 * Two properties carry the whole ADR 0001 bargain, and they are what these
 * tests are mostly about:
 *
 *   * **Same inputs, same output.** Not approximately — identically, forever.
 *     If that is not true, the explanation is not reproducible and a complaint
 *     months later cannot be investigated.
 *   * **Every fact traces to an input.** A sub-score with no facts behind it
 *     is a number nobody can defend.
 */

const EMPTY_PROFILE: CompatibilityProfile = {
  userId: 'u-empty',
  languages: [],
  maritalStatusCode: null,
  hasChildren: null,
  childrenCount: null,
  childrenLiveWithMe: null,
  marriageTimelineCode: null,
  relocationWillingnessCode: null,
  relocationTargetCountries: [],
  educationLevelCode: null,
  fieldOfStudyCode: null,
  professionCode: null,
  industryCode: null,
  religiousPracticeCode: null,
  sectCode: null,
  prayerFrequencyCode: null,
  quranLevelCode: null,
  dressPracticeCode: null,
  hobbies: [],
  lifestyleAttributes: [],
  dietCode: null,
  smokingCode: null,
  location: null,
};

const EMPTY_PREFERENCES: CompatibilityPreferences = {
  countryCodes: [],
  languageCodes: [],
  educationLevelCodes: [],
  professionCodes: [],
  religiousPracticeCodes: [],
  sectCodes: [],
  excludeUnstatedSect: false,
  maritalStatusCodes: [],
  acceptsChildren: null,
  marriageTimelineCodes: [],
  relocationRequired: null,
};

function profile(overrides: Partial<CompatibilityProfile> = {}): CompatibilityProfile {
  return { ...EMPTY_PROFILE, ...overrides };
}
function preferences(overrides: Partial<CompatibilityPreferences> = {}): CompatibilityPreferences {
  return { ...EMPTY_PREFERENCES, ...overrides };
}
function side(
  p: Partial<CompatibilityProfile> = {},
  prefs: Partial<CompatibilityPreferences> = {},
  rules?: CompatibilitySide['rules'],
): CompatibilitySide {
  return rules
    ? { profile: profile(p), preferences: preferences(prefs), rules }
    : { profile: profile(p), preferences: preferences(prefs) };
}

/** The factor for one dimension, which every test needs. */
function factor(result: ReturnType<typeof scoreCompatibility>, dimension: CompatibilityDimension) {
  const found = result.factors.find((f) => f.dimension === dimension);
  if (!found) throw new Error(`no factor for ${dimension}`);
  return found;
}

// ---------------------------------------------------------------------------
// Shape and contract
// ---------------------------------------------------------------------------

describe('the model', () => {
  it('scores exactly the 11 confirmed dimensions', () => {
    expect([...COMPATIBILITY_DIMENSIONS]).toEqual([
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
    ]);
    expect(COMPATIBILITY_DIMENSIONS).toHaveLength(11);
  });

  it('does NOT score personality', () => {
    // README §10.1 prose lists it; the ERD enumeration does not, and the ERD
    // is authoritative. The profile still carries personalityTraits.
    expect([...COMPATIBILITY_DIMENSIONS]).not.toContain('personality');
    const result = scoreCompatibility(side(), side());
    expect(result.factors.map((f) => f.dimension)).not.toContain('personality');
  });

  it('counts reciprocity exactly once', () => {
    const result = scoreCompatibility(side(), side());
    const reciprocity = result.factors.filter((f) => f.dimension === 'reciprocity');
    expect(reciprocity).toHaveLength(1);
    // And it is a dimension, not an extra multiplier layered over the mean.
    expect(Object.keys(DIMENSION_WEIGHTS)).toContain('reciprocity');
  });

  it('emits one factor per dimension, always, even when nothing applies', () => {
    const result = scoreCompatibility(side(), side());
    expect(result.factors).toHaveLength(11);
    expect(result.factors.map((f) => f.dimension).sort()).toEqual(
      [...COMPATIBILITY_DIMENSIONS].sort(),
    );
  });

  it('reports the engine version on every result', () => {
    expect(scoreCompatibility(side(), side()).engineVersion).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('gives every dimension a weight', () => {
    for (const dimension of COMPATIBILITY_DIMENSIONS) {
      expect(DIMENSION_WEIGHTS[dimension], dimension).toBeGreaterThan(0);
    }
  });

  it('weights reciprocity highest, because it is the one most products get wrong', () => {
    const max = Math.max(...Object.values(DIMENSION_WEIGHTS));
    expect(DIMENSION_WEIGHTS.reciprocity).toBe(max);
  });

  it('carries an i18n key per factor rather than prose', () => {
    // EXPLAIN renders from the catalogs. The engine never writes a sentence.
    for (const f of scoreCompatibility(side(), side()).factors) {
      expect(f.explanationKey).toBe(`compatibility.${f.dimension}`);
    }
  });

  it('accepts the real domain types without a mapping layer', () => {
    // A compile-time assertion as much as a runtime one: if OwnProfile or
    // Preferences drift away from the engine input, this stops building.
    const own = {} as OwnProfile;
    const prefs = {} as Preferences;
    const asProfile: CompatibilityProfile = { ...EMPTY_PROFILE, ...own };
    const asPreferences: CompatibilityPreferences = { ...EMPTY_PREFERENCES, ...prefs };
    expect(asProfile).toBeDefined();
    expect(asPreferences).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism — the property the whole ADR rests on
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const viewer = side(
    {
      userId: 'v',
      languages: ['english', 'urdu'],
      religiousPracticeCode: 'rel_practising',
      sectCode: 'sunni',
      marriageTimelineCode: 'within_year',
      maritalStatusCode: 'ms_never_married',
      hasChildren: false,
      educationLevelCode: 'edu_bachelors',
      professionCode: 'prof_engineer',
      hobbies: ['reading', 'hiking'],
      location: { countryCode: 'pk', regionCode: 'pb', cityName: 'Lahore' },
    },
    { religiousPracticeCodes: ['rel_practising'], countryCodes: ['pk'] },
  );
  const candidate = side(
    {
      userId: 'c',
      languages: ['english'],
      religiousPracticeCode: 'rel_practising',
      sectCode: 'sunni',
      marriageTimelineCode: 'within_year',
      maritalStatusCode: 'ms_never_married',
      hasChildren: false,
      educationLevelCode: 'edu_masters',
      professionCode: 'prof_doctor',
      hobbies: ['reading'],
      location: { countryCode: 'pk', regionCode: 'pb', cityName: 'Lahore' },
    },
    { religiousPracticeCodes: ['rel_practising'] },
  );

  it('produces an identical result when run twice', () => {
    const first = scoreCompatibility(viewer, candidate);
    const second = scoreCompatibility(viewer, candidate);
    expect(second).toEqual(first);
    // Byte-identical once serialised, which is what makes stored scores
    // comparable across runs.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('stays identical across many runs', () => {
    const baseline = JSON.stringify(scoreCompatibility(viewer, candidate));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(scoreCompatibility(viewer, candidate))).toBe(baseline);
    }
  });

  it('does not depend on the order values were supplied in', () => {
    // Facts sort before they report, so a reordered array is the same input.
    const reordered = side(
      { ...candidate.profile, languages: ['english'], hobbies: ['reading'] },
      candidate.preferences,
    );
    const a = scoreCompatibility(viewer, candidate);
    const b = scoreCompatibility(viewer, reordered);
    expect(b.overall).toBe(a.overall);
  });

  it('is directional — A for B is not B for A', () => {
    // compatibility_scores is keyed (viewer, candidate) for this reason: the
    // preferences differ, so one number cannot serve both people.
    //
    // A states a preference and B states none, so each direction is carried by
    // a different dimension: A's own education preference going forward, and
    // reciprocity against A's preference coming back.
    const picky = side(
      { educationLevelCode: 'edu_masters', marriageTimelineCode: 'within_year' },
      { educationLevelCodes: ['edu_masters'] },
    );
    const open = side({ educationLevelCode: 'edu_masters', marriageTimelineCode: 'no_rush' });

    const forward = scoreCompatibility(picky, open);
    const backward = scoreCompatibility(open, picky);

    expect(forward.factors.map((f) => f.dimension)).toEqual(
      backward.factors.map((f) => f.dimension),
    );

    // Different dimensions carry each direction.
    expect(factor(forward, 'education').applicable).toBe(true);
    expect(factor(forward, 'reciprocity').applicable).toBe(false);
    expect(factor(backward, 'education').applicable).toBe(false);
    expect(factor(backward, 'reciprocity').applicable).toBe(true);

    expect(forward.overall).not.toBe(backward.overall);

    // Reciprocity compares opposite sides by definition, so its facts differ.
    expect(factor(forward, 'reciprocity').facts).not.toEqual(factor(backward, 'reciprocity').facts);
  });

  it('never produces a score outside 0-100', () => {
    const extremes: CompatibilitySide[] = [
      side(),
      viewer,
      candidate,
      side({ languages: Array.from({ length: 40 }, (_, i) => `lang_${i}`) }),
    ];
    for (const a of extremes) {
      for (const b of extremes) {
        const result = scoreCompatibility(a, b);
        expect(result.overall).toBeGreaterThanOrEqual(0);
        expect(result.overall).toBeLessThanOrEqual(100);
        for (const f of result.factors) {
          if (f.subScore !== null) {
            expect(f.subScore, f.dimension).toBeGreaterThanOrEqual(0);
            expect(f.subScore, f.dimension).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Missing and empty data
// ---------------------------------------------------------------------------

describe('absence of evidence', () => {
  it('marks every dimension inapplicable for two empty profiles', () => {
    const result = scoreCompatibility(side(), side());
    for (const f of result.factors) {
      expect(f.applicable, f.dimension).toBe(false);
      expect(f.subScore, f.dimension).toBeNull();
    }
  });

  it('fails closed to 0 when nothing at all applies', () => {
    expect(scoreCompatibility(side(), side()).overall).toBe(0);
  });

  it('EXCLUDES an inapplicable dimension rather than scoring it 0 or 50', () => {
    // The distinction that matters: an incomplete profile should look
    // UNKNOWN, not incompatible. Scoring a missing field as zero would bury
    // every new member.
    const viewer = side({ marriageTimelineCode: 'within_year' }, {});
    const candidate = side({ marriageTimelineCode: 'within_year' }, {});
    const result = scoreCompatibility(viewer, candidate);

    expect(factor(result, 'timeline').subScore).toBe(100);
    expect(factor(result, 'lifestyle').applicable).toBe(false);
    // Only the applicable dimension counted, so the mean is its score.
    expect(result.overall).toBe(100);
  });

  it('treats an empty preference list as "no constraint", not "no match"', () => {
    // Punishing the most open members would be exactly backwards. Both sides
    // share an observance, so the dimension HAS a signal — and the empty
    // preference list must not pull it down.
    const open = scoreCompatibility(
      side(
        { religiousPracticeCode: 'rel_practising', prayerFrequencyCode: 'five_daily' },
        { religiousPracticeCodes: [] },
      ),
      side({ religiousPracticeCode: 'rel_practising', prayerFrequencyCode: 'five_daily' }),
    );
    expect(factor(open, 'religious').subScore).toBe(100);
  });

  it('is inapplicable, not zero, when a preference list is the only input', () => {
    const none = scoreCompatibility(
      side({ religiousPracticeCode: 'rel_practising' }, { religiousPracticeCodes: [] }),
      side({ religiousPracticeCode: 'rel_practising' }),
    );
    expect(factor(none, 'religious').subScore).not.toBe(0);
    expect(factor(none, 'religious').applicable).toBe(false);
  });

  it('handles a one-sided profile without throwing', () => {
    const filled = side({
      languages: ['english'],
      location: { countryCode: 'pk', regionCode: null, cityName: null },
    });
    expect(() => scoreCompatibility(filled, side())).not.toThrow();
    expect(() => scoreCompatibility(side(), filled)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-dimension behaviour
// ---------------------------------------------------------------------------

describe('religious', () => {
  it('scores an exact practice and sect match at 100', () => {
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'], sectCodes: ['sunni'] }),
      side({ religiousPracticeCode: 'rel_practising', sectCode: 'sunni' }),
    );
    expect(factor(result, 'religious').subScore).toBe(100);
  });

  it('scores a practice mismatch at 0', () => {
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'] }),
      side({ religiousPracticeCode: 'rel_occasionally' }),
    );
    expect(factor(result, 'religious').subScore).toBe(0);
  });

  it('does NOT penalise an unstated sect on its own (A2)', () => {
    // Declining to state a sect is a legitimate choice in this product, and
    // the schema comment says it must never be auto-excluded.
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'], sectCodes: ['sunni'] }),
      side({ religiousPracticeCode: 'rel_practising', sectCode: null }),
    );
    expect(factor(result, 'religious').subScore).toBe(100);
    expect(factor(result, 'religious').facts.sectStated).toBe(false);
  });

  it('penalises an unstated sect ONLY when the viewer opted in', () => {
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'], excludeUnstatedSect: true }),
      side({ religiousPracticeCode: 'rel_practising', sectCode: null }),
    );
    expect(factor(result, 'religious').subScore).toBeLessThan(100);
    expect(factor(result, 'religious').facts.excludeUnstatedSect).toBe(true);
  });

  it('records what it compared', () => {
    const result = scoreCompatibility(
      side({ prayerFrequencyCode: 'five_daily' }, { religiousPracticeCodes: ['rel_practising'] }),
      side({ religiousPracticeCode: 'rel_practising', prayerFrequencyCode: 'five_daily' }),
    );
    const facts = factor(result, 'religious').facts;
    expect(facts.candidatePractice).toBe('rel_practising');
    expect(facts.preferredPractice).toEqual(['rel_practising']);
    expect(facts.viewerPrayerFrequency).toBe('five_daily');
    expect(facts.candidatePrayerFrequency).toBe('five_daily');
  });
});

describe('timeline', () => {
  it('rewards two people who want the same thing', () => {
    const result = scoreCompatibility(
      side({ marriageTimelineCode: 'within_year' }),
      side({ marriageTimelineCode: 'within_year' }),
    );
    expect(factor(result, 'timeline').subScore).toBe(100);
    expect(factor(result, 'timeline').facts.sameTimeline).toBe(true);
  });

  it('separates different timelines', () => {
    const result = scoreCompatibility(
      side({ marriageTimelineCode: 'within_year' }),
      side({ marriageTimelineCode: 'within_three_years' }),
    );
    expect(factor(result, 'timeline').subScore).toBe(0);
    expect(factor(result, 'timeline').facts.sameTimeline).toBe(false);
  });

  it('is partial when the preference matches but the timelines differ', () => {
    const result = scoreCompatibility(
      side(
        { marriageTimelineCode: 'within_year' },
        { marriageTimelineCodes: ['within_three_years'] },
      ),
      side({ marriageTimelineCode: 'within_three_years' }),
    );
    const score = factor(result, 'timeline').subScore as number;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe('relocation', () => {
  it('rewards shared target countries', () => {
    const result = scoreCompatibility(
      side({ relocationTargetCountries: ['ca', 'gb'] }),
      side({ relocationTargetCountries: ['gb', 'ca'] }),
    );
    expect(factor(result, 'relocation').subScore).toBe(100);
    expect(factor(result, 'relocation').facts.sharedTargetCountries).toEqual(['ca', 'gb']);
  });

  it('scores disjoint targets at 0', () => {
    const result = scoreCompatibility(
      side({ relocationTargetCountries: ['ca'] }),
      side({ relocationTargetCountries: ['au'] }),
    );
    expect(factor(result, 'relocation').subScore).toBe(0);
  });

  it('fails a required relocation against an explicit refusal', () => {
    const result = scoreCompatibility(
      side({}, { relocationRequired: true }),
      side({ relocationWillingnessCode: 'reloc_no' }),
    );
    expect(factor(result, 'relocation').subScore).toBe(0);
  });

  it('passes a required relocation against a willing candidate', () => {
    const result = scoreCompatibility(
      side({}, { relocationRequired: true }),
      side({ relocationWillingnessCode: 'reloc_yes' }),
    );
    expect(factor(result, 'relocation').subScore).toBe(100);
  });
});

describe('children', () => {
  it('fails a candidate with children when the viewer does not accept them', () => {
    const result = scoreCompatibility(
      side({}, { acceptsChildren: false }),
      side({ hasChildren: true, childrenCount: 2 }),
    );
    expect(factor(result, 'children').subScore).toBe(0);
    expect(factor(result, 'children').facts.candidateChildrenCount).toBe(2);
  });

  it('accepts a candidate with children when the viewer does', () => {
    const result = scoreCompatibility(
      side({}, { acceptsChildren: true }),
      side({ hasChildren: true }),
    );
    expect(factor(result, 'children').subScore).toBe(100);
  });

  it('does not penalise a childless candidate either way', () => {
    for (const accepts of [true, false]) {
      const result = scoreCompatibility(
        side({}, { acceptsChildren: accepts }),
        side({ hasChildren: false }),
      );
      expect(factor(result, 'children').subScore, `accepts=${accepts}`).toBe(100);
    }
  });

  it('considers marital status', () => {
    const result = scoreCompatibility(
      side({}, { maritalStatusCodes: ['ms_never_married'] }),
      side({ maritalStatusCode: 'ms_divorced' }),
    );
    expect(factor(result, 'children').subScore).toBe(0);
  });
});

describe('family', () => {
  it('is inapplicable while the family reference data is uncollected', () => {
    // Honest rather than neutral: the gap is recorded in the facts instead of
    // hidden behind a 50 nobody can account for.
    const result = scoreCompatibility(side(), side());
    const f = factor(result, 'family');
    expect(f.applicable).toBe(false);
    expect(f.facts.reason).toBe('family reference data not yet collected');
  });

  it('scores the moment those codes are supplied', () => {
    const result = scoreCompatibility(
      side({ livingWithFamilyExpectationCode: 'with_family' }, {}),
      side({ livingWithFamilyExpectationCode: 'with_family' }),
    );
    expect(factor(result, 'family').applicable).toBe(true);
    expect(factor(result, 'family').subScore).toBe(100);
  });

  it('separates different living expectations', () => {
    const result = scoreCompatibility(
      side({ livingWithFamilyExpectationCode: 'with_family' }),
      side({ livingWithFamilyExpectationCode: 'separate_home' }),
    );
    expect(factor(result, 'family').subScore).toBe(0);
  });
});

describe('language', () => {
  it('rewards a fully shared set', () => {
    const result = scoreCompatibility(
      side({ languages: ['english', 'urdu'] }),
      side({ languages: ['urdu', 'english'] }),
    );
    expect(factor(result, 'language').subScore).toBe(100);
    expect(factor(result, 'language').facts.sharedLanguages).toEqual(['english', 'urdu']);
  });

  it('scores no overlap at 0', () => {
    const result = scoreCompatibility(
      side({ languages: ['english'] }),
      side({ languages: ['tamil'] }),
    );
    expect(factor(result, 'language').subScore).toBe(0);
    expect(factor(result, 'language').facts.sharedLanguages).toEqual([]);
  });

  it('scores a partial overlap between the two', () => {
    const result = scoreCompatibility(
      side({ languages: ['english', 'urdu', 'punjabi'] }),
      side({ languages: ['english'] }),
    );
    const score = factor(result, 'language').subScore as number;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe('location', () => {
  const at = (countryCode: string, regionCode: string | null, cityName: string | null) =>
    side({ location: { countryCode, regionCode, cityName } });

  it('ranks the tiers in order: same city > region > country > abroad', () => {
    const viewer = at('pk', 'pb', 'Lahore');
    const sameCity = factor(scoreCompatibility(viewer, at('pk', 'pb', 'Lahore')), 'location')
      .subScore as number;
    const sameRegion = factor(scoreCompatibility(viewer, at('pk', 'pb', 'Kasur')), 'location')
      .subScore as number;
    const sameCountry = factor(scoreCompatibility(viewer, at('pk', 'sd', 'Karachi')), 'location')
      .subScore as number;
    const abroad = factor(scoreCompatibility(viewer, at('gb', 'ldn', 'London')), 'location')
      .subScore as number;

    expect(sameCity).toBeGreaterThan(sameRegion);
    expect(sameRegion).toBeGreaterThan(sameCountry);
    expect(sameCountry).toBeGreaterThan(abroad);
  });

  it('records the tier it chose', () => {
    const result = scoreCompatibility(at('pk', 'pb', 'Lahore'), at('pk', 'pb', 'Lahore'));
    expect(factor(result, 'location').facts.proximityTier).toBe('same_city');
  });

  it('is inapplicable when either side has no location', () => {
    expect(factor(scoreCompatibility(at('pk', null, null), side()), 'location').applicable).toBe(
      false,
    );
  });
});

describe('education and profession', () => {
  it('matches a preferred education level', () => {
    const result = scoreCompatibility(
      side({}, { educationLevelCodes: ['edu_masters'] }),
      side({ educationLevelCode: 'edu_masters' }),
    );
    expect(factor(result, 'education').subScore).toBe(100);
  });

  it('separates a different education level', () => {
    const result = scoreCompatibility(
      side({}, { educationLevelCodes: ['edu_masters'] }),
      side({ educationLevelCode: 'edu_highschool' }),
    );
    expect(factor(result, 'education').subScore).toBe(0);
  });

  it('matches a preferred profession and a shared industry', () => {
    const result = scoreCompatibility(
      side({ industryCode: 'healthcare' }, { professionCodes: ['prof_doctor'] }),
      side({ professionCode: 'prof_doctor', industryCode: 'healthcare' }),
    );
    expect(factor(result, 'profession').subScore).toBe(100);
  });

  it('separates a different profession', () => {
    const result = scoreCompatibility(
      side({}, { professionCodes: ['prof_doctor'] }),
      side({ professionCode: 'prof_engineer' }),
    );
    expect(factor(result, 'profession').subScore).toBe(0);
  });
});

describe('lifestyle', () => {
  it('rewards shared habits', () => {
    const result = scoreCompatibility(
      side({ hobbies: ['reading'], dietCode: 'halal', smokingCode: 'never' }),
      side({ hobbies: ['reading'], dietCode: 'halal', smokingCode: 'never' }),
    );
    expect(factor(result, 'lifestyle').subScore).toBe(100);
  });

  it('separates opposite habits', () => {
    const result = scoreCompatibility(
      side({ hobbies: ['reading'], smokingCode: 'never' }),
      side({ hobbies: ['gaming'], smokingCode: 'daily' }),
    );
    expect(factor(result, 'lifestyle').subScore).toBe(0);
  });

  it('reports the overlap it found', () => {
    const result = scoreCompatibility(
      side({ hobbies: ['reading', 'hiking'] }),
      side({ hobbies: ['hiking', 'cooking'] }),
    );
    expect(factor(result, 'lifestyle').facts.sharedHobbies).toEqual(['hiking']);
  });
});

describe('reciprocity', () => {
  it('is high when the candidate preferences accept the viewer', () => {
    const result = scoreCompatibility(
      side({ religiousPracticeCode: 'rel_practising', maritalStatusCode: 'ms_never_married' }),
      side(
        {},
        {
          religiousPracticeCodes: ['rel_practising'],
          maritalStatusCodes: ['ms_never_married'],
        },
      ),
    );
    expect(factor(result, 'reciprocity').subScore).toBe(100);
  });

  it('is 0 when the candidate would never accept the viewer', () => {
    // Showing someone a profile that would reject them is worse than showing
    // nothing, which is why this dimension carries the heaviest weight.
    const result = scoreCompatibility(
      side({ religiousPracticeCode: 'rel_occasionally' }),
      side({}, { religiousPracticeCodes: ['rel_practising'] }),
    );
    expect(factor(result, 'reciprocity').subScore).toBe(0);
  });

  it('honours the candidate position on children, against the viewer', () => {
    const result = scoreCompatibility(
      side({ hasChildren: true }),
      side({}, { acceptsChildren: false }),
    );
    expect(factor(result, 'reciprocity').subScore).toBe(0);
    expect(factor(result, 'reciprocity').facts.viewerHasChildren).toBe(true);
  });

  it('respects A2 in this direction too', () => {
    const result = scoreCompatibility(
      side({ religiousPracticeCode: 'rel_practising', sectCode: null }),
      side({}, { religiousPracticeCodes: ['rel_practising'], sectCodes: ['sunni'] }),
    );
    // The viewer did not state a sect, and the candidate did not opt into
    // excluding that — so it must not count against them.
    expect(factor(result, 'reciprocity').subScore).toBe(100);
  });

  it('is inapplicable when the candidate stated no preferences at all', () => {
    const result = scoreCompatibility(side({ religiousPracticeCode: 'rel_practising' }), side());
    expect(factor(result, 'reciprocity').applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hard vs soft preference rules
// ---------------------------------------------------------------------------

describe('preference_rules', () => {
  it('NEVER excludes on a hard rule — exclusion is FILTER work', () => {
    // The engine scores; the filter drops. A hard mismatch arriving here still
    // produces a factor, because by this point the decision was made upstream.
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'] }, [
        { criterion: 'religious', isHard: true, weight: 1 },
      ]),
      side({ religiousPracticeCode: 'rel_occasionally' }),
    );
    expect(factor(result, 'religious').subScore).toBe(0);
    expect(factor(result, 'religious').isHard).toBe(true);
    expect(result.factors).toHaveLength(11);
  });

  it('marks which criteria are hard, so FILTER can read them', () => {
    const result = scoreCompatibility(
      side({}, {}, [
        { criterion: 'religious', isHard: true, weight: 1 },
        { criterion: 'lifestyle', isHard: false, weight: 0.2 },
      ]),
      side(),
    );
    expect(factor(result, 'religious').isHard).toBe(true);
    expect(factor(result, 'lifestyle').isHard).toBe(false);
    expect(factor(result, 'timeline').isHard).toBe(false);
  });

  it('lets a soft rule weight override the default', () => {
    const result = scoreCompatibility(
      side({}, {}, [{ criterion: 'lifestyle', isHard: false, weight: 0.9 }]),
      side(),
    );
    expect(factor(result, 'lifestyle').weight).toBe(0.9);
    expect(factor(result, 'timeline').weight).toBe(DIMENSION_WEIGHTS.timeline);
  });

  it('changes the overall score through weight, not through exclusion', () => {
    const viewerProfile = { marriageTimelineCode: 'within_year', hobbies: ['reading'] };
    const candidate = side({ marriageTimelineCode: 'within_three_years', hobbies: ['reading'] });

    const defaults = scoreCompatibility(side(viewerProfile), candidate);
    const lifestyleHeavy = scoreCompatibility(
      side(viewerProfile, {}, [{ criterion: 'lifestyle', isHard: false, weight: 10 }]),
      candidate,
    );
    // Timeline mismatch (0) and lifestyle match (100); leaning on lifestyle
    // must raise the overall, and both factors must still be present.
    expect(lifestyleHeavy.overall).toBeGreaterThan(defaults.overall);
    expect(lifestyleHeavy.factors).toHaveLength(11);
  });

  it('ignores a nonsensical rule weight rather than producing NaN', () => {
    const result = scoreCompatibility(
      side({ marriageTimelineCode: 'within_year' }, {}, [
        { criterion: 'timeline', isHard: false, weight: Number.NaN },
        { criterion: 'religious', isHard: false, weight: -5 },
      ]),
      side({ marriageTimelineCode: 'within_year' }),
    );
    expect(factor(result, 'timeline').weight).toBe(DIMENSION_WEIGHTS.timeline);
    expect(factor(result, 'religious').weight).toBe(DIMENSION_WEIGHTS.religious);
    expect(Number.isFinite(result.overall)).toBe(true);
  });

  it('ignores a rule naming a criterion that is not a dimension', () => {
    const result = scoreCompatibility(
      side({}, {}, [{ criterion: 'personality', isHard: true, weight: 1 }]),
      side(),
    );
    expect(result.factors).toHaveLength(11);
    expect(result.factors.every((f) => !f.isHard)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overall score and boundaries
// ---------------------------------------------------------------------------

describe('the overall score', () => {
  it('is 100 when every applicable dimension is a perfect match', () => {
    const shared: Partial<CompatibilityProfile> = {
      languages: ['english'],
      religiousPracticeCode: 'rel_practising',
      sectCode: 'sunni',
      marriageTimelineCode: 'within_year',
      maritalStatusCode: 'ms_never_married',
      hasChildren: false,
      relocationTargetCountries: ['ca'],
      educationLevelCode: 'edu_masters',
      professionCode: 'prof_doctor',
      hobbies: ['reading'],
      dietCode: 'halal',
      smokingCode: 'never',
      livingWithFamilyExpectationCode: 'with_family',
      location: { countryCode: 'pk', regionCode: 'pb', cityName: 'Lahore' },
    };
    const prefs: Partial<CompatibilityPreferences> = {
      religiousPracticeCodes: ['rel_practising'],
      sectCodes: ['sunni'],
      marriageTimelineCodes: ['within_year'],
      maritalStatusCodes: ['ms_never_married'],
      educationLevelCodes: ['edu_masters'],
      professionCodes: ['prof_doctor'],
      countryCodes: ['pk'],
      languageCodes: ['english'],
      acceptsChildren: true,
      livingWithFamilyCodes: ['with_family'],
    };
    const result = scoreCompatibility(side(shared, prefs), side(shared, prefs));
    expect(result.overall).toBe(100);
    expect(result.factors.every((f) => f.applicable)).toBe(true);
  });

  it('is 0 when every applicable dimension fails', () => {
    const viewer = side(
      { religiousPracticeCode: 'rel_practising', marriageTimelineCode: 'within_year' },
      {
        religiousPracticeCodes: ['rel_practising'],
        marriageTimelineCodes: ['within_year'],
        educationLevelCodes: ['edu_masters'],
      },
    );
    const candidate = side(
      {
        religiousPracticeCode: 'rel_not_practising',
        marriageTimelineCode: 'no_rush',
        educationLevelCode: 'edu_highschool',
      },
      { religiousPracticeCodes: ['rel_not_practising'] },
    );
    const result = scoreCompatibility(viewer, candidate);
    expect(result.overall).toBe(0);
  });

  it('lands between the extremes for a partial match', () => {
    const result = scoreCompatibility(
      side(
        { marriageTimelineCode: 'within_year', languages: ['english'] },
        { religiousPracticeCodes: ['rel_practising'] },
      ),
      side({
        marriageTimelineCode: 'within_year',
        languages: ['tamil'],
        religiousPracticeCode: 'rel_practising',
      }),
    );
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).toBeLessThan(100);
  });

  it('scores an identical pair the same both ways', () => {
    const same = side(
      { languages: ['english'], marriageTimelineCode: 'within_year' },
      { marriageTimelineCodes: ['within_year'] },
    );
    const forward = scoreCompatibility(same, same);
    const backward = scoreCompatibility(same, same);
    expect(forward.overall).toBe(backward.overall);
    expect(forward.overall).toBe(100);
  });

  it('rounds to one decimal, so stored scores compare cleanly', () => {
    const result = scoreCompatibility(
      side({ marriageTimelineCode: 'within_year', languages: ['english', 'urdu', 'punjabi'] }, {}),
      side({ marriageTimelineCode: 'no_rush', languages: ['english'] }),
    );
    expect(result.overall).toBe(Math.round(result.overall * 10) / 10);
    for (const f of result.factors) {
      if (f.subScore !== null) expect(f.subScore).toBe(Math.round(f.subScore * 10) / 10);
    }
  });
});

// ---------------------------------------------------------------------------
// Hostile and malformed input
// ---------------------------------------------------------------------------

describe('malformed input', () => {
  it('ignores empty-string and duplicate reference codes', () => {
    const result = scoreCompatibility(
      side({ languages: ['english', 'english', ''] }),
      side({ languages: ['english', ''] }),
    );
    expect(factor(result, 'language').facts.viewerLanguages).toEqual(['english']);
    expect(factor(result, 'language').subScore).toBe(100);
  });

  it('treats an unrecognised reference code as a plain mismatch, not an error', () => {
    // The engine does not know the reference catalog and must not pretend to.
    // An unknown code simply fails to match.
    const result = scoreCompatibility(
      side({}, { religiousPracticeCodes: ['rel_practising'] }),
      side({ religiousPracticeCode: 'not_a_real_code' }),
    );
    expect(factor(result, 'religious').subScore).toBe(0);
    expect(factor(result, 'religious').facts.candidatePractice).toBe('not_a_real_code');
  });

  it('survives undefined arrays arriving from an untyped caller', () => {
    const broken = {
      profile: { ...EMPTY_PROFILE, languages: undefined as unknown as string[] },
      preferences: { ...EMPTY_PREFERENCES, sectCodes: undefined as unknown as string[] },
    };
    expect(() => scoreCompatibility(broken, side())).not.toThrow();
    expect(Number.isFinite(scoreCompatibility(broken, side()).overall)).toBe(true);
  });

  it('never emits NaN as a score', () => {
    const result = scoreCompatibility(
      side({ languages: ['english'] }, {}, [{ criterion: 'language', isHard: false, weight: 0 }]),
      side({ languages: ['english'] }),
    );
    expect(Number.isNaN(result.overall)).toBe(false);
    for (const f of result.factors) {
      if (f.subScore !== null) expect(Number.isNaN(f.subScore)).toBe(false);
    }
  });
});
