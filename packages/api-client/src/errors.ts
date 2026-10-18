/**
 * Every failure the app can show a person, as a closed set.
 *
 * Nothing that reaches a screen is a raw Supabase or Postgres message. Those
 * leak internals, are never translated, and read as accusations ("invalid
 * login credentials") rather than help. A screen gets a stable `kind` and an
 * i18n key; it chooses the words.
 *
 * `detail` carries the original text for logs only. It is deliberately not
 * something a component can render by accident — read it in a catch, log it,
 * never put it in a <Text>.
 */

export type AuthErrorKind =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'email_taken'
  | 'weak_password'
  | 'invalid_email'
  | 'rate_limited'
  | 'session_expired'
  | 'network'
  | 'server'
  | 'unknown';

export type ApiErrorKind =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'network'
  | 'server'
  | 'unknown';

export type ErrorKind = AuthErrorKind | ApiErrorKind;

/** i18n key per kind. The catalogs own the wording; this owns the mapping. */
const MESSAGE_KEYS: Record<ErrorKind, string> = {
  invalid_credentials: 'errors.invalidCredentials',
  email_not_confirmed: 'errors.emailNotConfirmed',
  email_taken: 'errors.emailTaken',
  weak_password: 'errors.weakPassword',
  invalid_email: 'errors.invalidEmail',
  rate_limited: 'errors.rateLimited',
  session_expired: 'errors.sessionExpired',
  network: 'errors.network',
  server: 'errors.server',
  unknown: 'errors.unknown',
  validation_failed: 'errors.validationFailed',
  unauthenticated: 'errors.sessionExpired',
  forbidden: 'errors.forbidden',
  not_found: 'errors.notFound',
  conflict: 'errors.conflict',
};

export class NikahMateError extends Error {
  readonly kind: ErrorKind;
  readonly messageKey: string;
  /** Field-level problems from the API, keyed by field path. */
  readonly fields: Record<string, string> | undefined;
  /** Seconds to wait, when the failure was a rate limit. */
  readonly retryAfterSeconds: number | undefined;
  /** Original text. For logs. Never rendered. */
  readonly detail: string | undefined;

  constructor(
    kind: ErrorKind,
    options: {
      detail?: string | undefined;
      fields?: Record<string, string> | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(kind);
    this.name = 'NikahMateError';
    this.kind = kind;
    this.messageKey = MESSAGE_KEYS[kind];
    this.fields = options.fields;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.kind === 'network' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export function isNikahMateError(value: unknown): value is NikahMateError {
  return value instanceof NikahMateError;
}

/**
 * Maps a Supabase auth failure onto our closed set.
 *
 * Supabase v2 exposes a stable `code` on most auth errors; older deployments
 * and some paths only set `status` and a human message. Prefer the code, fall
 * back to status, and only then sniff the message — because message text is
 * the one part that changes without warning.
 */
export function fromAuthError(error: unknown): NikahMateError {
  if (isNikahMateError(error)) return error;

  const e = error as { code?: unknown; status?: unknown; message?: unknown; name?: unknown };
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const message = typeof e?.message === 'string' ? e.message : undefined;
  const lower = message?.toLowerCase() ?? '';

  // A fetch that never reached a server throws TypeError, with no status.
  if (
    status === undefined &&
    (e?.name === 'TypeError' || lower.includes('network request failed'))
  ) {
    return new NikahMateError('network', { detail: message });
  }

  const byCode: Record<string, AuthErrorKind> = {
    invalid_credentials: 'invalid_credentials',
    email_not_confirmed: 'email_not_confirmed',
    user_already_exists: 'email_taken',
    email_exists: 'email_taken',
    weak_password: 'weak_password',
    validation_failed: 'invalid_email',
    email_address_invalid: 'invalid_email',
    over_email_send_rate_limit: 'rate_limited',
    over_request_rate_limit: 'rate_limited',
    session_expired: 'session_expired',
    refresh_token_not_found: 'session_expired',
    refresh_token_already_used: 'session_expired',
  };
  if (code && byCode[code]) return new NikahMateError(byCode[code], { detail: message });

  if (status === 429) return new NikahMateError('rate_limited', { detail: message });
  if (status === 401 || status === 403) {
    // Supabase returns 400 for bad credentials and 401 for a dead token, so a
    // 401 here means the session, not the password.
    return new NikahMateError('session_expired', { detail: message });
  }
  if (status !== undefined && status >= 500) {
    return new NikahMateError('server', { detail: message });
  }

  // Message sniffing, last and least. Each of these has been seen from Supabase
  // without an accompanying code.
  if (lower.includes('email not confirmed')) {
    return new NikahMateError('email_not_confirmed', { detail: message });
  }
  if (lower.includes('invalid login credentials')) {
    return new NikahMateError('invalid_credentials', { detail: message });
  }
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return new NikahMateError('email_taken', { detail: message });
  }
  if (lower.includes('password')) {
    return new NikahMateError('weak_password', { detail: message });
  }

  return new NikahMateError('unknown', { detail: message });
}
