import { z } from 'zod';
import { pageSchema, timestampSchema, uuidSchema } from './common';

/**
 * Blocks and reports — the two things a member can do about another member.
 *
 * These mirror the Safety section of docs/openapi.yaml. The shapes are
 * narrower than the tables behind them, deliberately:
 *
 *   - a `Block` carries no reason and no actor, because the list exists so
 *     someone can undo a block, not audit it;
 *   - a `Report` returns no `description`, no context and nothing about the
 *     reported member. ERD §14 is explicit that the reported party sees
 *     nothing, and the reporter is told the OUTCOME in general terms, never
 *     what happened to another person's account.
 */

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One entry in "people I have blocked".
 *
 * Note what is NOT here: anything about whether THEY blocked YOU. Blocking is
 * bidirectional in effect and directional in storage, and a list that revealed
 * the reverse direction would hand the blocked party the one fact the whole
 * design withholds.
 */
export const blockSchema = z.object({
  userId: uuidSchema,
  /** Null when the member never completed onboarding. */
  displayName: z.string().nullable(),
  blockedAt: timestampSchema,
});
export type Block = z.infer<typeof blockSchema>;

export const blockPageSchema = pageSchema(blockSchema);
export type BlockPage = z.infer<typeof blockPageSchema>;

/**
 * Optional, free of prose, and never shown to the blocked member.
 *
 * A reference-code shape rather than text: this feeds pattern detection later,
 * and a free-text field here would be a second place a person could type
 * something about someone else that the product then has to moderate.
 */
export const blockRequestSchema = z.object({
  reasonCode: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'Must be a lower_snake_case reason code')
    .optional(),
});
export type BlockRequest = z.infer<typeof blockRequestSchema>;

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * The categories the contract defines (docs/openapi.yaml `ReportCategory`,
 * ERD §14).
 *
 * NOT the list a caller might expect. `underage` is absent, and that is a gap
 * worth naming rather than quietly papering over with `other`: a child-safety
 * report is the single most urgent kind this product can receive, and routing
 * it into the same bucket as "something else" loses the one signal that should
 * jump the queue. Adding it is a contract change, so it is raised as a
 * decision rather than taken here.
 */
export const REPORT_CATEGORIES = [
  'scam',
  'harassment',
  'impersonation',
  'fake_profile',
  'inappropriate_content',
  'misrepresented_status',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Where the reported behaviour happened. Only `profile` is reachable today. */
export const REPORT_CONTEXT_TYPES = ['profile', 'conversation', 'message', 'photo'] as const;
export type ReportContextType = (typeof REPORT_CONTEXT_TYPES)[number];

export const REPORT_STATUSES = ['open', 'triaged', 'actioned', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const createReportSchema = z.object({
  reportedUserId: uuidSchema,
  category: z.enum(REPORT_CATEGORIES),
  description: z.string().max(2000).optional(),
  contextType: z.enum(REPORT_CONTEXT_TYPES).optional(),
  contextId: uuidSchema.optional(),
});
export type CreateReportRequest = z.infer<typeof createReportSchema>;

/**
 * What the reporter gets back.
 *
 * `outcomeKey` is a catalog key, not prose, and it describes what happened to
 * the REPORT rather than to the person reported. "We reviewed this and acted"
 * is the most that may ever be said; naming a sanction against another member
 * would disclose their account state to a stranger.
 */
export const reportSchema = z.object({
  id: uuidSchema,
  category: z.enum(REPORT_CATEGORIES),
  status: z.enum(REPORT_STATUSES),
  outcomeKey: z.string().nullable(),
  createdAt: timestampSchema,
  resolvedAt: z.string().nullable(),
});
export type Report = z.infer<typeof reportSchema>;

export const reportPageSchema = pageSchema(reportSchema);
export type ReportPage = z.infer<typeof reportPageSchema>;
