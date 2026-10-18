import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common';

/**
 * Photos and their privacy tiers.
 *
 * Mirrors the Photos section of docs/openapi.yaml and ERD §7.
 *
 * The tier names are not decoration. `blurred` means a SEPARATE pre-blurred
 * file generated on the server; the original is never sent with the
 * expectation that the client will obscure it. A client-side blur means the
 * real image already reached the device, which makes the control decorative.
 */

/** A1 — private is the default everywhere: schema, API and UI. */
export const PHOTO_VISIBILITIES = ['public', 'blurred', 'on_request', 'private'] as const;
export type PhotoVisibility = (typeof PHOTO_VISIBILITIES)[number];

export const PHOTO_VARIANTS = ['thumb', 'blurred', 'full'] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];

export const PHOTO_MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PhotoModerationStatus = (typeof PHOTO_MODERATION_STATUSES)[number];

/** What the bucket accepts. SVG is absent on purpose — it can carry script. */
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

/** 10 MB, matching the bucket limit and the `photos_byte_size_sane` constraint. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Beyond this a profile is a gallery, and moderation cost grows for nothing. */
export const MAX_PHOTOS_PER_USER = 6;

export const ownPhotoSchema = z.object({
  id: uuidSchema,
  visibility: z.enum(PHOTO_VISIBILITIES),
  position: z.number().int(),
  isPrimary: z.boolean(),
  moderationStatus: z.enum(PHOTO_MODERATION_STATUSES),
  rejectionReasonKey: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /**
   * Short-lived signed URLs, or null before finalize has produced variants.
   * Never a public URL — the bucket is private and these expire.
   */
  urls: z.object({
    thumb: z.string().nullable(),
    full: z.string().nullable(),
  }),
  createdAt: timestampSchema,
});
export type OwnPhoto = z.infer<typeof ownPhotoSchema>;

export const uploadTargetSchema = z.object({
  photoId: uuidSchema,
  uploadUrl: z.string(),
  method: z.enum(['PUT', 'POST']),
  headers: z.record(z.string(), z.string()),
  /** The object path inside the bucket. Useful for a direct SDK upload. */
  path: z.string(),
  expiresAt: timestampSchema,
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const createUploadRequestSchema = z.object({
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  byteSize: z.number().int().positive().max(MAX_PHOTO_BYTES),
});
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

/**
 * What an owner may change about a photo.
 *
 * `moderationStatus` is absent, and so is `storagePath`. The server owns both,
 * and the database withholds the column grants so that is true even if this
 * schema were wrong.
 */
export const photoUpdateSchema = z
  .object({
    visibility: z.enum(PHOTO_VISIBILITIES),
    position: z.number().int().min(0).max(50),
    isPrimary: z.boolean(),
  })
  .partial();
export type PhotoUpdate = z.infer<typeof photoUpdateSchema>;

/** Whole-gallery reorder: the full id list in the order they should appear. */
export const photoReorderSchema = z.object({
  photoIds: z.array(uuidSchema).min(1).max(MAX_PHOTOS_PER_USER),
});
export type PhotoReorder = z.infer<typeof photoReorderSchema>;
