import sharp from 'sharp';
import { PHOTO_CONTENT_TYPES, type PhotoContentType } from '@nikahmate/domain';

/**
 * Server-side derivatives.
 *
 * Two are generated at finalize, and both are STORED:
 *
 *   - `thumb`  — small, for lists and cards.
 *   - `blurred` — what a viewer sees at the `blurred` tier.
 *
 * The blurred file exists as a file because the alternative — sending the
 * original and blurring in the client — means the real image already reached
 * the device. Anyone can screenshot before the filter paints, read it out of
 * the cache, or simply not apply it. A privacy control that depends on the
 * client choosing to honour it is decoration (ERD §7, risk R5).
 *
 * The blur is also destructive on purpose: downscale hard first, blur, then
 * upscale. Blurring a full-resolution image leaves recoverable detail, because
 * the information is still there under a reversible convolution. Throwing the
 * pixels away first means there is nothing to recover.
 */

export interface GeneratedVariant {
  variant: 'thumb' | 'blurred';
  body: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
}

export interface SourceDimensions {
  width: number;
  height: number;
}

const THUMB_EDGE = 400;
/** The blur is computed at this edge, so detail is destroyed, not hidden. */
const BLUR_EDGE = 32;
const BLUR_OUTPUT_EDGE = 400;
const BLUR_SIGMA = 12;

/**
 * How every untrusted upload is opened (review B8).
 *
 * `failOn: 'warning'` — the STRICTEST level: libvips aborts on any invalid
 * pixel data, even data it could have repaired. Truncated, malformed and
 * deliberately crafted files are where image-library CVEs live, and a member
 * photo has no business being one.
 *
 * Pinned explicitly although it is sharp's default, so a future upgrade that
 * changes the default cannot loosen it silently. NOTE: the 2026-10-28 review
 * suggested `failOn: 'error'`. In sharp's own ordering — 'none' < 'truncated'
 * < 'error' < 'warning' — that is one level LOOSER than the default, and the
 * library's documentation says to keep 'warning' for untrusted input. The
 * recommendation was not applied as written.
 *
 * `limitInputPixels` stays at sharp's default (0x3FFF x 0x3FFF), which is
 * what stops a small file declaring enormous dimensions from exhausting
 * memory on decode.
 */
const UNTRUSTED_INPUT = { failOn: 'warning' } as const;

/** What libvips calls each format we accept, mapped to the declared type. */
const FORMAT_TO_CONTENT_TYPE: Readonly<Record<string, PhotoContentType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export class UnreadableImageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnreadableImageError';
  }
}

/**
 * Rejects anything that is not a real image, of an accepted format, that IS
 * the format it was declared as.
 *
 * REVIEW B8. Upload targets are issued for a declared content type, and the
 * bucket filters on it — but the declaration is the client's word. A file
 * declared `image/jpeg` that decodes as SVG, TIFF or HEIF would reach decoders
 * the product never meant to expose (librsvg and libheif are two of the
 * libraries in the sharp advisories). Checking what libvips actually found
 * against what was promised closes that, and the allowlist means a format we
 * never accept is refused even if the declaration matched it.
 */
export async function readDimensions(
  body: Buffer,
  declaredContentType: string,
): Promise<SourceDimensions> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(body, UNTRUSTED_INPUT).metadata();
  } catch {
    throw new UnreadableImageError('Not a readable image');
  }

  const detected = meta.format ? FORMAT_TO_CONTENT_TYPE[meta.format] : undefined;
  if (!detected || !(PHOTO_CONTENT_TYPES as readonly string[]).includes(detected)) {
    throw new UnreadableImageError(`Unsupported image format: ${meta.format ?? 'unknown'}`);
  }
  if (detected !== declaredContentType) {
    throw new UnreadableImageError(`Declared ${declaredContentType} but the file is ${detected}`);
  }
  if (!meta.width || !meta.height) {
    throw new UnreadableImageError('Not a readable image');
  }
  return { width: meta.width, height: meta.height };
}

export async function generateVariants(body: Buffer): Promise<GeneratedVariant[]> {
  // `rotate()` with no argument applies the EXIF orientation and then strips
  // the metadata. Without it, portrait photos from most phones arrive sideways
  // — and the EXIF block also carries GPS coordinates, which must never
  // survive into a file other members can fetch.
  const base = sharp(body, UNTRUSTED_INPUT).rotate();

  const thumb = await base
    .clone()
    .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const blurred = await base
    .clone()
    // Down to 32px first: this is the step that destroys the detail. The blur
    // afterwards only smooths what little is left.
    .resize(BLUR_EDGE, BLUR_EDGE, { fit: 'cover' })
    .blur(BLUR_SIGMA)
    .resize(BLUR_OUTPUT_EDGE, BLUR_OUTPUT_EDGE, { fit: 'cover' })
    .jpeg({ quality: 70 })
    .toBuffer({ resolveWithObject: true });

  return [
    {
      variant: 'thumb',
      body: thumb.data,
      contentType: 'image/jpeg',
      width: thumb.info.width,
      height: thumb.info.height,
    },
    {
      variant: 'blurred',
      body: blurred.data,
      contentType: 'image/jpeg',
      width: blurred.info.width,
      height: blurred.info.height,
    },
  ];
}
