import type { FastifyRequest } from 'fastify';
import { badRequest } from '../errors';

/**
 * Path parameters — review B14.
 *
 * Several routes passed `:id`-style parameters straight into `$1::uuid`, so a
 * malformed id raised Postgres error 22P02 and became a 500 (and a Sentry
 * alert). Others checked `/^[0-9a-f-]{36}$/`, which accepts thirty-six dashes.
 *
 * The canonical 8-4-4-4-12 hex shape, case-insensitive. Deliberately NOT
 * zod's `uuid()`: that enforces RFC version/variant bits and rejects the nil
 * UUID, which is a well-formed id that should answer 404, not 400. Anything
 * matching this shape is accepted by Postgres's uuid input, so a value that
 * passes can never raise 22P02.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/**
 * Reads a uuid path parameter, or answers 400 before anything reaches the
 * database. `label` is the noun in the message ("Invalid conversation id").
 */
export function uuidParam(request: FastifyRequest, name: string, label: string): string {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  if (!isUuid(value)) throw badRequest(`Invalid ${label}`, { [name]: 'invalid_uuid' });
  return value;
}
