/**
 * What each restricted status says and offers (review N7).
 *
 * The buttons are only what the API already permits under existing rules:
 *
 *   deactivated       POST /me/reactivate. The member chose this and can undo it.
 *   pending_deletion  DELETE /me/delete. Requests can be cancelled during the
 *                     grace period, and the account returns to its exact
 *                     previous status, so this never lifts a suspension or ban.
 *   suspended, banned no self-service way back, and nothing here promises an appeal,
 *                     a date or a reason. Those are company decisions that have not
 *                     been made.
 *
 * Everyone but pending_deletion can also ask for deletion. That is POST /me/delete,
 * whose existing rule (R4) holds the request while a safety matter is open, so for a
 * suspended or banned member it lifts nothing.
 *
 * An unknown status gets the most cautious wording and sign-out only, matching
 * the API, which refuses any status it does not recognise.
 */

export type RestrictedAction = 'reactivate' | 'cancel_deletion' | 'request_deletion' | 'sign_out';

export interface RestrictedContent {
  titleKey: string;
  explanationKey: string;
  nextStepKey: string;
  actions: readonly RestrictedAction[];
}

const OF_STATUS: Record<string, RestrictedContent> = {
  suspended: {
    titleKey: 'restricted.suspended.title',
    explanationKey: 'restricted.suspended.explanation',
    nextStepKey: 'restricted.suspended.nextStep',
    actions: ['sign_out', 'request_deletion'],
  },
  banned: {
    titleKey: 'restricted.banned.title',
    explanationKey: 'restricted.banned.explanation',
    nextStepKey: 'restricted.banned.nextStep',
    actions: ['sign_out', 'request_deletion'],
  },
  deactivated: {
    titleKey: 'restricted.deactivated.title',
    explanationKey: 'restricted.deactivated.explanation',
    nextStepKey: 'restricted.deactivated.nextStep',
    actions: ['reactivate', 'sign_out', 'request_deletion'],
  },
  pending_deletion: {
    titleKey: 'restricted.pendingDeletion.title',
    explanationKey: 'restricted.pendingDeletion.explanation',
    nextStepKey: 'restricted.pendingDeletion.nextStep',
    actions: ['cancel_deletion', 'sign_out'],
  },
};

const UNKNOWN: RestrictedContent = {
  titleKey: 'restricted.unknown.title',
  explanationKey: 'restricted.unknown.explanation',
  nextStepKey: 'restricted.unknown.nextStep',
  actions: ['sign_out'],
};

export function restrictedContent(status: string): RestrictedContent {
  return Object.prototype.hasOwnProperty.call(OF_STATUS, status) ? OF_STATUS[status]! : UNKNOWN;
}

export const RESTRICTED_STATUSES = Object.keys(OF_STATUS);
