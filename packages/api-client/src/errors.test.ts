import { describe, expect, it } from 'vitest';
import { fromAuthError, isNikahMateError, NikahMateError } from './errors';

/**
 * The contract these tests defend: nothing a provider says reaches a screen.
 *
 * A user who mistypes a password should read "That email or password did not
 * match", not "Invalid login credentials" — and never a Postgres error. So
 * every input here, however malformed, must come out as a known kind with a
 * translation key.
 */

describe('fromAuthError', () => {
  it('maps Supabase error codes to kinds', () => {
    const cases: Array<[string, string]> = [
      ['invalid_credentials', 'invalid_credentials'],
      ['email_not_confirmed', 'email_not_confirmed'],
      ['user_already_exists', 'email_taken'],
      ['weak_password', 'weak_password'],
      ['over_email_send_rate_limit', 'rate_limited'],
      ['refresh_token_not_found', 'session_expired'],
    ];
    for (const [code, expected] of cases) {
      expect(fromAuthError({ code, message: 'raw provider text' }).kind).toBe(expected);
    }
  });

  it('prefers the code over the message when they disagree', () => {
    // Message text changes between Supabase releases; codes do not. If a
    // future release reworded this message, the code must still win.
    const error = fromAuthError({
      code: 'email_not_confirmed',
      message: 'Invalid login credentials',
    });
    expect(error.kind).toBe('email_not_confirmed');
  });

  it('falls back to HTTP status when no code is present', () => {
    expect(fromAuthError({ status: 429, message: 'slow down' }).kind).toBe('rate_limited');
    expect(fromAuthError({ status: 401, message: 'jwt expired' }).kind).toBe('session_expired');
    expect(fromAuthError({ status: 503, message: 'upstream' }).kind).toBe('server');
  });

  it('recognises a failed fetch as a network problem, not a server one', () => {
    // The distinction matters: network offers "try again", server does not.
    const error = fromAuthError(new TypeError('Network request failed'));
    expect(error.kind).toBe('network');
    expect(error.isRetryable).toBe(true);
  });

  it('sniffs the message only as a last resort', () => {
    expect(fromAuthError({ message: 'Email not confirmed' }).kind).toBe('email_not_confirmed');
    expect(fromAuthError({ message: 'Invalid login credentials' }).kind).toBe(
      'invalid_credentials',
    );
    expect(fromAuthError({ message: 'User already registered' }).kind).toBe('email_taken');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 0, '', [], {}, new Error('boom')]) {
      const error = fromAuthError(input);
      expect(isNikahMateError(error)).toBe(true);
      expect(error.messageKey).toMatch(/^errors\./);
    }
  });

  it('passes an existing NikahMateError through unchanged', () => {
    const original = new NikahMateError('forbidden');
    expect(fromAuthError(original)).toBe(original);
  });

  it('keeps the raw text in detail, out of anything renderable', () => {
    const error = fromAuthError({ code: 'invalid_credentials', message: 'PGRST301: jwt bad' });
    expect(error.detail).toContain('PGRST301');
    // `message` is what a careless `{String(error)}` would render, so it must
    // be the kind, never the provider's text.
    expect(error.message).toBe('invalid_credentials');
    expect(error.message).not.toContain('PGRST301');
  });

  it('gives every kind a translation key', () => {
    const kinds = [
      'invalid_credentials',
      'email_not_confirmed',
      'email_taken',
      'weak_password',
      'invalid_email',
      'rate_limited',
      'session_expired',
      'network',
      'server',
      'unknown',
      'validation_failed',
      'unauthenticated',
      'forbidden',
      'not_found',
      'conflict',
    ] as const;
    for (const kind of kinds) {
      expect(new NikahMateError(kind).messageKey).toMatch(/^errors\.[a-zA-Z]+$/);
    }
  });
});
