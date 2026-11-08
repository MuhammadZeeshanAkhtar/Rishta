import type { DeletionRequest } from '@nikahmate/domain';

/**
 * The decisions behind the account deletion screens, free of React so they are
 * tested directly. None of this is authorisation: the API decides, and places a
 * safety hold where one applies (`POST /me/delete`).
 *
 * Typing a word rather than pressing "Are you sure?" is deliberate. A confirmation
 * dialog is pressed by reflex, and this hides the person's profile at once.
 */

export const DELETION_CONFIRMATION_WORD = 'DELETE';

/** Forgiving about case and stray spaces: phone keyboards add both. */
export function deletionConfirmed(typed: string): boolean {
  return typed.trim().toUpperCase() === DELETION_CONFIRMATION_WORD;
}

export interface DeletionDetails {
  /** A readable date, when this session knows one. */
  scheduledOn: string | null;
  /** A safety hold: deletion waits for a review to finish. */
  held: boolean;
}

/**
 * What can be said about an open request. The request's details are only returned
 * when it is made, so after the app restarts neither is known, and the screen says
 * only that a request is open rather than guessing a date.
 */
export function deletionDetails(
  request: DeletionRequest | null,
  formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleDateString(),
): DeletionDetails {
  if (!request) return { scheduledOn: null, held: false };
  return { scheduledOn: formatDate(request.scheduledFor), held: request.status === 'held' };
}
