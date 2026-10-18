import { meetsMinimumAge } from '@nikahmate/domain';

/**
 * Client-side validation.
 *
 * This is a courtesy, not a control. Every rule here is enforced again by the
 * API and, where it matters, by a database constraint — the age gate is a
 * trigger, gender immutability is a trigger, and the identity invariant is a
 * CHECK. Validating here just means people find out before a round trip
 * instead of after one.
 *
 * Each function returns a translation KEY or undefined, so the caller
 * localises. Returning English here would be a hardcoded string in disguise.
 */

export type ValidationKey = string | undefined;

/**
 * Deliberately permissive. Strict email regexes reject valid addresses —
 * apostrophes, plus-addressing, new TLDs — and the only real proof an address
 * works is the verification email we are about to send anyway.
 */
export function validateEmail(value: string): ValidationKey {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'validation.required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'validation.emailInvalid';
  return undefined;
}

/** Minimum length only. Composition rules push people toward `Password1!`. */
export const MIN_PASSWORD_LENGTH = 8;

export function validatePassword(value: string): ValidationKey {
  if (value.length === 0) return 'validation.required';
  if (value.length < MIN_PASSWORD_LENGTH) return 'validation.passwordTooShort';
  return undefined;
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): ValidationKey {
  if (confirmation.length === 0) return 'validation.required';
  if (password !== confirmation) return 'validation.passwordsDoNotMatch';
  return undefined;
}

export function validateDisplayName(value: string): ValidationKey {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'validation.nameTooShort';
  if (trimmed.length > 80) return 'validation.nameTooLong';
  return undefined;
}

/** ISO `YYYY-MM-DD`. Empty is "required"; malformed is "invalid". */
export function validateDateOfBirth(value: string, now: Date = new Date()): ValidationKey {
  if (value.trim().length === 0) return 'validation.required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'validation.dateInvalid';

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 'validation.dateInvalid';

  // Catches 2026-02-31, which Date happily rolls forward into March.
  if (parsed.toISOString().slice(0, 10) !== value) return 'validation.dateInvalid';

  if (parsed.getTime() > now.getTime()) return 'validation.dateInFuture';
  if (!meetsMinimumAge(value, now)) return 'validation.tooYoung';
  return undefined;
}

export function validateRequired(value: string | null | undefined): ValidationKey {
  return value === null || value === undefined || String(value).trim().length === 0
    ? 'validation.required'
    : undefined;
}

export function validateSelectedOne(value: string | null | undefined): ValidationKey {
  return value ? undefined : 'validation.selectOne';
}

export function validateAgeRange(min: number, max: number): ValidationKey {
  return min > max ? 'validation.ageRangeInvalid' : undefined;
}

/** True when every value in the record is undefined. */
export function isValid(errors: Record<string, ValidationKey>): boolean {
  return Object.values(errors).every((e) => e === undefined);
}
