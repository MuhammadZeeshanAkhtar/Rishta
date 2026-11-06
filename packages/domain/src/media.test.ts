import { describe, expect, it } from 'vitest';
import { PHOTO_CONTENT_TYPES, resolvePhotoContentType } from './media';

/**
 * resolvePhotoContentType — what an upload is declared as (Phase 1 review, R1).
 *
 * The server checks the decoded image against this declaration (review B8),
 * so a wrong answer here is a rejected photo that still costs a slot. Null is
 * the safe answer: the client refuses before reserving anything.
 */

describe('resolvePhotoContentType — the three supported formats', () => {
  it.each(PHOTO_CONTENT_TYPES)('accepts %s as itself', (type) => {
    expect(resolvePhotoContentType(type)).toBe(type);
  });

  it('normalises case and surrounding space', () => {
    expect(resolvePhotoContentType('  IMAGE/PNG ')).toBe('image/png');
    expect(resolvePhotoContentType('Image/WebP')).toBe('image/webp');
  });

  it('ignores MIME parameters', () => {
    expect(resolvePhotoContentType('image/jpeg; charset=binary')).toBe('image/jpeg');
  });

  it('accepts the non-standard image/jpg that Android reports, as JPEG', () => {
    expect(resolvePhotoContentType('image/jpg')).toBe('image/jpeg');
  });
});

describe('resolvePhotoContentType — refusals', () => {
  it.each([
    'image/heic',
    'image/heif',
    'image/gif',
    'image/svg+xml',
    'image/tiff',
    'image/bmp',
    'image/avif',
    'application/octet-stream',
    'text/plain',
    'jpeg',
    'image/',
  ])('refuses %s', (type) => {
    expect(resolvePhotoContentType(type)).toBeNull();
  });

  it('refuses a missing type', () => {
    expect(resolvePhotoContentType()).toBeNull();
    expect(resolvePhotoContentType(undefined)).toBeNull();
    expect(resolvePhotoContentType(null)).toBeNull();
  });

  it('refuses a blank type', () => {
    expect(resolvePhotoContentType('')).toBeNull();
    expect(resolvePhotoContentType('   ')).toBeNull();
  });
});

describe('resolvePhotoContentType — candidates in order of authority', () => {
  it('uses the first candidate that is present', () => {
    expect(resolvePhotoContentType('image/png', 'image/jpeg')).toBe('image/png');
  });

  it('falls back only when an earlier candidate is MISSING or blank', () => {
    expect(resolvePhotoContentType(undefined, 'image/webp')).toBe('image/webp');
    expect(resolvePhotoContentType(null, 'image/png')).toBe('image/png');
    expect(resolvePhotoContentType('', 'image/jpeg')).toBe('image/jpeg');
  });

  it('does NOT fall back past an unsupported answer', () => {
    // The picker said HEIC. A blob type claiming JPEG does not make it so,
    // and sending it as JPEG would be rejected by the server's decode check.
    expect(resolvePhotoContentType('image/heic', 'image/jpeg')).toBeNull();
  });

  it('refuses when every candidate is missing', () => {
    expect(resolvePhotoContentType(undefined, '', null)).toBeNull();
  });
});
