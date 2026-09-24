import { z } from 'zod';
import { PROBLEM_CODES } from './constants';

/**
 * Primitive validators shared by every schema.
 *
 * International standards, not ad-hoc formats (README §8 rule 3): ISO 3166-1
 * alpha-2 countries, IANA timezones, E.164 phone numbers.
 */

export const uuidSchema = z.string().uuid();

/** ISO 3166-1 alpha-2, uppercase. */
export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code');

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
 */
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
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

/** BCP-47-ish language tag. Kept permissive so adding a locale stays a data change. */
export const localeSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/, 'Must be a language tag such as en, ur or pt-BR');

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
