import {
  MAX_DOB_CORRECTION_REASON,
  MIN_DOB_CORRECTION_REASON,
  type DobCorrection,
} from '@nikahmate/domain';
import { validateDateOfBirth, type ValidationKey } from '../lib/validation';

/**
 * The member's side of a date-of-birth correction (review B6, decision 4).
 *
 * The date is locked once the profile is complete; a change is a request that
 * support verifies and decides, and the decision is audited. Nothing here can
 * change the date: the API refuses a direct edit (409) and the database
 * refuses it for members (0029). This is the courtesy layer — it explains,
 * validates before a round trip, and shows where a request stands.
 */

export interface CorrectionInput {
  requestedDob: string;
  reason: string;
  /** The member's current date of birth, when known. */
  currentDob: string | null;
}

export interface CorrectionErrors {
  requestedDob?: ValidationKey;
  reason?: ValidationKey;
}

export function validateCorrection(
  input: CorrectionInput,
  now: Date = new Date(),
): CorrectionErrors {
  const errors: CorrectionErrors = {};
  const date = validateDateOfBirth(input.requestedDob.trim(), now);
  if (date) errors.requestedDob = date;
  else if (input.currentDob !== null && input.requestedDob.trim() === input.currentDob) {
    errors.requestedDob = 'dobCorrection.sameAsCurrent';
  }
  const reason = input.reason.trim();
  if (reason.length < MIN_DOB_CORRECTION_REASON) errors.reason = 'dobCorrection.reasonTooShort';
  else if (reason.length > MAX_DOB_CORRECTION_REASON) errors.reason = 'dobCorrection.reasonTooLong';
  return errors;
}

export interface CorrectionState {
  /** A request support has not decided yet. While it exists, no new one. */
  open: DobCorrection | null;
  /** The most recent decided request, to show its outcome and reason. */
  lastDecided: DobCorrection | null;
  canRequest: boolean;
}

/** `items` newest first, as the API returns them. */
export function correctionState(items: readonly DobCorrection[]): CorrectionState {
  const open = items.find((i) => i.status === 'pending') ?? null;
  const lastDecided = items.find((i) => i.status !== 'pending') ?? null;
  return { open, lastDecided, canRequest: open === null };
}
