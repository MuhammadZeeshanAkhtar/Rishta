import { badRequest, internalError } from '../errors';

/**
 * Supabase Storage, called with the CALLER'S OWN token.
 *
 * This is the design decision that matters in this file. The obvious way to
 * sign URLs is a service-role key — and this service must not hold one:
 * `config.ts` refuses to boot if `SUPABASE_SERVICE_ROLE_KEY` is present, and
 * README §9.3 makes the reason explicit. A key that bypasses RLS turns every
 * bug in a route handler into a data breach.
 *
 * So instead of acting as an administrator, the API acts *as the member*: it
 * forwards their verified JWT to Storage, and the bucket's RLS policies decide
 * what happens. A member can only touch objects whose first path segment is
 * their own `users.id` — the same rule, enforced in the same place, whether
 * the request arrives from this API or from the app's own SDK.
 *
 * The practical consequence to be aware of: this API cannot issue a signed URL
 * for someone else's photo. That is correct for Phase 4, where everything is
 * owner-scoped. The cross-user reveal flow needs a different mechanism and is
 * deliberately out of scope.
 */

export const PHOTO_BUCKET = 'photos';

/** Short, because a signed URL is a bearer token for an image. */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Long enough for a slow upload on a poor connection, short enough to expire. */
export const UPLOAD_URL_TTL_SECONDS = 900;

export interface StorageClient {
  /** A one-shot upload target for `path`, scoped to the caller by RLS. */
  createSignedUploadUrl(
    accessToken: string,
    path: string,
  ): Promise<{ uploadUrl: string; token: string }>;

  /** A short-lived read URL, or null when the object is not readable. */
  createSignedUrl(accessToken: string, path: string): Promise<string | null>;

  download(accessToken: string, path: string): Promise<Buffer>;

  upload(accessToken: string, path: string, body: Buffer, contentType: string): Promise<void>;

  remove(accessToken: string, paths: string[]): Promise<void>;
}

export interface StorageClientOptions {
  supabaseUrl: string;
  /** Sent as `apikey`. Public by design — it identifies the project only. */
  publishableKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createStorageClient(options: StorageClientOptions): StorageClient {
  const base = `${options.supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call(
    accessToken: string,
    path: string,
    init: RequestInit & { method: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          // The caller's identity, not ours. RLS evaluates against this.
          Authorization: `Bearer ${accessToken}`,
          apikey: options.publishableKey,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Storage returns its errors as JSON; never surface them verbatim. */
  async function fail(response: Response, what: string): Promise<never> {
    const detail = await response.text().catch(() => '');
    if (response.status === 400 || response.status === 409) {
      throw badRequest(`Storage rejected the ${what}`);
    }
    // 401/403 here means RLS refused — which, given the token is the caller's
    // own, means a path outside their folder. That is a bug in our path
    // construction, not something the caller can fix, so it is a 500.
    throw internalError(`Storage ${what} failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  return {
    async createSignedUploadUrl(accessToken, path) {
      const response = await call(accessToken, `/object/upload/sign/${PHOTO_BUCKET}/${path}`, {
        method: 'POST',
      });
      if (!response.ok) await fail(response, 'upload signature');

      const body = (await response.json()) as { url?: string };
      if (!body.url) throw internalError('Storage returned no upload URL');

      // The response gives a relative path with the token in the query.
      const url = body.url.startsWith('http') ? body.url : `${base}${body.url}`;
      const token = new URL(url).searchParams.get('token') ?? '';
      return { uploadUrl: url, token };
    },

    async createSignedUrl(accessToken, path) {
      const response = await call(accessToken, `/object/sign/${PHOTO_BUCKET}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      });
      // A missing object is not an error: a photo can exist as a row before
      // its variants have been generated.
      if (response.status === 404 || response.status === 400) return null;
      if (!response.ok) await fail(response, 'signature');

      const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
      const signed = body.signedURL ?? body.signedUrl;
      return signed ? (signed.startsWith('http') ? signed : `${base}${signed}`) : null;
    },

    async download(accessToken, path) {
      const response = await call(accessToken, `/object/${PHOTO_BUCKET}/${path}`, {
        method: 'GET',
      });
      if (!response.ok) await fail(response, 'download');
      return Buffer.from(await response.arrayBuffer());
    },

    async upload(accessToken, path, body, contentType) {
      const response = await call(accessToken, `/object/${PHOTO_BUCKET}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: new Uint8Array(body),
      });
      if (!response.ok) await fail(response, 'upload');
    },

    async remove(accessToken, paths) {
      if (paths.length === 0) return;
      const response = await call(accessToken, `/object/${PHOTO_BUCKET}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      // A delete that fails leaves an orphaned object, which the retention
      // sweep will collect. It must not fail the member's request.
      if (!response.ok && response.status !== 404) {
        await response.text().catch(() => '');
      }
    },
  };
}
