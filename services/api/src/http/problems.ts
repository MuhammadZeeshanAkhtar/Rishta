import type { ProblemCode } from '@nikahmate/domain';
import { badRequest, conflict, forbidden, type ApiError } from '../errors';
/**
 * The specific problem code for a Fastify-raised 4xx (review B21).
 */
export function problemCodeForStatus(status: number, fastifyCode: string | undefined): ProblemCode {
  if (status === 413) return 'payload_too_large';
  if (status === 415) return 'unsupported_media_type';
  if (
    fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    fastifyCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
  ) {
    return 'malformed_request';
  }
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'validation_failed';
}

/**
 * Postgres errors the caller caused, as 4xx problems (review B14). SQLSTATEs:
 *   22P02 invalid_text_representation  a malformed uuid, number, …   -> 400
 *   23514 check_violation              an invariant the input broke  -> 400
 *   23505 unique_violation             it already exists             -> 409
 *   42501 insufficient_privilege       a row policy or guard refused -> 403
 * Anything else stays a 500: it is ours, not theirs.
 */
export function mapDatabaseError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  switch (code) {
    case '22P02':
      return badRequest('A value in the request is not in the expected format');
    case '23514':
      return badRequest('The request breaks a rule for this data');
    case '23505':
      return conflict('This already exists');
    case '42501':
      return forbidden('This action is not permitted in the current state');
    default:
      return null;
  }
}
