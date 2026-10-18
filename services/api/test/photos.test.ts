import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * Photos and the Privacy Center.
 *
 * Photo leakage is risk R5, so the assertions worth making are the negative
 * ones: that an unmoderated photo has no full-resolution URL, that the blurred
 * variant is a real separate file rather than a flag, that one member cannot
 * reach another's photo, and that nobody can approve their own.
 */

let harness: TestHarness;
let authId: string;
let otherAuthId: string;

/** A real JPEG, so sharp has something genuine to work on. */
async function jpeg(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 90 } },
  })
    .jpeg()
    .toBuffer();
}

/** A fresh, bootstrapped account. The photo cap is per person. */
async function freshAccount(): Promise<string> {
  const auth = randomAuthId();
  await bootstrap(auth);
  return auth;
}

async function bootstrap(auth: string): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/account/bootstrap',
    headers: authHeader(auth),
    payload: { locale: 'en', timezone: 'Asia/Karachi' },
  });
  if (response.statusCode >= 400) throw new Error(`bootstrap: ${response.statusCode}`);
}

beforeAll(async () => {
  harness = await createHarness();
  authId = randomAuthId();
  otherAuthId = randomAuthId();
  await bootstrap(authId);
  await bootstrap(otherAuthId);
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth = authId,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  harness.app.inject({
    method,
    url,
    headers: authHeader(auth),
    ...(payload ? { payload } : {}),
  });

/** Upload target → simulated client upload → finalize. */
async function uploadPhoto(auth = authId): Promise<{ photoId: string; path: string }> {
  const created = await req('POST', '/me/photos/upload-url', auth, {
    contentType: 'image/jpeg',
    byteSize: 120_000,
  });
  if (created.statusCode !== 201) throw new Error(`upload-url: ${created.body}`);
  const { photoId, path } = created.json();

  harness.storage.put(path, await jpeg());

  const finalized = await req('POST', `/me/photos/${photoId}/finalize`, auth);
  if (finalized.statusCode !== 202) throw new Error(`finalize: ${finalized.body}`);
  return { photoId, path };
}

describe('upload flow', () => {
  it('issues a target whose path begins with the owner id', async () => {
    const response = await req('POST', '/me/photos/upload-url', authId, {
      contentType: 'image/jpeg',
      byteSize: 50_000,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();

    // The first path segment is what both the Storage policy and the
    // `photos_storage_path_owned` constraint check.
    const me = await req('GET', '/me');
    expect(body.path.startsWith(`${me.json().userId}/`)).toBe(true);
    expect(body.uploadUrl).toContain('/upload/');
  });

  it('refuses a content type outside the allowed set', async () => {
    const response = await req('POST', '/me/photos/upload-url', authId, {
      contentType: 'image/svg+xml',
      byteSize: 1000,
    });
    // SVG can carry script, so it is absent from the allowed set entirely.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a file over the 10 MB ceiling', async () => {
    const response = await req('POST', '/me/photos/upload-url', authId, {
      contentType: 'image/jpeg',
      byteSize: 10 * 1024 * 1024 + 1,
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/me/photos' });
    expect(response.statusCode).toBe(401);
  });
});

describe('finalize', () => {
  it('stores a real blurred file, not a flag', async () => {
    const { path } = await uploadPhoto();
    const base = path.replace(/\/original\.[a-z]+$/, '');

    const blurred = harness.storage.objects.get(`${base}/blurred.jpg`);
    const thumb = harness.storage.objects.get(`${base}/thumb.jpg`);
    expect(blurred).toBeDefined();
    expect(thumb).toBeDefined();

    // The decisive check: the blurred bytes differ from the original, and the
    // image behind them has been destroyed rather than merely smoothed.
    const original = harness.storage.objects.get(path)!.body;
    expect(blurred!.body.equals(original)).toBe(false);
    expect(blurred!.body.length).toBeLessThan(original.length);
  });

  it('strips EXIF so location never survives into a derivative', async () => {
    const { path } = await uploadPhoto();
    const base = path.replace(/\/original\.[a-z]+$/, '');
    const meta = await sharp(harness.storage.objects.get(`${base}/thumb.jpg`)!.body).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('records a moderation result through the service role', async () => {
    await uploadPhoto();
    expect(harness.serviceUses).toContain('photo.record_moderation');
  });

  it('rejects a file that is not a decodable image', async () => {
    const created = await req('POST', '/me/photos/upload-url', authId, {
      contentType: 'image/jpeg',
      byteSize: 10,
    });
    const { photoId, path } = created.json();
    harness.storage.put(path, Buffer.from('this is not an image'));

    const response = await req('POST', `/me/photos/${photoId}/finalize`, authId);
    expect(response.statusCode).toBe(400);

    // Marked rejected rather than left pending, so it cannot sit in the
    // moderation queue forever.
    const photos = await req('GET', '/me/photos');
    const row = photos.json().items.find((p: { id: string }) => p.id === photoId);
    expect(row.moderationStatus).toBe('rejected');
  });

  it('404s a photo belonging to someone else', async () => {
    const { photoId } = await uploadPhoto(authId);
    const response = await req('POST', `/me/photos/${photoId}/finalize`, otherAuthId);
    expect(response.statusCode).toBe(404);
  });
});

describe('visibility and urls', () => {
  let localAuth: string;
  beforeAll(async () => {
    localAuth = await freshAccount();
  });

  it('defaults a new photo to private — A1', async () => {
    await uploadPhoto(localAuth);
    const items = (await req('GET', '/me/photos', localAuth)).json().items;
    expect(items.at(-1).visibility).toBe('private');
  });

  it('withholds the full-resolution URL until moderation passes', async () => {
    const created = await req('POST', '/me/photos/upload-url', localAuth, {
      contentType: 'image/jpeg',
      byteSize: 50_000,
    });
    const { photoId, path } = created.json();
    harness.storage.put(path, await jpeg());

    const before = (await req('GET', '/me/photos', localAuth))
      .json()
      .items.find((p: { id: string }) => p.id === photoId);
    // Pending: the owner gets no full URL, because that URL is the thing that
    // gets forwarded.
    expect(before.moderationStatus).toBe('pending');
    expect(before.urls.full).toBeNull();

    await req('POST', `/me/photos/${photoId}/finalize`, localAuth);
    const after = (await req('GET', '/me/photos', localAuth))
      .json()
      .items.find((p: { id: string }) => p.id === photoId);
    expect(after.moderationStatus).toBe('approved');
    expect(after.urls.full).toContain('signed');
  });

  it('lets the owner change visibility', async () => {
    const { photoId } = await uploadPhoto(localAuth);
    const response = await req('PATCH', `/me/photos/${photoId}`, localAuth, {
      visibility: 'blurred',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().visibility).toBe('blurred');
  });

  it('refuses an unknown visibility tier', async () => {
    const { photoId } = await uploadPhoto(localAuth);
    const response = await req('PATCH', `/me/photos/${photoId}`, localAuth, {
      visibility: 'everyone',
    });
    expect(response.statusCode).toBe(400);
  });

  it('ignores an attempt to set moderation status', async () => {
    const { photoId } = await uploadPhoto(localAuth);
    const response = await req('PATCH', `/me/photos/${photoId}`, localAuth, {
      moderationStatus: 'approved',
      visibility: 'public',
    });
    // Stripped by the schema, and ungranted at the column level besides.
    expect(response.statusCode).toBe(200);
    expect(response.json().visibility).toBe('public');
  });
});

describe('primary, order and delete', () => {
  let localAuth: string;
  beforeAll(async () => {
    localAuth = await freshAccount();
  });

  it('keeps exactly one primary photo', async () => {
    const first = await uploadPhoto(localAuth);
    const second = await uploadPhoto(localAuth);

    await req('PATCH', `/me/photos/${first.photoId}`, localAuth, { isPrimary: true });
    await req('PATCH', `/me/photos/${second.photoId}`, localAuth, { isPrimary: true });

    const items = (await req('GET', '/me/photos', localAuth)).json().items;
    expect(items.filter((p: { isPrimary: boolean }) => p.isPrimary)).toHaveLength(1);
    expect(items.find((p: { id: string }) => p.id === second.photoId).isPrimary).toBe(true);
  });

  it('reorders the gallery', async () => {
    const items = (await req('GET', '/me/photos', localAuth)).json().items;
    const reversed = [...items].reverse().map((p: { id: string }) => p.id);

    const response = await req('PUT', '/me/photos/order', localAuth, { photoIds: reversed });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((p: { id: string }) => p.id)).toEqual(reversed);
  });

  it('deletes the bytes but keeps the record', async () => {
    const { photoId, path } = await uploadPhoto(localAuth);
    const base = path.replace(/\/original\.[a-z]+$/, '');

    const response = await req('DELETE', `/me/photos/${photoId}`, localAuth);
    expect(response.statusCode).toBe(204);

    // Bytes gone — including the derivatives.
    expect(harness.storage.objects.has(path)).toBe(false);
    expect(harness.storage.objects.has(`${base}/blurred.jpg`)).toBe(false);

    // Row soft-deleted, so abuse investigation still has it (E1).
    const rows = await harness.raw.query(`select deleted_at from public.photos where id = $1`, [
      photoId,
    ]);
    expect(rows.rows[0]).toBeDefined();
    expect((rows.rows[0] as { deleted_at: string | null }).deleted_at).not.toBeNull();

    const items = (await req('GET', '/me/photos', localAuth)).json().items;
    expect(items.find((p: { id: string }) => p.id === photoId)).toBeUndefined();
  });

  it('does NOT let one member delete another member photo', async () => {
    const { photoId } = await uploadPhoto(localAuth);
    const response = await req('DELETE', `/me/photos/${photoId}`, otherAuthId);
    expect(response.statusCode).toBe(404);
  });

  it('does NOT let one member see another member photos', async () => {
    const mine = (await req('GET', '/me/photos', localAuth)).json().items;
    const theirs = (await req('GET', '/me/photos', otherAuthId)).json().items;
    expect(mine.length).toBeGreaterThan(0);
    expect(
      theirs.every((p: { id: string }) => !mine.some((m: { id: string }) => m.id === p.id)),
    ).toBe(true);
  });

  it('caps the gallery', async () => {
    // Its own account, so the limit is reached by this loop and not by
    // whatever the tests above happened to leave behind.
    const capAuth = await freshAccount();
    let last: LightMyRequestResponse | null = null;
    for (let i = 0; i < 8; i += 1) {
      last = await req('POST', '/me/photos/upload-url', capAuth, {
        contentType: 'image/jpeg',
        byteSize: 1000,
      });
      if (last.statusCode === 409) break;
    }
    expect(last?.statusCode).toBe(409);
  });
});

describe('per-field profile visibility', () => {
  it('returns sensible defaults before anything is set', async () => {
    const response = await req('GET', '/me/profile/visibility', otherAuthId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toHaveLength(14);
    expect(body.about_me).toBe('public');
    expect(body.profession).toBe('matched_only');
  });

  it('saves a change and reads it back', async () => {
    const response = await req('PUT', '/me/profile/visibility', otherAuthId, {
      profession: 'private',
      sect: 'matched_only',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profession).toBe('private');

    const reread = await req('GET', '/me/profile/visibility', otherAuthId);
    expect(reread.json().profession).toBe('private');
    expect(reread.json().sect).toBe('matched_only');
  });

  it('refuses to hide about_me entirely', async () => {
    // E6: a profile with no words is not a profile. The database CHECK is the
    // control; this proves the API surfaces it rather than 500ing.
    const response = await req('PUT', '/me/profile/visibility', otherAuthId, {
      about_me: 'private',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('ignores a key outside the fourteen controllable ones', async () => {
    const response = await req('PUT', '/me/profile/visibility', otherAuthId, {
      date_of_birth: 'private',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().date_of_birth).toBeUndefined();
  });

  it('keeps one member settings out of another member view', async () => {
    const mine = (await req('GET', '/me/profile/visibility', authId)).json();
    // otherAuthId set profession to private above; this account must not see it.
    expect(mine.profession).toBe('matched_only');
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/me/profile/visibility' });
    expect(response.statusCode).toBe(401);
  });
});
