import { describe, expect, it, vi } from 'vitest';
import { NikahMateClient } from './client';
import { NikahMateError } from './errors';

/**
 * Review Phase 5 client methods: others' photos and photo requests (L3), DOB
 * corrections (B6), the staff surface (L1) and the second-factor helpers.
 *
 * The point of these tests is the boundary: the right path, query and body go
 * out; a response of the wrong shape is refused rather than handed to a
 * screen; and the API's 403/404 arrive as the kinds the admin screens route
 * on. Authorisation itself is the API's, tested in services/api.
 */

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
};

const UUID = '7a1d5c9e-3b1f-4c8a-9d2e-1f0a2b3c4d5e';
const OTHER = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const NOW = '2026-11-05T10:00:00.000Z';

interface Sent {
  method: string;
  url: URL;
  body: unknown;
}

function clientWith(responses: Array<{ status: number; body?: unknown }>): {
  client: NikahMateClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? 'GET',
      url: new URL(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new NikahMateClient({
    supabaseUrl: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    storage: memoryStorage(),
    apiBaseUrl: 'https://api.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  // No real session: the token is irrelevant to what these tests check.
  client.auth.getAccessToken = async () => 'token';
  return { client, sent };
}

const card = {
  userId: UUID,
  displayName: 'Aisha',
  age: 27,
  countryCode: 'pk',
  cityName: null,
  distanceBand: null,
  primaryPhoto: null,
  compatibilityScore: null,
  topReasons: [],
  verification: { badges: [] },
  isShortlisted: false,
};

describe('L3 photos', () => {
  it('reads another member’s photos and refuses a malformed response', async () => {
    const good = {
      items: [{ id: UUID, variant: 'blurred', url: null, expiresAt: null, requiresRequest: true }],
      request: { id: OTHER, status: 'pending', createdAt: NOW, respondedAt: null },
      granted: false,
    };
    const { client, sent } = clientWith([
      { status: 200, body: good },
      { status: 200, body: { items: [] } },
    ]);
    expect(await client.getProfilePhotos(UUID)).toEqual(good);
    expect(sent[0]!.url.pathname).toBe(`/profiles/${UUID}/photos`);
    await expect(client.getProfilePhotos(UUID)).rejects.toMatchObject({ kind: 'server' });
  });

  it('sends a request with an optional message, validated before it leaves', async () => {
    const request = {
      id: OTHER,
      direction: 'outgoing',
      counterpart: card,
      status: 'pending',
      message: null,
      createdAt: NOW,
      respondedAt: null,
    };
    const { client, sent } = clientWith([
      { status: 201, body: request },
      { status: 201, body: request },
    ]);
    await client.requestPhotos(UUID);
    await client.requestPhotos(UUID, 'Assalamu alaikum');
    expect(sent.map((s) => [s.method, s.url.pathname, s.body])).toEqual([
      ['POST', `/profiles/${UUID}/photo-request`, {}],
      ['POST', `/profiles/${UUID}/photo-request`, { message: 'Assalamu alaikum' }],
    ]);
    await expect(client.requestPhotos(UUID, 'x'.repeat(301))).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('lists with filters and responds with a decision', async () => {
    const page = { items: [], nextCursor: null, hasMore: false };
    const answered = {
      id: OTHER,
      direction: 'incoming',
      counterpart: card,
      status: 'approved',
      message: null,
      createdAt: NOW,
      respondedAt: NOW,
    };
    const { client, sent } = clientWith([
      { status: 200, body: page },
      { status: 200, body: answered },
    ]);
    await client.listPhotoRequests({ direction: 'incoming', status: 'pending', limit: 10 });
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      direction: 'incoming',
      status: 'pending',
      limit: '10',
    });
    expect((await client.respondToPhotoRequest(OTHER, 'approve')).status).toBe('approved');
    expect(sent[1]!.body).toEqual({ decision: 'approve' });
  });
});

describe('B6 date-of-birth corrections', () => {
  it('files a request and refuses a short reason before sending', async () => {
    const { client, sent } = clientWith([
      {
        status: 201,
        body: { requestId: UUID, status: 'pending', requestedDob: '1994-03-02', createdAt: NOW },
      },
      {
        status: 200,
        body: {
          items: [
            {
              requestId: UUID,
              status: 'rejected',
              requestedDob: '1994-03-02',
              decisionNote: 'The document did not match.',
              decidedAt: NOW,
              createdAt: NOW,
            },
          ],
        },
      },
    ]);
    await client.requestDobCorrection({
      requestedDob: '1994-03-02',
      reason: 'Wrong year at sign-up.',
    });
    expect(sent[0]!.body).toEqual({ requestedDob: '1994-03-02', reason: 'Wrong year at sign-up.' });
    await expect(
      client.requestDobCorrection({ requestedDob: '1994-03-02', reason: 'short' }),
    ).rejects.toThrow();
    const list = await client.listDobCorrections();
    expect(list.items[0]!.decisionNote).toBe('The document did not match.');
    expect(sent).toHaveLength(2);
  });
});

describe('L1 staff surface', () => {
  it('maps "not staff" and "second factor or role missing" to the kinds the screens route on', async () => {
    const { client } = clientWith([
      { status: 404, body: { code: 'not_found', message: 'Not found' } },
      {
        status: 403,
        body: { code: 'forbidden', message: 'Two-factor authentication is required for staff' },
      },
      { status: 401, body: { code: 'unauthenticated', message: 'expired' } },
    ]);
    await expect(client.getAdminSession()).rejects.toMatchObject({ kind: 'not_found' });
    await expect(client.getAdminSession()).rejects.toMatchObject({ kind: 'forbidden' });
    const expired = await client.getAdminSession().catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(NikahMateError);
    expect((expired as NikahMateError).kind).toBe('unauthenticated');
  });

  it('sends decisions with their reasons and refuses an unknown decision locally', async () => {
    const { client, sent } = clientWith([
      { status: 200, body: { photoId: UUID, moderationStatus: 'rejected' } },
    ]);
    await client.decidePhoto(UUID, {
      decision: 'reject',
      reasonKey: 'errors.photoRejected',
      note: 'Not a person.',
    });
    expect(sent[0]!.body).toEqual({
      decision: 'reject',
      reasonKey: 'errors.photoRejected',
      note: 'Not a person.',
    });
    await expect(
      client.decidePhoto(UUID, { decision: 'maybe' as 'approve', note: 'x' }),
    ).rejects.toThrow();
    await expect(client.actOnUser(UUID, { action: 'ban', reason: '   ' })).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('reads the audit trail with its filters', async () => {
    const { client, sent } = clientWith([
      {
        status: 200,
        body: {
          items: [
            {
              id: OTHER,
              action: 'user.suspend',
              targetType: 'user',
              targetId: UUID,
              reason: 'Abusive messages',
              metadata: {},
              createdAt: NOW,
              actor: { adminUserId: OTHER, displayName: 'Moderator' },
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      },
    ]);
    const page = await client.listAudit({ targetType: 'user', targetId: UUID, limit: 5 });
    expect(page.items[0]!.reason).toBe('Abusive messages');
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      targetType: 'user',
      targetId: UUID,
      limit: '5',
    });
  });
});

describe('second factor helpers', () => {
  it('reports assurance and maps a wrong code to invalid_credentials', async () => {
    const { client } = clientWith([]);
    const auth = client.auth as unknown as {
      supabase: { auth: { mfa: Record<string, unknown> } };
    };
    auth.supabase.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });
    auth.supabase.auth.mfa.challengeAndVerify = async () => ({
      data: null,
      error: { code: 'mfa_verification_failed', status: 422, message: 'Invalid TOTP code entered' },
    });
    expect(await client.auth.getAssurance()).toEqual({ current: 'aal1', next: 'aal2' });
    await expect(client.auth.verifyTotp(UUID, '000000')).rejects.toMatchObject({
      kind: 'invalid_credentials',
    });
  });
});
