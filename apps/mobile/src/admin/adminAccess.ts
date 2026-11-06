import {
  ADMIN_AREA_ROLES,
  canUseAdminArea,
  type AdminArea,
  type AdminRole,
  type UserAction,
} from '@nikahmate/domain';

/**
 * The admin interface's decisions about what to SHOW (review L1).
 *
 * None of this is authorisation. The API checks the staff row, the role and
 * the second factor on every call; these functions only pick the screen that
 * matches what the API said — a sign-in prompt, the second-factor step, a
 * "not available" page — and keep forms from sending what the API would
 * refuse. Free of React so it is tested directly.
 */

export type AdminGate =
  /** Signed out, or the session expired: sign in again. */
  | 'signed_out'
  /** The API says this account is not staff (404). */
  | 'not_staff'
  /** A second factor is required and the account has one: enter a code. */
  | 'verify_mfa'
  /** A second factor is required and none is enrolled yet: set one up. */
  | 'enroll_mfa'
  /** Staff with a second factor, but not permitted (role, or disabled). */
  | 'forbidden'
  /** Anything else — network, server. Offer a retry. */
  | 'error';

export interface Assurance {
  current: 'aal1' | 'aal2' | null;
  next: 'aal1' | 'aal2' | null;
}

/** Which gate the API's refusal of `GET /admin/session` points to. */
export function gateFor(
  errorKind: string,
  assurance: Assurance | null,
  hasVerifiedFactor: boolean,
): AdminGate {
  if (errorKind === 'unauthenticated' || errorKind === 'session_expired') return 'signed_out';
  if (errorKind === 'not_found') return 'not_staff';
  if (errorKind === 'forbidden') {
    if (assurance?.current === 'aal2') return 'forbidden';
    return hasVerifiedFactor ? 'verify_mfa' : 'enroll_mfa';
  }
  return 'error';
}

export const ADMIN_AREAS = Object.keys(ADMIN_AREA_ROLES) as AdminArea[];

/** The areas to offer; the API refuses the rest regardless. */
export function areasFor(roles: readonly AdminRole[]): AdminArea[] {
  return ADMIN_AREAS.filter((area) => canUseAdminArea(roles, area));
}

/** Authenticator codes are six digits. */
export function validTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

export const MIN_STAFF_NOTE = 5;
export const MAX_STAFF_NOTE = 1000;

/**
 * Problems with a moderation decision before it is sent, as i18n keys.
 *
 * Every decision needs a written note — it is the audit trail's "why". A
 * photo or profile rejection also needs the reason the member is shown (the
 * API refuses it without one); a DOB rejection's note IS what the member is
 * shown.
 */
export function decisionProblems(input: {
  area: 'photos' | 'profiles' | 'dobCorrections';
  decision: 'approve' | 'reject' | null;
  reasonKey: string | null;
  note: string;
}): { decision?: string; reasonKey?: string; note?: string } {
  const problems: { decision?: string; reasonKey?: string; note?: string } = {};
  if (input.decision === null) problems.decision = 'admin.decision.chooseOne';
  const note = input.note.trim();
  if (note.length < MIN_STAFF_NOTE) problems.note = 'admin.decision.noteRequired';
  else if (note.length > MAX_STAFF_NOTE) problems.note = 'admin.decision.noteTooLong';
  if (input.decision === 'reject' && input.area !== 'dobCorrections' && !input.reasonKey) {
    problems.reasonKey = 'admin.decision.reasonRequired';
  }
  return problems;
}

/**
 * Problems with an account action. A reason is always required (the database
 * refuses a blank one: an unexplained ban is unappealable); an end date only
 * means something for a suspension and must be in the future.
 */
export function userActionProblems(
  input: { action: UserAction | null; reason: string; expiresAt: string },
  now: Date = new Date(),
): { action?: string; reason?: string; expiresAt?: string } {
  const problems: { action?: string; reason?: string; expiresAt?: string } = {};
  if (input.action === null) problems.action = 'admin.users.chooseAction';
  const reason = input.reason.trim();
  if (reason.length < MIN_STAFF_NOTE) problems.reason = 'admin.decision.noteRequired';
  else if (reason.length > MAX_STAFF_NOTE) problems.reason = 'admin.decision.noteTooLong';
  const end = input.expiresAt.trim();
  if (end.length > 0) {
    if (input.action !== 'suspend') problems.expiresAt = 'admin.users.endOnlyForSuspend';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(Date.parse(`${end}T00:00:00Z`))) {
      problems.expiresAt = 'validation.dateInvalid';
    } else if (Date.parse(`${end}T00:00:00Z`) <= now.getTime()) {
      problems.expiresAt = 'admin.users.endInPast';
    }
  }
  return problems;
}

/** `YYYY-MM-DD` → the RFC 3339 instant the API expects, end of that day UTC. */
export function expiresAtFromDate(date: string): string | undefined {
  const trimmed = date.trim();
  return trimmed.length === 0 ? undefined : `${trimmed}T23:59:59.000Z`;
}
