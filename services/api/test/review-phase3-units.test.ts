import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { decodeKeyset, encodeKeyset } from '../src/http/cursor';
import { isUuid } from '../src/http/params';
import { mapDatabaseError, problemCodeForStatus } from '../src/http/problems';
import { createStorageClient } from '../src/storage/client';
import { TASKS } from '../scripts/maintenance';

/**
 * Code review remediation, Phase 3 — the pure pieces, without a database.
 */

describe('B14 — database errors the caller caused become 4xx', () => {
  it.each([
    ['22P02', 400, 'validation_failed'],
    ['23514', 400, 'validation_failed'],
    ['23505', 409, 'conflict'],
    ['42501', 403, 'forbidden'],
  ])('%s -> %i %s', (code, status, problem) => {
    const mapped = mapDatabaseError({ code, message: 'internal postgres text' });
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped!.status).toBe(status);
    expect(mapped!.code).toBe(problem);
    // The Postgres text never reaches the client.
    expect(mapped!.message).not.toContain('postgres');
  });

  it('leaves anything else to the 500 path: unknown SQLSTATEs and non-database errors', () => {
    expect(mapDatabaseError({ code: '53300' })).toBeNull();
    expect(mapDatabaseError({ code: 'FST_ERR_CTP_INVALID_JSON_BODY' })).toBeNull();
    expect(mapDatabaseError(new Error('boom'))).toBeNull();
    expect(mapDatabaseError(null)).toBeNull();
  });
});

describe('B14 — uuid path parameters', () => {
  it.each([
    ['3f1c2a4e-9b7d-4c1e-8a2f-6d5e4c3b2a10', true],
    ['3F1C2A4E-9B7D-4C1E-8A2F-6D5E4C3B2A10', true],
    ['00000000-0000-0000-0000-000000000000', true],
    ['------------------------------------', false],
    ['3f1c2a4e9b7d4c1e8a2f6d5e4c3b2a10', false],
    ['not-a-uuid', false],
    ['', false],
    [undefined, false],
  ])('isUuid(%s) = %s', (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});

describe('B21 — Fastify 4xx codes', () => {
  it.each([
    [413, undefined, 'payload_too_large'],
    [415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE', 'unsupported_media_type'],
    [400, 'FST_ERR_CTP_INVALID_JSON_BODY', 'malformed_request'],
    [400, 'FST_ERR_CTP_EMPTY_JSON_BODY', 'malformed_request'],
    [400, 'FST_ERR_VALIDATION', 'validation_failed'],
    [404, undefined, 'not_found'],
    [401, undefined, 'unauthenticated'],
  ] as const)('%i %s -> %s', (status, fastifyCode, problem) => {
    expect(problemCodeForStatus(status, fastifyCode)).toBe(problem);
  });
});

describe('B15 — a Storage failure does not reach the client', () => {
  it('keeps the upstream text out of the message and in the cause', async () => {
    const storage = createStorageClient({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetchImpl: (async () =>
        new Response('{"error":"bucket policy ploy_7 refused path u/abc/original.jpg"}', {
          status: 500,
        })) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await storage.createSignedUploadUrl('token', 'u/abc/original.jpg');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(500);
    expect(JSON.stringify(err.toBody())).not.toMatch(/bucket|ploy_7|original\.jpg/);
    expect(JSON.stringify(err.cause)).toContain('ploy_7');
  });
});

describe('B10 — keyset cursors', () => {
  it('round-trips, and refuses anything that is not one', () => {
    const keyset = {
      at: '2026-11-02T10:15:30.123456Z',
      id: '3f1c2a4e-9b7d-4c1e-8a2f-6d5e4c3b2a10',
    };
    expect(decodeKeyset(encodeKeyset(keyset))).toEqual(keyset);
    expect(decodeKeyset(undefined)).toBeNull();
    expect(decodeKeyset('garbage')).toBeNull();
    expect(decodeKeyset(Buffer.from('r:5').toString('base64url'))).toBeNull();
    expect(decodeKeyset(Buffer.from('k:yesterday|x').toString('base64url'))).toBeNull();
  });
});

describe('B26 — the maintenance script runs the retention function', () => {
  it('lists the notification purge', () => {
    expect(TASKS.map((t) => t.apply)).toContain('select app.purge_expired_notifications() as n');
  });
});
