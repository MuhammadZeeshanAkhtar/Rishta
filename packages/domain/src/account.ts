import { z } from 'zod';
import {
  GENDERS,
  PLATFORMS,
  SECURITY_EVENT_TYPES,
  USER_STATUSES,
  VERIFICATION_BADGES,
} from './constants';
import { countryCodeSchema, localeSchema, timestampSchema, timezoneSchema } from './common';

/**
 * Account and identity schemas. Mirrors the Account section of
 * docs/openapi.yaml — these are the request and response shapes both the API
 * and the mobile app validate against, so a drift between them is a type error
 * rather than a production bug.
 */

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Sent once after Supabase Auth sign-up.
 *
 * Note what is absent: the Supabase auth id. The API reads it from the verified
 * JWT and resolves it through `user_auth_links`. Accepting it as input would let
 * a caller name someone else's account.
 */
export const bootstrapRequestSchema = z.object({
  locale: localeSchema,
  timezone: timezoneSchema,
  deviceId: z.string().min(1).max(128).optional(),
  platform: z.enum(PLATFORMS).optional(),
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

/** How long a deletion request can be cancelled for (ERD E1). */
export const DELETION_GRACE_DAYS = 30;

/** `POST /me/delete`. `held`: a safety review must finish first (risk R4). */
export const deletionRequestSchema = z.object({
  requestedAt: z.string(),
  scheduledFor: z.string(),
  status: z.enum(['pending', 'held']),
  heldReason: z.string().nullable(),
});
export type DeletionRequest = z.infer<typeof deletionRequestSchema>;

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

/** `GET` and `PUT /me/notification-preferences`. The whole set each way. */
export const notificationPreferencesSchema = z.object({
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  types: z.array(z.object({ type: z.string(), push: z.boolean(), inApp: z.boolean() })),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const verificationStatusSchema = z.object({
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  /** Always false in v1 — the selfie flow arrives in 1.1 (ADR 0005). */
  selfieVerified: z.boolean(),
  /** Always false in v1. */
  idVerified: z.boolean(),
  profileReviewed: z.boolean(),
});
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const verificationBadgeSchema = z.object({
  key: z.enum(VERIFICATION_BADGES),
  /** Localised and specific: "Phone verified", never a bare "Verified". */
  label: z.string(),
  earnedAt: timestampSchema,
});
export type VerificationBadge = z.infer<typeof verificationBadgeSchema>;

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

export const meSchema = z.object({
  userId: z.string().uuid(),
  /** Null until onboarding collects it. */
  displayName: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  onboardingStep: z.string().nullable(),
  profileCompleted: z.boolean(),
  locale: localeSchema,
  timezone: timezoneSchema,
  showOnlineStatus: z.boolean(),
  sendReadReceipts: z.boolean(),
  incognito: z.boolean(),
  discoveryPaused: z.boolean(),
  /** The owner's Family Safety gate (ADR 0011). */
  communicationPolicy: z.enum(['direct', 'family_reviewed']),
  /**
   * Delegates currently holding `approve_communication`.
   *
   * Zero while the policy is `family_reviewed` means EVERY NEW MATCH WILL
   * STALL, with nobody able to release it. The app has to say so at the
   * moment the policy is set, not after the first match has sat unanswered —
   * which is why this is a field on the account read rather than something a
   * screen computes when it happens to remember to.
   */
  familyReviewersCount: z.number().int().min(0),
  verification: verificationStatusSchema,
});
export type Me = z.infer<typeof meSchema>;

/**
 * Settings a user may change about themselves.
 *
 * `gender` and `dateOfBirth` are deliberately absent: gender is immutable once
 * the profile is complete (README §15 A10) and age is computed from a date of
 * birth that is set during onboarding and never returned to other members.
 */
export const userSettingsUpdateSchema = z
  .object({
    locale: localeSchema,
    timezone: timezoneSchema,
    showOnlineStatus: z.boolean(),
    sendReadReceipts: z.boolean(),
    incognito: z.boolean(),
    discoveryPaused: z.boolean(),
    /**
     * The owner's Family Safety gate (ADR 0011, D12 row 1).
     *
     * It lives here, among ordinary settings, because that is what it is: the
     * owner's own choice, reversible by them at any time. Putting it behind a
     * family-shaped endpoint would imply the family controls it, and the one
     * thing R16 depends on is that they do not.
     *
     * Changing it never retroactively re-gates a live match — enforced in the
     * schema by `app.gate_new_match_period()`, not by this type.
     */
    communicationPolicy: z.enum(['direct', 'family_reviewed']),
  })
  .partial();
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// Devices and security
// ---------------------------------------------------------------------------

export const deviceSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(PLATFORMS),
  appVersion: z.string().nullable(),
  lastSeenAt: timestampSchema,
  isCurrent: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

export const registerDeviceSchema = z.object({
  deviceId: z.string().min(1).max(128),
  platform: z.enum(PLATFORMS),
  appVersion: z.string().max(32).optional(),
});
export type RegisterDevice = z.infer<typeof registerDeviceSchema>;

export const securityEventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.enum(SECURITY_EVENT_TYPES),
  createdAt: timestampSchema,
  /**
   * Country-level only. A precise location in a security log is itself a
   * privacy risk, and it is not needed to recognise an unexpected sign-in.
   */
  approximateLocation: countryCodeSchema.nullable(),
});
export type SecurityEvent = z.infer<typeof securityEventSchema>;

// ---------------------------------------------------------------------------
// Onboarding identity
// ---------------------------------------------------------------------------

/**
 * The identity facts captured during onboarding.
 *
 * `gender` is immutable once the profile is complete: discovery, matching and
 * the whole preference model assume it cannot change (ERD §3). The database
 * enforces this with a trigger; this schema is the first line, not the only one.
 */
export const identitySchema = z.object({
  displayName: z.string().min(1).max(80),
  gender: z.enum(GENDERS),
  dateOfBirth: z.string().date(),
  countryCode: countryCodeSchema,
});
export type Identity = z.infer<typeof identitySchema>;

/** Minimum age at sign-up. Enforced at the API and re-checked at verification. */
export const MINIMUM_AGE_YEARS = 18;

/** Age from a date of birth, in whole years, computed in UTC. */
export function ageFromDateOfBirth(dateOfBirth: string, now: Date = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export function meetsMinimumAge(dateOfBirth: string, now: Date = new Date()): boolean {
  return ageFromDateOfBirth(dateOfBirth, now) >= MINIMUM_AGE_YEARS;
}

// ---------------------------------------------------------------------------
// Date-of-birth corrections (review B6; company decision 4)
// ---------------------------------------------------------------------------

export const DOB_CORRECTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DobCorrectionStatus = (typeof DOB_CORRECTION_STATUSES)[number];

export const MIN_DOB_CORRECTION_REASON = 10;
export const MAX_DOB_CORRECTION_REASON = 1000;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createDobCorrectionSchema = z.object({
  requestedDob: isoDateSchema,
  reason: z.string().trim().min(MIN_DOB_CORRECTION_REASON).max(MAX_DOB_CORRECTION_REASON),
});
export type CreateDobCorrection = z.infer<typeof createDobCorrectionSchema>;

export const dobCorrectionCreatedSchema = z.object({
  requestId: z.string().uuid(),
  status: z.literal('pending'),
  requestedDob: isoDateSchema,
  createdAt: timestampSchema,
});
export type DobCorrectionCreated = z.infer<typeof dobCorrectionCreatedSchema>;

export const dobCorrectionSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(DOB_CORRECTION_STATUSES),
  requestedDob: isoDateSchema,
  /** Support's note. On a rejection it is the reason the member sees. */
  decisionNote: z.string().nullable(),
  decidedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type DobCorrection = z.infer<typeof dobCorrectionSchema>;

export const dobCorrectionListSchema = z.object({ items: z.array(dobCorrectionSchema) });
export type DobCorrectionList = z.infer<typeof dobCorrectionListSchema>;
