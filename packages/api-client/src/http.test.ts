import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http';
import { NikahMateError } from './errors';

/**
 * The transport's job is to be boring and predictable: attach a fresh token,
 * turn every failure into a known kind, and never hand a screen a raw body.
 */

function client(fetchImpl: typeof fetch, token: string | null = 'token-123'): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.test/v1',
    getAccessToken: async () => token,
    fetchImpl,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('HttpClient', () => {
  it('sends a bearer token and parses the body', async () => {
    const fetchImpl = vi.fn(async () => json(200, { userId: 'u1' }));
    const result = await client(fetchImpl as unknown as typeof fetch).get<{ userId: string }>(
      '/me',
    );

    expect(result).toEqual({ userId: 'u1' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  it('resolves the token per request, never caching a stale one', async () => {
    // A token read once at start-up is expired by the time someone reopens the
    // app an hour later; this is the bug that produces random sign-outs.
    let current = 'first';
    const fetchImpl = vi.fn(async () => json(200, {}));
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      getAccessToken: async () => current,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await http.get('/a');
    current = 'second';
    await http.get('/b');

    const headerOf = (i: number) =>
      (
        (fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<
          string,
          string
        >
      ).Authorization;
    expect(headerOf(0)).toBe('Bearer first');
    expect(headerOf(1)).toBe('Bearer second');
  });

  it('omits the token for anonymous endpoints', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [] }));
    await client(fetchImpl as unknown as typeof fetch).get('/reference/country', {
      anonymous: true,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('fails fast when a protected call has no token', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await expect(client(fetchImpl as unknown as typeof fetch, null).get('/me')).rejects.toThrow(
      NikahMateError,
    );
    // Never sent: a 401 round trip would look like a backend fault.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps status codes to kinds', async () => {
    const cases: Array<[number, string]> = [
      [400, 'validation_failed'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [429, 'rate_limited'],
      [500, 'server'],
      [502, 'server'],
    ];
    for (const [status, kind] of cases) {
      const fetchImpl = vi.fn(async () => json(status, { code: 'x', message: 'raw detail' }));
      await expect(client(fetchImpl as unknown as typeof fetch).get('/me')).rejects.toMatchObject({
        kind,
      });
    }
  });

  it('surfaces field errors so a form can mark the right input', async () => {
    const fetchImpl = vi.fn(async () =>
      json(400, { code: 'validation_failed', fields: { email: 'Already in use' } }),
    );
    await expect(
      client(fetchImpl as unknown as typeof fetch).post('/account/bootstrap', {}),
    ).rejects.toMatchObject({ fields: { email: 'Already in use' } });
  });

  it('reads Retry-After so the UI can say how long', async () => {
    const fetchImpl = vi.fn(async () =>
      json(429, { code: 'rate_limited' }, { 'Retry-After': '45' }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch).get('/me')).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 45,
    });
  });

  it('treats a thrown fetch as a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(client(fetchImpl as unknown as typeof fetch).get('/me')).rejects.toMatchObject({
      kind: 'network',
      isRetryable: true,
    });
  });

  it('handles 204 with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).delete('/me/devices/1'),
    ).resolves.toBeUndefined();
  });

  it('does not choke on a non-JSON error body', async () => {
    // A proxy or gateway returns HTML. That must still become a clean kind.
    const fetchImpl = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch).get('/me')).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('builds query strings and drops undefined values', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await client(fetchImpl as unknown as typeof fetch).get('/reference/country', {
      anonymous: true,
      query: { locale: 'en', parentCode: undefined },
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('locale=en');
    expect(url).not.toContain('parentCode');
  });
});
