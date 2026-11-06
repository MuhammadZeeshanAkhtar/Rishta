import { z } from 'zod';
import { pageSchema, timestampSchema, uuidSchema } from './common';
import { REPORT_STATUSES } from './safety';

/**
 * Staff moderation (review L1) — the shapes `routes/admin.ts` returns and
 * accepts, shared with the admin screens so a drift is a type error.
 *
 * Every endpoint is authorised by the API (an active staff row, the role, and
 * a second factor); nothing here grants anything.
 */

export const ADMIN_ROLES = ['moderator', 'support', 'admin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Who may do what — mirrors `MODERATION` and `SUPPORT` in routes/admin.ts. */
export const ADMIN_AREA_ROLES = {
  photos: ['moderator', 'admin'],
  profiles: ['moderator', 'admin'],
  reports: ['moderator', 'admin'],
  users: ['moderator', 'admin'],
  dobCorrections: ['support', 'admin'],
  audit: ['moderator', 'support', 'admin'],
} as const satisfies Record<string, readonly AdminRole[]>;
export type AdminArea = keyof typeof ADMIN_AREA_ROLES;

export function canUseAdminArea(roles: readonly AdminRole[], area: AdminArea): boolean {
  const allowed: readonly AdminRole[] = ADMIN_AREA_ROLES[area];
  return roles.some((role) => role === 'admin' || allowed.includes(role));
}

export const adminSessionSchema = z.object({
  adminUserId: uuidSchema,
  roles: z.array(z.enum(ADMIN_ROLES)),
  mfaRequired: z.boolean(),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

/** Rejection reasons a member's app can render (`errors.*` keys in i18n). */
export const PHOTO_REJECTION_REASONS = [
  'errors.photoRejected',
  'errors.photoRejectedNotAPerson',
  'errors.photoRejectedInappropriate',
  'errors.photoRejectedContactDetails',
  'errors.photoRejectedQuality',
] as const;
export const PROFILE_REJECTION_REASONS = [
  'errors.profileRejected',
  'errors.profileRejectedContactDetails',
  'errors.profileRejectedInappropriate',
  'errors.profileRejectedIncomplete',
] as const;

const reasonKeySchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_.]*$/)
  .max(100);
const noteSchema = z.string().trim().min(1).max(1000);

/**
 * A moderation decision. The server requires a reason on every REJECTION
 * (`reasonKey` for photos and profiles, `note` for DOB corrections); the admin
 * screens require a note on every decision, for the audit trail.
 */
export const moderationDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reasonKey: reasonKeySchema.optional(),
  note: noteSchema.optional(),
});
export type ModerationDecision = z.infer<typeof moderationDecisionSchema>;

export const reportDecisionSchema = z.object({
  status: z.enum(['triaged', 'actioned', 'dismissed']),
  outcomeKey: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(100)
    .optional(),
  note: noteSchema.optional(),
});
export type ReportDecision = z.infer<typeof reportDecisionSchema>;

export const USER_ACTIONS = ['warn', 'suspend', 'ban', 'clear'] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

export const userActionRequestSchema = z.object({
  action: z.enum(USER_ACTIONS),
  reason: noteSchema,
  expiresAt: timestampSchema.optional(),
});
export type UserActionRequest = z.infer<typeof userActionRequestSchema>;

export const adminPhotoQueueSchema = z.object({
  items: z.array(
    z.object({
      photoId: uuidSchema,
      userId: uuidSchema,
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      createdAt: timestampSchema,
      url: z.string().nullable(),
    }),
  ),
});
export type AdminPhotoQueue = z.infer<typeof adminPhotoQueueSchema>;

export const adminProfileQueueSchema = z.object({
  items: z.array(
    z.object({
      userId: uuidSchema,
      displayName: z.string().nullable(),
      aboutMe: z.string().nullable(),
      lookingFor: z.string().nullable(),
      institution: z.string().nullable(),
      familyBackground: z.string().nullable(),
      submittedAt: timestampSchema,
    }),
  ),
});
export type AdminProfileQueue = z.infer<typeof adminProfileQueueSchema>;

export const adminReportQueueSchema = z.object({
  items: z.array(
    z.object({
      reportId: uuidSchema,
      reporterUserId: uuidSchema,
      reportedUserId: uuidSchema,
      category: z.string(),
      description: z.string().nullable(),
      contextType: z.string().nullable(),
      contextId: z.string().nullable(),
      status: z.enum(REPORT_STATUSES),
      createdAt: timestampSchema,
    }),
  ),
});
export type AdminReportQueue = z.infer<typeof adminReportQueueSchema>;

export const adminDobQueueSchema = z.object({
  items: z.array(
    z.object({
      requestId: uuidSchema,
      userId: uuidSchema,
      currentDob: z.string().nullable(),
      requestedDob: z.string(),
      reason: z.string(),
      createdAt: timestampSchema,
    }),
  ),
});
export type AdminDobQueue = z.infer<typeof adminDobQueueSchema>;

export const adminDecisionResultSchema = z.object({ status: z.string() }).passthrough();
export const userActionResultSchema = z.object({
  userId: uuidSchema,
  action: z.enum(USER_ACTIONS),
  status: z.string(),
});
export type UserActionResult = z.infer<typeof userActionResultSchema>;

export const adminAuditEntrySchema = z.object({
  id: uuidSchema,
  action: z.string(),
  targetType: z.string(),
  targetId: uuidSchema,
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
  actor: z.object({ adminUserId: uuidSchema, displayName: z.string().nullable() }),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

export const adminAuditPageSchema = pageSchema(adminAuditEntrySchema);
export type AdminAuditPage = z.infer<typeof adminAuditPageSchema>;
