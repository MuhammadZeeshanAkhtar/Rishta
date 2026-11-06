import type { ConversationStage } from '@nikahmate/domain';

/**
 * What the stage row in a chat offers. Free of React so it is tested directly. The
 * API decides what is allowed; this only picks what to show.
 *
 * Before this the app could propose moving to the next stage, but nobody could see or
 * answer a proposal, so every conversation stayed at stage 1 for good.
 */
export type StageRow =
  | { kind: 'none' }
  | { kind: 'final' }
  | { kind: 'propose'; toStage: number }
  | { kind: 'waiting'; toStage: number }
  | { kind: 'asked'; toStage: number };

const FINAL_STAGE = 5;

export function stageRow(stage: ConversationStage | null, canWrite: boolean): StageRow {
  if (!stage) return { kind: 'none' };
  if (stage.currentStage >= FINAL_STAGE) return { kind: 'final' };
  // A proposal can still be open on a closed conversation only briefly (0028 cancels
  // them), and neither side can act on it, so a closed conversation offers nothing.
  if (!canWrite) return { kind: 'none' };
  const pending = stage.pendingProposal;
  if (pending) {
    return pending.proposedByMe
      ? { kind: 'waiting', toStage: pending.toStage }
      : { kind: 'asked', toStage: pending.toStage };
  }
  return { kind: 'propose', toStage: stage.currentStage + 1 };
}
