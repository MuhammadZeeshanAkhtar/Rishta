import sharp from 'sharp';

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

/** Rejects anything that is not a real image of a sane size. */
export async function readDimensions(body: Buffer): Promise<SourceDimensions> {
  const meta = await sharp(body).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Not a readable image');
  }
  return { width: meta.width, height: meta.height };
}

export async function generateVariants(body: Buffer): Promise<GeneratedVariant[]> {
  // `rotate()` with no argument applies the EXIF orientation and then strips
  // the metadata. Without it, portrait photos from most phones arrive sideways
  // — and the EXIF block also carries GPS coordinates, which must never
  // survive into a file other members can fetch.
  const base = sharp(body).rotate();

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
