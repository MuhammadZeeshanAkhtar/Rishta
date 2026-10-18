import { z } from 'zod';
import { REFERENCE_TYPES } from './constants';
import { referenceCodeSchema, requestedLocaleSchema } from './common';

/**
 * Reference data — the generic `(type, code)` vocabulary that replaced nineteen
 * near-identical tables (ADR 0009).
 *
 * The client caches these aggressively and re-fetches a type only when its hash
 * changes. On a 3G connection in a target market that is the difference between
 * a usable app and a spinner.
 */

export const referenceTypeSchema = z.enum(REFERENCE_TYPES);

export const referenceItemSchema = z.object({
  code: referenceCodeSchema,
  type: referenceTypeSchema,
  /** Localised label. Never stored on a profile — profiles store the code. */
  label: z.string(),
  description: z.string().nullable(),
  /** Country -> region -> city. */
  parentCode: referenceCodeSchema.nullable(),
  sortOrder: z.number().int(),
});
export type ReferenceItem = z.infer<typeof referenceItemSchema>;

export const referenceListSchema = z.object({
  type: referenceTypeSchema,
  /** Content hash. The client re-fetches only when this changes. */
  hash: z.string(),
  items: z.array(referenceItemSchema),
});
export type ReferenceList = z.infer<typeof referenceListSchema>;

/** `{ [type]: hash }` for every reference type, in one round trip. */
export const referenceManifestSchema = z.record(referenceTypeSchema, z.string());
export type ReferenceManifest = z.infer<typeof referenceManifestSchema>;

export const referenceQuerySchema = z.object({
  locale: requestedLocaleSchema.optional(),
  parentCode: referenceCodeSchema.optional(),
});
export type ReferenceQuery = z.infer<typeof referenceQuerySchema>;
