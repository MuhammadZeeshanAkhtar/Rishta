import { isNikahMateError } from '@nikahmate/api-client';

/**
 * Turns anything thrown into words a person can act on.
 *
 * The rule from the Phase 3 brief — never show a raw backend error — only
 * holds if there is exactly one place that decides what to show. This is it.
 * Screens call `describeError`; they never read `error.message`.
 */

export interface DescribedError {
  /** Already translated. Safe to render. */
  message: string;
  /** Field path -> message, when the API rejected specific inputs. */
  fields: Record<string, string> | undefined;
  /** Whether offering "Try again" makes sense. */
  retryable: boolean;
  /** Seconds to wait, for rate limits. */
  retryAfterSeconds: number | undefined;
}

export function describeError(error: unknown, t: (key: string) => string): DescribedError {
  if (isNikahMateError(error)) {
    return {
      message: t(error.messageKey),
      fields: error.fields,
      retryable: error.isRetryable,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  // Anything else is a bug in our own code rather than a server response.
  // The person still gets a sentence they can act on; the detail belongs in
  // the log, not on the screen.
  return {
    message: t('errors.generic'),
    fields: undefined,
    retryable: true,
    retryAfterSeconds: undefined,
  };
}
