import { z } from 'zod';
import { FIELD_VISIBILITIES, GENDERS, LOCATION_PRECISIONS } from './constants';
import { countryCodeSchema, referenceCodeSchema, timestampSchema } from './common';

/**
 * Profile, location and partner preferences.
 *
 * Mirrors the Profile and Preferences sections of docs/openapi.yaml and the
 * columns in docs/ERD.md §4, §6 and §8, so a drift between the app, the API
 * and the schema is a type error rather than a production bug.
 *
 * Every `*Code` field holds a `reference_items.code`, never a display string.
 * Storing "Bachelor's Degree" would make the field untranslatable and break
 * filtering across languages (README §8 rule 2).
 */

export const REVIEW_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Free text, bounded to match the CHECK constraints on `profiles`. */
const longText = z.string().max(2000);
const shortText = z.string().max(160);

/** Reference codes as an array. Deduplicated, because the UI can double-tap. */
const codeArray = z
  .array(referenceCodeSchema)
  .max(40)
  .transform((values) => [...new Set(values)]);

const countryArray = z
  .array(countryCodeSchema)
  .max(40)
  .transform((values) => [...new Set(values)]);

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export const locationSchema = z.object({
  countryCode: countryCodeSchema,
  regionCode: z.string().max(64).nullable(),
  cityName: z.string().max(120).nullable(),
  displayPrecision: z.enum(LOCATION_PRECISIONS),
});
export type ProfileLocation = z.infer<typeof locationSchema>;

export const locationUpdateSchema = z
  .object({
    countryCode: countryCodeSchema,
    regionCode: z.string().max(64).nullable(),
    cityName: z.string().max(120).nullable(),
    displayPrecision: z.enum(LOCATION_PRECISIONS),
  })
  .partial();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

// ---------------------------------------------------------------------------
// Sensitive
// ---------------------------------------------------------------------------

/**
 * Returned to the owner only, and never included in another member's view.
 *
 * These live in `profile_sensitive`, a table with zero RLS policies — so "hide
 * my workplace" is structurally true rather than a flag someone forgets to
 * check.
 */
export const profileSensitiveSchema = z.object({
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  employerName: z.string().nullable(),
  workplaceCity: z.string().nullable(),
});
export type ProfileSensitive = z.infer<typeof profileSensitiveSchema>;

// ---------------------------------------------------------------------------
// Own profile
// ---------------------------------------------------------------------------

export const ownProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  gender: z.enum(GENDERS).nullable(),

  aboutMe: z.string().nullable(),
  lookingFor: z.string().nullable(),

  nationalityCode: z.string().nullable(),
  languages: z.array(z.string()),
  heightCm: z.number().int().nullable(),

  maritalStatusCode: z.string().nullable(),
  hasChildren: z.boolean().nullable(),
  childrenCount: z.number().int().nullable(),
  childrenLiveWithMe: z.boolean().nullable(),
  marriageTimelineCode: z.string().nullable(),

  relocationWillingnessCode: z.string().nullable(),
  relocationTargetCountries: z.array(z.string()),

  educationLevelCode: z.string().nullable(),
  fieldOfStudyCode: z.string().nullable(),
  institution: z.string().nullable(),

  professionCode: z.string().nullable(),
  industryCode: z.string().nullable(),
  employmentStatusCode: z.string().nullable(),

  religiousPracticeCode: z.string().nullable(),
  /** Null means NOT STATED, and must never be auto-excluded by a filter (A2). */
  sectCode: z.string().nullable(),
  prayerFrequencyCode: z.string().nullable(),
  quranLevelCode: z.string().nullable(),
  dressPracticeCode: z.string().nullable(),

  familyBackground: z.string().nullable(),

  hobbies: z.array(z.string()),
  lifestyleAttributes: z.array(z.string()),
  personalityTraits: z.array(z.string()),
  dietCode: z.string().nullable(),
  smokingCode: z.string().nullable(),

  location: locationSchema.nullable(),
  sensitive: profileSensitiveSchema,
  reviewStatus: z.enum(REVIEW_STATUSES),
  completionScore: z.number().int().min(0).max(100),
  updatedAt: timestampSchema,
});
export type OwnProfile = z.infer<typeof ownProfileSchema>;

/**
 * Any subset of the editable fields.
 *
 * Absent from this schema, deliberately: `reviewStatus`, `completionScore`,
 * `userId`, `gender` and `dateOfBirth`. The first two are server state — a
 * member who could set `reviewStatus` would be discoverable without ever
 * passing review, and the database withholds the column grant to make that
 * impossible rather than merely discouraged. Gender is immutable once the
 * profile is complete, and identity fields are written through the onboarding
 * identity endpoint, not through a profile patch.
 */
export const profileUpdateSchema = z
  .object({
    // Identity, which lives on `users` rather than `profiles`. Carried here
    // because OwnProfile carries it and the contract has one profile patch —
    // inventing a second endpoint would be a contract change, not a fix.
    //
    // `gender` is accepted but the database refuses to change it once the
    // profile is complete (app.enforce_gender_immutable). `dateOfBirth` is
    // re-checked against the age gate by a trigger.
    displayName: z.string().min(1).max(80),
    dateOfBirth: z.string().date(),
    gender: z.enum(GENDERS),

    aboutMe: longText.nullable(),
    lookingFor: longText.nullable(),

    nationalityCode: countryCodeSchema.nullable(),
    languages: codeArray,
    heightCm: z.number().int().min(120).max(250).nullable(),

    maritalStatusCode: referenceCodeSchema.nullable(),
    hasChildren: z.boolean().nullable(),
    childrenCount: z.number().int().min(0).max(20).nullable(),
    childrenLiveWithMe: z.boolean().nullable(),
    marriageTimelineCode: referenceCodeSchema.nullable(),

    relocationWillingnessCode: referenceCodeSchema.nullable(),
    relocationTargetCountries: countryArray,

    educationLevelCode: referenceCodeSchema.nullable(),
    fieldOfStudyCode: referenceCodeSchema.nullable(),
    institution: shortText.nullable(),

    professionCode: referenceCodeSchema.nullable(),
    industryCode: referenceCodeSchema.nullable(),
    employmentStatusCode: referenceCodeSchema.nullable(),

    religiousPracticeCode: referenceCodeSchema.nullable(),
    sectCode: referenceCodeSchema.nullable(),
    prayerFrequencyCode: referenceCodeSchema.nullable(),
    quranLevelCode: referenceCodeSchema.nullable(),
    dressPracticeCode: referenceCodeSchema.nullable(),

    familyBackground: longText.nullable(),

    hobbies: codeArray,
    lifestyleAttributes: codeArray,
    personalityTraits: codeArray,
    dietCode: referenceCodeSchema.nullable(),
    smokingCode: referenceCodeSchema.nullable(),

    location: locationUpdateSchema,
  })
  .partial()
  .refine(
    (patch) =>
      // "No children" and a count of three is the kind of contradiction that
      // quietly corrupts a filter. The database rejects it too.
      patch.hasChildren !== false ||
      patch.childrenCount === undefined ||
      patch.childrenCount === null,
    { message: 'childrenCount cannot be set when hasChildren is false', path: ['childrenCount'] },
  );
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * What a profile must have before it can be submitted for review.
 *
 * Mirrors the `profiles_complete_for_review` CHECK constraint. The constraint
 * is the control; this list is what lets the app say *which* field is missing
 * instead of surfacing a database error.
 */
export const REQUIRED_FOR_REVIEW = [
  'displayName',
  'dateOfBirth',
  'gender',
  'location',
  'maritalStatusCode',
  'religiousPracticeCode',
  'aboutMe',
] as const;

/** Minimum characters of `aboutMe`, matching the CHECK constraint. */
export const MIN_ABOUT_ME_LENGTH = 20;

export const profileCompletionSchema = z.object({
  score: z.number().int().min(0).max(100),
  reviewStatus: z.enum(REVIEW_STATUSES),
  rejectionReasonKey: z.string().nullable(),
  missingRequired: z.array(z.string()),
  suggestedNext: z.array(z.string()),
  isDiscoverable: z.boolean(),
});
export type ProfileCompletion = z.infer<typeof profileCompletionSchema>;

// ---------------------------------------------------------------------------
// Field visibility
// ---------------------------------------------------------------------------

/** The 14 controllable keys (ERD E6). */
export const VISIBILITY_FIELD_KEYS = [
  'profession',
  'industry',
  'employment_status',
  'institution',
  'education_level',
  'field_of_study',
  'location_precision',
  'height',
  'nationality',
  'family_background',
  'sect',
  'children_details',
  'hobbies_and_lifestyle',
  'about_me',
] as const;
export type VisibilityFieldKey = (typeof VISIBILITY_FIELD_KEYS)[number];

/**
 * Every allowed value across the fourteen keys.
 *
 * `location_precision` takes city/region/country while the rest take the four
 * visibility tiers. The pairings that do not make sense — `about_me: private`,
 * a visibility tier on `location_precision` — are refused by CHECK constraints
 * in the database, which is where that rule belongs: it has to hold whatever
 * writes the row.
 */
const visibilityValueSchema = z.enum([...FIELD_VISIBILITIES, ...LOCATION_PRECISIONS] as unknown as [
  string,
  ...string[],
]);

/**
 * A PARTIAL map: a screen may send only the keys it changed.
 *
 * Deliberately an object rather than `z.record(z.enum(...), …)` — in Zod 4 a
 * record keyed by an enum is EXHAUSTIVE, so it rejects any map missing a key,
 * and every partial save fails validation. An object with `.partial()` says
 * what was meant, and unknown keys are stripped rather than rejected, so a
 * newer client sending a key this version does not know is simply ignored.
 */
export const fieldVisibilityMapSchema = z
  .object(
    Object.fromEntries(VISIBILITY_FIELD_KEYS.map((key) => [key, visibilityValueSchema])) as Record<
      VisibilityFieldKey,
      typeof visibilityValueSchema
    >,
  )
  .partial();
export type FieldVisibilityMap = z.infer<typeof fieldVisibilityMapSchema>;

export { FIELD_VISIBILITIES };

// ---------------------------------------------------------------------------
// Partner preferences
// ---------------------------------------------------------------------------

export const preferencesSchema = z.object({
  ageMin: z.number().int().nullable(),
  ageMax: z.number().int().nullable(),
  heightMinCm: z.number().int().nullable(),
  heightMaxCm: z.number().int().nullable(),
  countryCodes: z.array(z.string()),
  maxDistanceKm: z.number().int().nullable(),
  languageCodes: z.array(z.string()),
  educationLevelCodes: z.array(z.string()),
  professionCodes: z.array(z.string()),
  religiousPracticeCodes: z.array(z.string()),
  sectCodes: z.array(z.string()),
  excludeUnstatedSect: z.boolean(),
  maritalStatusCodes: z.array(z.string()),
  acceptsChildren: z.boolean().nullable(),
  marriageTimelineCodes: z.array(z.string()),
  relocationRequired: z.boolean().nullable(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const MINIMUM_PREFERENCE_AGE = 18;

export const preferencesUpdateSchema = z
  .object({
    ageMin: z.number().int().min(MINIMUM_PREFERENCE_AGE).max(120).nullable(),
    ageMax: z.number().int().min(MINIMUM_PREFERENCE_AGE).max(120).nullable(),
    heightMinCm: z.number().int().min(120).max(250).nullable(),
    heightMaxCm: z.number().int().min(120).max(250).nullable(),
    countryCodes: countryArray,
    maxDistanceKm: z.number().int().min(1).max(20000).nullable(),
    languageCodes: codeArray,
    educationLevelCodes: codeArray,
    professionCodes: codeArray,
    religiousPracticeCodes: codeArray,
    sectCodes: codeArray,
    /**
     * The A2 guard. Defaults to false everywhere — schema, API and UI — so a
     * member who states a sect preference still sees profiles that left it
     * blank. Leaving a field blank must not cost a person visibility.
     */
    excludeUnstatedSect: z.boolean(),
    maritalStatusCodes: codeArray,
    acceptsChildren: z.boolean().nullable(),
    marriageTimelineCodes: codeArray,
    relocationRequired: z.boolean().nullable(),
  })
  .partial()
  .refine(
    (p) =>
      p.ageMin === undefined ||
      p.ageMax === undefined ||
      p.ageMin === null ||
      p.ageMax === null ||
      p.ageMin <= p.ageMax,
    { message: 'ageMin must not exceed ageMax', path: ['ageMin'] },
  )
  .refine(
    (p) =>
      p.heightMinCm === undefined ||
      p.heightMaxCm === undefined ||
      p.heightMinCm === null ||
      p.heightMaxCm === null ||
      p.heightMinCm <= p.heightMaxCm,
    { message: 'heightMinCm must not exceed heightMaxCm', path: ['heightMinCm'] },
  );
export type PreferencesUpdate = z.infer<typeof preferencesUpdateSchema>;
