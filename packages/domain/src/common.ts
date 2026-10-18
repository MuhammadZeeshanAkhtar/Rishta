import { z } from 'zod';
import { LOCALES, PROBLEM_CODES } from './constants';

/**
 * Primitive validators shared by every schema.
 *
 * International standards, not ad-hoc formats (README §8 rule 3): ISO 3166-1
 * alpha-2 countries, IANA timezones, E.164 phone numbers.
 */

export const uuidSchema = z.string().uuid();

/**
 * ISO 3166-1 alpha-2, canonicalised to LOWER case.
 *
 * Lower case is not a preference, it is forced. Country codes live in
 * `reference_items` like every other coded value, and
 * `reference_items_code_shape` requires `^[a-z][a-z0-9_]*$`. `users.country_code`
 * and `profiles.nationality_code` carry composite foreign keys to that table,
 * so an upper-case 'PK' fails on insert with a foreign-key violation rather
 * than a validation error — the confusing kind of failure, at the wrong layer.
 *
 * Input is accepted in either case and normalised here, so a client that sends
 * the ISO-canonical 'PK' still works. One conversion, at the boundary.
 */
export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code')
  .transform((value) => value.toLowerCase());

/**
 * E.164. Leading '+', first digit 1-9, 7–15 digits total.
 * Full validation (is this a real number in this country?) belongs to
 * libphonenumber at the edge; this is the shape check.
 */
export const phoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number, e.g. +923001234567');

/**
 * IANA timezone identifier. Validated against the runtime's own tz database
 * rather than a hardcoded list, which would go stale.
 *
 * ONLY A `RangeError` MEANS "INVALID". ECMA-402 specifies that an unrecognised
 * `timeZone` option makes the `Intl.DateTimeFormat` constructor throw a
 * `RangeError`, and that is the only exception describing the INPUT. A bare
 * `catch` returning false therefore reported every other failure — a runtime
 * built without full ICU, an allocation failure under load — as "you typed a
 * bad timezone".
 *
 * That misattribution is expensive in both directions. The caller is told to
 * correct input that was never wrong, and cannot succeed by retrying with
 * anything else; the operator sees nothing at all, because a 400 is a normal
 * day. Rethrowing turns the same event into a 500 that is logged and sent to
 * Sentry (services/api/src/app.ts), which is what an unexpected failure should
 * cost. `safeParse` propagates a non-Zod throw rather than swallowing it, so
 * the distinction survives all the way to the error handler.
 *
 * FAILING OPEN WAS THE ALTERNATIVE, and it is worse. `user_settings.timezone`
 * drives notification quiet hours (ERD §7), so accepting an unvalidated value
 * would mis-time every notification for that account — silently, and for as
 * long as the row survives. A loud failure beats a quiet wrong answer.
 */
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  },
  { message: 'Must be an IANA timezone identifier, e.g. Asia/Karachi' },
);

/**
 * A reference code such as `edu_bachelors`.
 *
 * Never a display string: storing "Bachelor's Degree" would make the field
 * untranslatable and break filtering across languages (README §8 rule 2).
 */
export const referenceCodeSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Must be a lower_snake_case reference code');

/**
 * A supported locale — one the product actually ships.
 *
 * Closed rather than a permissive language-tag pattern: the product ships in
 * English only, and a stored `ur` or `pt-BR` would be a value nothing can
 * render. Widening this is how a second locale gets added.
 */
export const localeSchema = z.enum(LOCALES);

/**
 * A locale a client ASKS FOR, which is a different thing.
 *
 * Deliberately permissive. A request carrying `ur` is not invalid — it is a
 * preference the server cannot meet, and the answer is English rather than a
 * 400. Urdu was a launch locale, so installed builds still ask for it; failing
 * those requests would empty every reference dropdown in an older app, which
 * is the exact failure this contract already had once.
 *
 * Liberal in what it accepts, strict in what it stores: values that reach the
 * database or a response go through `localeSchema` instead.
 */
export const requestedLocaleSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/, 'Must be a language tag such as en or pt-BR');

/** ISO 8601 instant, always with an offset. */
export const timestampSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Every non-2xx response body. Mirrors `Problem` in docs/openapi.yaml. */
export const problemSchema = z.object({
  code: z.enum(PROBLEM_CODES),
  /** Already localised to the caller's locale. */
  message: z.string(),
  /** i18n key, so the client can re-render when the locale changes. */
  messageKey: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

/**
 * Keyset pagination, everywhere. Never offset — it degrades linearly on the
 * longest conversations, which belong to the most engaged users (ERD §19).
 */
export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}
