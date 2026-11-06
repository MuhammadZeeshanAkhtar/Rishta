/**
 * The words for an access log entry. The log stores codes such as `review.open` and
 * `approve_communication`, and the screen used to show them to members as they were.
 */

const ACTION_KEYS: Record<string, string> = {
  'review.open': 'family.accessActionOpened',
  'review.approved': 'family.accessActionApproved',
  'review.rejected': 'family.accessActionDeclined',
  'review.more_info_requested': 'family.accessActionAskedMore',
  'review.revoked': 'family.accessActionRevoked',
};

/** An action this version does not know yet still reads as a sentence, not a code. */
export function accessActionKey(action: string): string {
  return ACTION_KEYS[action] ?? 'family.accessActionOther';
}

/** The same label the permission has everywhere else on the Family screens. */
export function accessPermissionKey(permission: string): string {
  return `family.perm${permission.charAt(0).toUpperCase()}${permission.slice(1)}`;
}

export const ACCESS_ACTION_KEYS = [...Object.values(ACTION_KEYS), 'family.accessActionOther'];
