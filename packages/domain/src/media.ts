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

/**
 * Non-standard spellings platforms really emit for an accepted type.
 *
 * `image/jpg` is not a registered MIME type, but Android content resolvers and
 * some browsers report it for ordinary JPEG files. Refusing it would reject
 * perfectly good photos on a technicality. Nothing outside JPEG, PNG and WebP
 * is aliased: the allowlist above is the whole of what the bucket accepts.
 */
const PHOTO_CONTENT_TYPE_ALIASES: Readonly<Record<string, PhotoContentType>> = {
  'image/jpg': 'image/jpeg',
};

/**
 * The content type to DECLARE for an upload, or null when it must not be sent.
 *
 * Takes candidates in order of authority — on mobile, the image picker's own
 * `mimeType` first, then the type of the blob read from it — and resolves the
 * FIRST one that is present. A later candidate is only consulted when an
 * earlier one is missing or blank, never when it is merely unsupported: if the
 * picker says the file is HEIC, a blob claiming JPEG does not make it so.
 *
 * Null means "do not upload". The caller refuses before asking the server for
 * an upload target, because that request is what reserves a photo slot.
 *
 * REVIEW R1 (Phase 1 review). The app used to declare `image/jpeg` for every
 * file. Once the server began checking the decoded format against the
 * declaration (review B8), a PNG or WebP upload — certain on the web build,
 * where the picker returns the original file — was rejected after upload and
 * still occupied a slot. Declaring the truth is the fix; the server check
 * stays strict.
 */
export function resolvePhotoContentType(
  ...candidates: ReadonlyArray<string | null | undefined>
): PhotoContentType | null {
  const declared = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  if (declared === undefined) return null;

  // Parameters (`; charset=…`) and case are not part of the type.
  const normalised = (declared.split(';')[0] ?? '').trim().toLowerCase();
  if ((PHOTO_CONTENT_TYPES as readonly string[]).includes(normalised)) {
    return normalised as PhotoContentType;
  }
  return PHOTO_CONTENT_TYPE_ALIASES[normalised] ?? null;
}

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
