import { z } from 'zod';
import { pageSchema, timestampSchema, uuidSchema } from './common';

/**
 * Family Safety — the wali communication model (ADR 0011, D12).
 *
 * Mirrors the Family / Wali section of docs/openapi.yaml.
 *
 * The shapes here are narrower than the tables behind them, and the narrowing
 * is the product:
 *
 *   - a review packet is an ENUMERATED PROJECTION, not a profile with fields
 *     removed, so a new profile column cannot leak into it by default;
 *   - nothing a delegate receives carries contact details, exact location, or
 *     message bodies;
 *   - the counterpart of a reviewed match learns that a review is pending and
 *     never who is reviewing or what they wrote.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const RELATIONSHIP_CODES = [
  'father',
  'mother',
  'brother',
  'sister',
  'guardian',
  'other',
] as const;
export type RelationshipCode = (typeof RELATIONSHIP_CODES)[number];

/**
 * Tiers are PRESET LABELS for the invite UI, never an authorization input.
 *
 * A tier expands into permission rows at grant time and is thereafter
 * decoration — `app.family_grant()` reads the rows. One question, one source
 * of truth; a tier consulted at read time would be a second authority that
 * can disagree with the first.
 *
 * Only the two whose authorization logic exists are offerable. `participant`
 * (M2) and `manager` (1.1) arrive with the slices that can enforce them.
 */
export const FAMILY_TIERS = ['observer', 'reviewer'] as const;
export type FamilyTier = (typeof FAMILY_TIERS)[number];

/** Every permission in the vocabulary, including those whose phase has not arrived. */
export const FAMILY_PERMISSIONS = [
  'view_profile',
  'view_matches',
  'review_interest',
  'approve_communication',
  'report_on_behalf',
  'block_on_behalf',
  'view_conversation',
  'join_conversation',
  'request_family_call',
  'join_family_call',
  'receive_proposal',
  'manage_profile',
] as const;
export type FamilyPermission = (typeof FAMILY_PERMISSIONS)[number];

/**
 * The six that are usable in M1.
 *
 * A grant outside this set is refused with 400 at grant time rather than
 * accepted and ignored. A grant that silently does nothing is worse than a
 * refusal, because the owner believes they granted something.
 */
export const M1_FAMILY_PERMISSIONS = [
  'view_profile',
  'view_matches',
  'review_interest',
  'approve_communication',
  'report_on_behalf',
  'block_on_behalf',
] as const;
export type M1FamilyPermission = (typeof M1_FAMILY_PERMISSIONS)[number];

/** What each tier expands to at grant time. */
export const TIER_PRESETS: Readonly<Record<FamilyTier, readonly M1FamilyPermission[]>> = {
  observer: ['view_profile'],
  reviewer: [
    'view_profile',
    'view_matches',
    'review_interest',
    'approve_communication',
    'report_on_behalf',
    'block_on_behalf',
  ],
};

export const FAMILY_RELATIONSHIP_STATUSES = ['active', 'revoked'] as const;
export const FAMILY_INVITATION_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'expired',
  'cancelled',
] as const;

/**
 * No `expired` (D12-g).
 *
 * A stalled review notifies the owner and keeps waiting. Auto-approving would
 * make a delegate's silence into consent; auto-rejecting would hand them a
 * veto by doing nothing. Both invert the safety model (R16), so there is no
 * value that silence could be recorded as.
 */
export const REVIEW_DECISIONS = [
  'pending',
  'approved',
  'rejected',
  'more_info_requested',
  'revoked',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** The decisions a delegate may actually submit. */
export const REVIEW_ACTIONS = ['approve', 'reject', 'request_more_info'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Hours a review may sit before the owner is warned. D12-g. */
export const REVIEW_SLA_HOURS = 72;

/** Days an invitation stays valid. D12-h. */
export const INVITATION_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// Members and permissions
// ---------------------------------------------------------------------------

export const familyMemberSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema.nullable(),
  displayName: z.string().nullable(),
  relationshipCode: z.enum(RELATIONSHIP_CODES),
  tier: z.enum(FAMILY_TIERS),
  status: z.enum(FAMILY_RELATIONSHIP_STATUSES),
  /** Exactly what they hold — never inferred from the tier. */
  permissions: z.array(z.enum(FAMILY_PERMISSIONS)),
  createdAt: timestampSchema,
  revokedAt: z.string().nullable(),
});
export type FamilyMember = z.infer<typeof familyMemberSchema>;

export const familyMemberPageSchema = pageSchema(familyMemberSchema);
export type FamilyMemberPage = z.infer<typeof familyMemberPageSchema>;

export const updatePermissionsSchema = z.object({
  /**
   * The COMPLETE set after this call, not a delta. A partial update invites a
   * client to send what it believes is there and silently restore a
   * permission the owner revoked from another device.
   */
  permissions: z.array(z.enum(FAMILY_PERMISSIONS)).max(FAMILY_PERMISSIONS.length),
});
export type UpdatePermissionsRequest = z.infer<typeof updatePermissionsSchema>;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const createInvitationSchema = z.object({
  /** Email or E.164 phone. Validated by shape, not by delivery. */
  inviteeContact: z.string().min(3).max(320),
  relationshipCode: z.enum(RELATIONSHIP_CODES),
  tier: z.enum(FAMILY_TIERS),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationSchema>;

/**
 * What the inviter sees.
 *
 * `token` is absent: it is returned exactly once, by the create call, in
 * `CreateInvitationResponse`. A token readable from a list is a token that
 * leaks with the list.
 */
export const familyInvitationSchema = z.object({
  id: uuidSchema,
  inviteeContact: z.string(),
  relationshipCode: z.enum(RELATIONSHIP_CODES),
  tier: z.enum(FAMILY_TIERS),
  status: z.enum(FAMILY_INVITATION_STATUSES),
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
  respondedAt: z.string().nullable(),
});
export type FamilyInvitation = z.infer<typeof familyInvitationSchema>;

export const familyInvitationPageSchema = pageSchema(familyInvitationSchema);
export type FamilyInvitationPage = z.infer<typeof familyInvitationPageSchema>;

export const createInvitationResponseSchema = familyInvitationSchema.extend({
  /** Shown once, to the inviter, and never stored unhashed. */
  token: z.string(),
});

export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

export const respondToInvitationSchema = z.object({
  token: z.string().min(16).max(128),
  accept: z.boolean(),
});
export type RespondToInvitationRequest = z.infer<typeof respondToInvitationSchema>;

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * One match awaiting a delegate's decision.
 *
 * Carries the counterpart's display name and age and nothing else. The full
 * packet is a separate, match-scoped read — so an inbox cannot be mined for
 * profile data, and the delegate has to open a specific pairing to see more.
 */
export const reviewSummarySchema = z.object({
  matchId: uuidSchema,
  ownerUserId: uuidSchema,
  ownerDisplayName: z.string().nullable(),
  counterpartDisplayName: z.string().nullable(),
  counterpartAge: z.number().int().nullable(),
  decision: z.enum(REVIEW_DECISIONS),
  requestedAt: timestampSchema,
  /** True once the 72-hour SLA has elapsed with no decision. */
  overdue: z.boolean(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewSummaryPageSchema = pageSchema(reviewSummarySchema);
export type ReviewSummaryPage = z.infer<typeof reviewSummaryPageSchema>;

/**
 * THE REVIEW PACKET — an enumerated projection, match-scoped.
 *
 * Every field here is listed on purpose. It is NOT a profile read with fields
 * removed: that shape would let a new profile column reach a delegate by
 * default, and the one thing this packet must never become is a general view
 * of a stranger.
 *
 * Absent by construction: contact details (`profile_sensitive`), exact
 * location (`user_locations`), the counterpart's own matches, and anything
 * the owner has hidden through `profile_field_visibility`.
 */
export const reviewPacketSchema = z.object({
  matchId: uuidSchema,
  ownerUserId: uuidSchema,
  ownerDisplayName: z.string().nullable(),
  decision: z.enum(REVIEW_DECISIONS),
  requestedAt: timestampSchema,
  overdue: z.boolean(),
  counterpart: z.object({
    displayName: z.string().nullable(),
    age: z.number().int().nullable(),
    /** Country only. Never the city, and never coordinates. */
    countryCode: z.string().nullable(),
    /**
     * Reference CODES, not display strings.
     *
     * The profile stores codes against `reference_items`, and the client
     * already resolves them for every other screen. Translating them here
     * would put a second copy of that mapping on the server, where it can
     * drift from the one members see.
     */
    maritalStatusCode: z.string().nullable(),
    educationLevelCode: z.string().nullable(),
    professionCode: z.string().nullable(),
    religiousPracticeCode: z.string().nullable(),
    sectCode: z.string().nullable(),
    marriageTimelineCode: z.string().nullable(),
    aboutMe: z.string().nullable(),
    verified: z.boolean(),
  }),
  /**
   * The score, and the KEYS behind it.
   *
   * Not a prose summary: the engine is deterministic and its explanations are
   * catalog keys (ADR 0001), truthful by construction. Generating a sentence
   * here would be the one place in the product where an explanation was
   * authored rather than derived.
   */
  compatibility: z
    .object({
      score: z.number().int().min(0).max(100),
      explanationKeys: z.array(z.string()),
    })
    .nullable(),
  /** Whether either side has been reported or blocked. A safety signal, not a verdict. */
  signals: z.object({
    counterpartReported: z.boolean(),
    blockExists: z.boolean(),
  }),
});
export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

export const decideReviewSchema = z.object({
  action: z.enum(REVIEW_ACTIONS),
  /** Visible to the owner, never to the counterpart. */
  note: z.string().max(1000).optional(),
});
export type DecideReviewRequest = z.infer<typeof decideReviewSchema>;

export const revokeReviewSchema = z.object({
  note: z.string().max(1000).optional(),
});
export type RevokeReviewRequest = z.infer<typeof revokeReviewSchema>;

// ---------------------------------------------------------------------------
// Access log — the anti-coercion control
// ---------------------------------------------------------------------------

/**
 * One delegated action, and the permission that authorised it.
 *
 * `permission` is the point. Without it an owner reviewing the log can see
 * that their brother opened something but not under which right — which is
 * the question they would actually be asking before deciding whether to
 * revoke.
 */
export const familyAccessLogEntrySchema = z.object({
  id: uuidSchema,
  delegateDisplayName: z.string().nullable(),
  relationshipCode: z.enum(RELATIONSHIP_CODES).nullable(),
  action: z.string(),
  permission: z.enum(FAMILY_PERMISSIONS),
  resourceType: z.string().nullable(),
  createdAt: timestampSchema,
});
export type FamilyAccessLogEntry = z.infer<typeof familyAccessLogEntrySchema>;

export const familyAccessLogPageSchema = pageSchema(familyAccessLogEntrySchema);
export type FamilyAccessLogPage = z.infer<typeof familyAccessLogPageSchema>;

// ---------------------------------------------------------------------------
// The owner's own gate
// ---------------------------------------------------------------------------

export const COMMUNICATION_POLICIES = ['direct', 'family_reviewed'] as const;
export type CommunicationPolicy = (typeof COMMUNICATION_POLICIES)[number];

export const updateCommunicationPolicySchema = z.object({
  communicationPolicy: z.enum(COMMUNICATION_POLICIES),
});
export type UpdateCommunicationPolicyRequest = z.infer<typeof updateCommunicationPolicySchema>;

/**
 * Expands a tier into the permissions it offers.
 *
 * Used at grant time only. Nothing reads a tier afterwards.
 */
export function permissionsForTier(tier: FamilyTier): readonly M1FamilyPermission[] {
  return TIER_PRESETS[tier];
}

/** True when a permission's phase has arrived and it may actually be granted. */
export function isGrantablePermission(permission: string): permission is M1FamilyPermission {
  return (M1_FAMILY_PERMISSIONS as readonly string[]).includes(permission);
}

/**
 * Has this review been pending longer than the SLA?
 *
 * Pure, so it can be asserted without a clock: the caller supplies `now`.
 */
export function isReviewOverdue(requestedAt: Date, now: Date): boolean {
  const elapsedHours = (now.getTime() - requestedAt.getTime()) / 3_600_000;
  return elapsedHours >= REVIEW_SLA_HOURS;
}
