/**
 * Closed vocabularies — values that are fixed in code rather than stored as
 * reference data.
 *
 * The distinction matters and is deliberate (README §8 rule 2):
 *
 *   - Values HERE are structural. Adding one changes application logic, so a
 *     release is the right unit of change.
 *   - Values in `reference_items` are content. Adding a profession or a language
 *     must never require a release.
 *
 * If you find yourself wanting to add a value here so a non-developer can pick
 * it, it probably belongs in reference data instead.
 */

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export const USER_STATUSES = [
  'onboarding',
  'active',
  'deactivated',
  'suspended',
  'banned',
  'pending_deletion',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** A user may only reach discovery from `active`. */
export const DISCOVERABLE_STATUSES: readonly UserStatus[] = ['active'];

export const AUTH_PROVIDERS = ['email', 'phone', 'google', 'apple'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const PLATFORMS = ['android', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SECURITY_EVENT_TYPES = [
  'sign_in',
  'sign_out',
  'password_change',
  'email_change',
  'new_device',
  'device_revoked',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * Per-field visibility (ERD E6). Applied by the API, never by RLS — row-level
 * security decides whether a row is visible, not which of its columns are.
 */
export const FIELD_VISIBILITIES = ['public', 'matched_only', 'on_request', 'private'] as const;
export type FieldVisibility = (typeof FIELD_VISIBILITIES)[number];

export const LOCATION_PRECISIONS = ['city', 'region', 'country'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

/**
 * Reference data types. One generic table keyed by `(type, code)` rather than
 * nineteen near-identical tables (ADR 0009).
 */
export const REFERENCE_TYPES = [
  'country',
  'region',
  'city',
  'language',
  'education_level',
  'field_of_study',
  'profession',
  'industry',
  'employment_status',
  'marital_status',
  'religious_practice',
  'sect',
  'prayer_frequency',
  'quran_level',
  'marriage_timeline',
  'relocation_option',
  'hobby',
  'lifestyle_attribute',
  'personality_trait',
  'dress_practice',
  'diet',
  'smoking',
] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/**
 * Reference codes that carry a database-level composite FK because a bad value
 * would silently corrupt a hard filter (ERD E2). Everything else is validated
 * here and nowhere else.
 */
export const FK_ENFORCED_REFERENCE_TYPES: readonly ReferenceType[] = [
  'marital_status',
  'religious_practice',
  'sect',
  'education_level',
  'profession',
  'marriage_timeline',
  'relocation_option',
  'country',
];

/**
 * Verification badges. Each names exactly what was checked.
 *
 * There is deliberately no generic `verified` badge: one would imply more than
 * was confirmed, which is how platforms in this category lose trust permanently
 * (README §14).
 */
export const VERIFICATION_BADGES = [
  'email_verified',
  'phone_verified',
  'photo_verified',
  'id_verified',
  'profile_reviewed',
] as const;
export type VerificationBadgeKey = (typeof VERIFICATION_BADGES)[number];

/** Badges reachable in v1. The rest arrive with their flows in 1.1+. */
export const V1_VERIFICATION_BADGES: readonly VerificationBadgeKey[] = [
  'email_verified',
  'phone_verified',
  'profile_reviewed',
];

/**
 * Launch locales.
 *
 * English only. Urdu was a launch locale and was removed, along with all
 * right-to-left handling — the product ships in one language.
 *
 * The list stays an array rather than collapsing to the literal `'en'`, so
 * adding a locale remains a data change: add the code here and add a catalog
 * beside the others in @nikahmate/i18n. Resolution, persistence and lookup all
 * read from this list.
 *
 * A second locale that is right-to-left would need direction handling built
 * again; it was removed deliberately rather than left dormant, because
 * untested RTL code is worse than none.
 */
export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Entitlement keys. The v1 set is small because money is switched off — but the
 * abstraction ships now so v1.2 billing never touches feature code (ADR 0005).
 *
 * Feature code asks `can(user, key)`. It never asks whether a user is premium.
 */
export const ENTITLEMENT_KEYS = [
  'daily_interests',
  'advanced_filters',
  'who_viewed_me',
  'incognito',
  'profile_boost',
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/** Free-plan defaults (README §15 A5). Seeded into `plan_entitlements`. */
export const FREE_PLAN_ENTITLEMENTS: Readonly<Record<EntitlementKey, number | boolean>> = {
  daily_interests: 5,
  advanced_filters: false,
  who_viewed_me: false,
  incognito: false,
  profile_boost: false,
};

export const PROBLEM_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'entitlement_required',
  'quota_exhausted',
  'rate_limited',
  'internal_error',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
