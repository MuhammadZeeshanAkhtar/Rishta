import { z } from 'zod';
import { pageSchema, timestampSchema, uuidSchema } from './common';

/**
 * Conversations and messages (Phase 7, ADR 0011, ERD §11).
 *
 * Mirrors the Conversations section of docs/openapi.yaml.
 *
 * THE SHAPE REFLECTS THE GATE. A conversation carries a `canWrite` that is
 * NOT derived from membership: a thread can be readable and closed at the
 * same time, because a family approval was withdrawn or a block appeared.
 * Clients that treated membership as permission would show a composer that
 * fails on send, so the server answers the question directly.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CONVERSATION_STATUSES = ['active', 'archived', 'ended'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_KINDS = ['text', 'voice', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const PARTICIPANT_ROLES = ['principal', 'wali'] as const;

export const STAGE_PROPOSAL_STATUSES = ['pending', 'accepted', 'declined'] as const;

/** Stages 1-5. What each unlocks is a product rule, not a schema one. */
export const MIN_STAGE = 1;
export const MAX_STAGE = 5;

/** The contract's cap. Enforced again by `messages_body_len`. */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Why a thread cannot be written to right now.
 *
 * Returned rather than inferred, because the reasons are genuinely different
 * to a person: "your family has not decided yet" and "you blocked them" call
 * for completely different UI, and a client guessing from
 * `communicationState` would have to reimplement the server's predicate.
 */
export const WRITE_BLOCKED_REASONS = [
  'pending_family_review',
  'family_rejected',
  'family_revoked',
  'blocked',
  'match_ended',
  'archived',
  'left',
  'read_only',
] as const;
export type WriteBlockedReason = (typeof WRITE_BLOCKED_REASONS)[number];

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const conversationParticipantSchema = z.object({
  userId: uuidSchema,
  displayName: z.string().nullable(),
  role: z.enum(PARTICIPANT_ROLES),
  canWrite: z.boolean(),
  isSelf: z.boolean(),
});

export const conversationSummarySchema = z.object({
  id: uuidSchema,
  matchId: uuidSchema,
  status: z.enum(CONVERSATION_STATUSES),
  counterpartUserId: uuidSchema,
  counterpartDisplayName: z.string().nullable(),
  /** Null until somebody speaks. */
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().min(0),
  stage: z.number().int().min(MIN_STAGE).max(MAX_STAGE),
  /** The answer, not the inputs. */
  canWrite: z.boolean(),
  writeBlockedReason: z.enum(WRITE_BLOCKED_REASONS).nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationPageSchema = pageSchema(conversationSummarySchema);
export type ConversationPage = z.infer<typeof conversationPageSchema>;

export const conversationDetailSchema = conversationSummarySchema.extend({
  participants: z.array(conversationParticipantSchema),
  /**
   * The counterpart's read position, or null when they have read receipts off.
   *
   * Suppression is applied HERE rather than by not writing the row: unread
   * counts are the reader's own feature and must work whether or not they
   * tell anyone (ERD §11).
   */
  counterpartLastReadAt: z.string().nullable(),
  createdAt: timestampSchema,
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const messageSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  senderUserId: uuidSchema,
  /** True when the caller sent it. Saves every client the same comparison. */
  isMine: z.boolean(),
  /** Set when a delegate wrote on the sender's behalf (A7, M2). */
  actedByUserId: uuidSchema.nullable(),
  body: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  editedAt: z.string().nullable(),
  createdAt: timestampSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const messagePageSchema = pageSchema(messageSchema);
export type MessagePage = z.infer<typeof messagePageSchema>;

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

export const markReadSchema = z.object({
  /** The newest message the caller has seen. */
  lastReadMessageId: uuidSchema,
});
export type MarkReadRequest = z.infer<typeof markReadSchema>;

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const stageProposalSchema = z.object({
  id: uuidSchema,
  fromStage: z.number().int(),
  toStage: z.number().int(),
  proposedByUserId: uuidSchema,
  proposedByMe: z.boolean(),
  status: z.enum(STAGE_PROPOSAL_STATUSES),
  createdAt: timestampSchema,
});
export type StageProposal = z.infer<typeof stageProposalSchema>;

export const conversationStageSchema = z.object({
  conversationId: uuidSchema,
  currentStage: z.number().int().min(MIN_STAGE).max(MAX_STAGE),
  /** The one live proposal, or null. */
  pendingProposal: stageProposalSchema.nullable(),
});
export type ConversationStage = z.infer<typeof conversationStageSchema>;

export const respondToStageSchema = z.object({
  accept: z.boolean(),
});
export type RespondToStageRequest = z.infer<typeof respondToStageSchema>;

/**
 * Can this stage be advanced, and to what?
 *
 * Pure so it can be asserted without a database. Stage 5 is the end of the
 * ladder: there is no stage 6 to propose.
 */
export function nextStage(current: number): number | null {
  return current >= MAX_STAGE ? null : current + 1;
}
