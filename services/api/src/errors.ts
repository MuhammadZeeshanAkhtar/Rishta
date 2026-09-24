import type { ProblemCode } from '@nikahmate/domain';

/**
 * Every non-2xx response uses this shape (`Problem` in docs/openapi.yaml).
 */
export interface ProblemBody {
  code: ProblemCode;
  message: string;
  messageKey?: string;
  fields?: Record<string, string>;
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly messageKey: string | undefined;
  readonly fields: Record<string, string> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ProblemCode,
    message: string,
    extra: {
      messageKey?: string;
      fields?: Record<string, string>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.messageKey = extra.messageKey;
    this.fields = extra.fields;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  toBody(): ProblemBody {
    const body: ProblemBody = { code: this.code, message: this.message };
    if (this.messageKey !== undefined) body.messageKey = this.messageKey;
    if (this.fields !== undefined) body.fields = this.fields;
    if (this.retryAfterSeconds !== undefined) body.retryAfterSeconds = this.retryAfterSeconds;
    return body;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError(400, 'validation_failed', message, fields ? { fields } : {});

export const unauthenticated = (message = 'Authentication required') =>
  new ApiError(401, 'unauthenticated', message, { messageKey: 'errors.sessionExpired' });

export const forbidden = (message = 'Not permitted') => new ApiError(403, 'forbidden', message);

/**
 * Used for genuinely-missing resources AND for anything the caller may not see.
 *
 * A 403 on a profile confirms the account exists, which is a disclosure in
 * itself — so blocks and privacy both surface as 404 (docs/openapi.yaml,
 * NotFound). This is the one place that decision is implemented; route code
 * just calls notFound().
 */
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);

export const conflict = (message: string) => new ApiError(409, 'conflict', message);

export const entitlementRequired = (entitlement: string) =>
  new ApiError(403, 'entitlement_required', `Requires the ${entitlement} entitlement`);

export const quotaExhausted = (message: string, retryAfterSeconds?: number) =>
  new ApiError(
    429,
    'quota_exhausted',
    message,
    retryAfterSeconds !== undefined ? { retryAfterSeconds } : {},
  );

export const internalError = (message = 'Something went wrong') =>
  new ApiError(500, 'internal_error', message, { messageKey: 'errors.generic' });
