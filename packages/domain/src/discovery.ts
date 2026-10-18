import { z } from 'zod';
import { pageSchema, timestampSchema, uuidSchema } from './common';

/**
 * Discovery, interests, matches and notifications — the shapes the API
 * actually returns.
 *
 * Declared here rather than in the mobile app so the API and every client
 * agree by type-check rather than by hope. These mirror the responses built in
 * Phase 5 Slices 5–6 and Phase 6 Slices 1–5.
 *
 * WHAT A CARD DELIBERATELY LACKS. No date of birth (only the derived age), no
 * review status, no moderation state, nothing from `profile_sensitive`. The
 * server builds it from an allowlist; this type records that allowlist so a
 * screen cannot reach for a field that was never sent.
 */

// ---------------------------------------------------------------------------
// Profile card
// ---------------------------------------------------------------------------

/**
 * The badge as a CARD carries it.
 *
 * Narrower than `verificationBadgeSchema` in account.ts, which also carries a
 * localised label for the member's own profile. A card sends the key and lets
 * the catalogs supply the wording, so the two are deliberately not the same
 * type rather than one pretending to serve both.
 */
export const cardVerificationBadgeSchema = z.object({
  key: z.enum([
    'email_verified',
    'phone_verified',
    'photo_verified',
    'id_verified',
    'profile_reviewed',
  ]),
  earnedAt: z.string().nullable(),
});
export type CardVerificationBadge = z.infer<typeof cardVerificationBadgeSchema>;

export const visiblePhotoSchema = z.object({
  id: uuidSchema,
  variant: z.enum(['thumb', 'blurred', 'full']),
  url: z.string().nullable(),
  expiresAt: z.string().nullable(),
  requiresRequest: z.boolean(),
});
export type VisiblePhoto = z.infer<typeof visiblePhotoSchema>;

export const profileCardSchema = z.object({
  userId: uuidSchema,
  displayName: z.string().nullable(),
  age: z.number().int().nullable(),
  countryCode: z.string().nullable(),
  /** Null when the member chose region or country precision. */
  cityName: z.string().nullable(),
  /** Always null until locations carry coordinates. */
  distanceBand: z.string().nullable(),
  /** Null until cross-user photo delivery exists. */
  primaryPhoto: visiblePhotoSchema.nullable(),
  compatibilityScore: z.number().nullable(),
  /** i18n keys, never prose. */
  topReasons: z.array(z.string()),
  verification: z.object({ badges: z.array(cardVerificationBadgeSchema) }),
  isShortlisted: z.boolean(),
});
export type ProfileCard = z.infer<typeof profileCardSchema>;

export const profileCardPageSchema = pageSchema(profileCardSchema);
export type ProfileCardPage = z.infer<typeof profileCardPageSchema>;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const discoverySectionSummarySchema = z.object({
  key: z.string(),
  titleKey: z.string(),
  subtitleKey: z.string().nullable(),
  totalCount: z.number().int(),
  preview: z.array(profileCardSchema),
  requiresEntitlement: z.string().nullable(),
});
export type DiscoverySectionSummary = z.infer<typeof discoverySectionSummarySchema>;

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

export const compatibilityDimensionSchema = z.object({
  key: z.string(),
  subScore: z.number().nullable(),
  weight: z.number(),
});

export const compatibilityScoreSchema = z.object({
  userId: uuidSchema,
  overall: z.number(),
  engineVersion: z.string(),
  computedAt: z.string(),
  dimensions: z.array(compatibilityDimensionSchema),
});
export type CompatibilityScore = z.infer<typeof compatibilityScoreSchema>;

export const compatibilityReasonSchema = z.object({
  dimension: z.string(),
  messageKey: z.string(),
  sentiment: z.enum(['strong', 'moderate', 'differs']),
  subScore: z.number(),
  facts: z.record(z.string(), z.unknown()),
});

export const compatibilityExplanationSchema = z.object({
  userId: uuidSchema,
  overall: z.number(),
  engineVersion: z.string(),
  reasons: z.array(compatibilityReasonSchema),
  differences: z.array(compatibilityReasonSchema),
});
export type CompatibilityExplanation = z.infer<typeof compatibilityExplanationSchema>;

// ---------------------------------------------------------------------------
// Interests
// ---------------------------------------------------------------------------

export const INTEREST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'maybe_later',
  'withdrawn',
] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];

export const INTEREST_DIRECTIONS = ['sent', 'received'] as const;
export type InterestDirection = (typeof INTEREST_DIRECTIONS)[number];

export const interestSchema = z.object({
  id: uuidSchema,
  direction: z.enum(INTEREST_DIRECTIONS),
  counterpartUserId: uuidSchema,
  /** Null when the counterpart is no longer viewable — a block, say. */
  counterpart: profileCardSchema.nullable(),
  status: z.enum(INTEREST_STATUSES),
  note: z.string().nullable(),
  /** Set when a delegate acted on the owner's behalf (A7). */
  actedBy: z.string().nullable(),
  createdAt: timestampSchema,
  respondedAt: z.string().nullable(),
});
export type Interest = z.infer<typeof interestSchema>;

export const interestPageSchema = pageSchema(interestSchema);
export type InterestPage = z.infer<typeof interestPageSchema>;

export const INTEREST_DECISIONS = ['accept', 'decline', 'maybe_later'] as const;
export type InterestDecision = (typeof INTEREST_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export const COMMUNICATION_STATES = [
  'pending_family_review',
  'family_rejected',
  'open',
  'family_approved',
  'active',
  'revoked',
  'blocked',
] as const;
export type CommunicationState = (typeof COMMUNICATION_STATES)[number];

export const matchSchema = z.object({
  id: uuidSchema,
  counterpartUserId: uuidSchema,
  counterpart: profileCardSchema.nullable(),
  /** Null until a conversation exists. A match can exist with no thread. */
  conversationId: z.string().nullable(),
  stage: z.number().int(),
  communicationState: z.enum(COMMUNICATION_STATES),
  familyReview: z.unknown().nullable(),
  createdAt: timestampSchema,
  endedAt: z.string().nullable(),
});
export type Match = z.infer<typeof matchSchema>;

export const matchPageSchema = pageSchema(matchSchema);
export type MatchPage = z.infer<typeof matchPageSchema>;

export const respondToInterestResultSchema = z.object({
  interest: interestSchema,
  match: matchSchema.nullable(),
});
export type RespondToInterestResult = z.infer<typeof respondToInterestResultSchema>;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'interest_received',
  'interest_accepted',
  'new_match',
  'new_message',
  'photo_request',
  'photo_request_answered',
  'family_invitation',
  'family_invitation_answered',
  'stage_advance_proposed',
  'verification_update',
  'security_alert',
  'report_update',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationSchema = z.object({
  id: uuidSchema,
  type: z.enum(NOTIFICATION_TYPES),
  /** i18n keys. The catalogs own the wording. */
  titleKey: z.string(),
  bodyKey: z.string(),
  /** Identifiers only — never rendered content about a person. */
  data: z.record(z.string(), z.unknown()),
  readAt: z.string().nullable(),
  createdAt: timestampSchema,
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = pageSchema(notificationSchema).extend({
  unreadCount: z.number().int(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;
