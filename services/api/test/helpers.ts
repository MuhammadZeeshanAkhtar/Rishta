import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import type { Db, DbSession, ServiceRoleUse } from '../src/db/types';
import type { AuthContext, TokenVerifier } from '../src/auth/verify';
import { unauthenticated } from '../src/errors';
import type { StorageClient } from '../src/storage/client';

/**
 * Test harness.
 *
 * The routes run against a real Postgres with the real migrations and the real
 * RLS policies applied. Only two things are substituted: the Postgres driver
 * (PGlite instead of node-postgres) and JWT verification, because minting real
 * Supabase tokens would mean depending on Supabase to run a unit test.
 *
 * Everything else — the policies, the constraints, the triggers, the
 * service-role boundary — is exercised as written.
 */

export interface TestHarness {
  app: FastifyInstance;
  db: Db;
  raw: PGlite;
  serviceUses: ServiceRoleUse[];
  storage: MemoryStorage;
  close(): Promise<void>;
}

/**
 * Supabase Storage, in memory.
 *
 * Substituted for the same reason the Postgres driver is: a unit test should
 * not need a network or a bucket. What it does NOT fake is the route logic
 * around it — paths, ordering, variant generation and the moderation write all
 * run for real, and `objects` can be inspected afterwards to assert that the
 * blurred file was actually produced and stored.
 */
export interface MemoryStorage extends StorageClient {
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Simulates a client having uploaded to a signed target. */
  put(path: string, body: Buffer, contentType?: string): void;
}

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();

  return {
    objects,
    put(path, body, contentType = 'image/jpeg') {
      objects.set(path, { body, contentType });
    },
    async createSignedUploadUrl(_token, path) {
      return { uploadUrl: `https://storage.test/upload/${path}?token=t`, token: 't' };
    },
    async createSignedUrl(_token, path) {
      return objects.has(path) ? `https://storage.test/signed/${path}?token=t` : null;
    },
    async download(_token, path) {
      const object = objects.get(path);
      if (!object) throw new Error(`No object at ${path}`);
      return object.body;
    },
    async upload(_token, path, body, contentType) {
      objects.set(path, { body, contentType });
    },
    async remove(_token, paths) {
      for (const path of paths) objects.delete(path);
    },
  };
}

const TEST_CONFIG: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: (process.env.TEST_LOG_LEVEL as Config['LOG_LEVEL']) ?? 'fatal',
  DATABASE_URL: 'postgres://unused-in-tests',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_JWT_SECRET: undefined,
  SUPABASE_JWKS_URL: undefined,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SENTRY_DSN: undefined,
  RATE_LIMIT_PER_MINUTE: 10_000,
  CORS_ALLOWED_ORIGINS: undefined,
  jwksUrl: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
};

/**
 * Accepts a token of the form `test:<authUserId>`.
 *
 * Verification itself is tested separately against the real implementation;
 * here the point is what the routes do once a subject is established.
 */
export const testVerifier: TokenVerifier = {
  async verify(token: string): Promise<AuthContext> {
    const match = /^test:([0-9a-fA-F-]{36})(?::(.*))?$/.exec(token);
    if (!match) throw unauthenticated('Invalid or expired token');
    return {
      authUserId: match[1]!,
      email: match[2] || undefined,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  },
};

export function authHeader(authUserId: string, email?: string): Record<string, string> {
  return { authorization: `Bearer test:${authUserId}${email ? `:${email}` : ''}` };
}

function createPgliteDb(pg: PGlite, serviceUses: ServiceRoleUse[]): Db {
  /**
   * Mirrors createPgDb: a transaction per call with `SET LOCAL`, so a role
   * cannot leak between requests. PGlite is single-connection, so these are
   * naturally serial.
   */
  async function run<T>(setup: string[], fn: (s: DbSession) => Promise<T>): Promise<T> {
    await pg.exec('begin');
    try {
      for (const statement of setup) {
        await pg.exec(statement);
      }
      const session: DbSession = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
          const result = await pg.query<R>(sql, params);
          return result.rows;
        },
      };
      const value = await fn(session);
      await pg.exec('commit');
      return value;
    } catch (error) {
      await pg.exec('rollback').catch(() => undefined);
      throw error;
    }
  }

  return {
    asUser(authUserId, fn) {
      const claims = JSON.stringify({ sub: authUserId, role: 'authenticated' });
      return run(
        [
          `select set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', true)`,
          'set local role authenticated',
        ],
        fn,
      );
    },

    asAnon(fn) {
      return run(
        [`select set_config('request.jwt.claims', '{"role":"anon"}', true)`, 'set local role anon'],
        fn,
      );
    },

    asService(use, fn) {
      serviceUses.push(use);
      return run(['set local role service_role'], fn);
    },

    async close() {
      await pg.close();
    },
  };
}

export async function createHarness(): Promise<TestHarness> {
  const pg = new PGlite();
  await applyMigrations(pg);

  const serviceUses: ServiceRoleUse[] = [];
  const db = createPgliteDb(pg, serviceUses);
  const storage = createMemoryStorage();
  const app = await buildApp({ config: TEST_CONFIG, db, verifier: testVerifier, storage });
  await app.ready();

  return {
    app,
    db,
    raw: pg,
    serviceUses,
    storage,
    async close() {
      await app.close();
      await pg.close();
    },
  };
}

/** Seeds the reference rows the identity tables depend on. */
export async function seedReferenceData(pg: PGlite): Promise<void> {
  await pg.exec(`
    insert into public.reference_items (type, code, sort_order) values
      ('country', 'pk', 1),
      ('country', 'gb', 2),
      ('education_level', 'edu_bachelors', 1),
      ('education_level', 'edu_masters', 2)
    on conflict (type, code) do nothing;
  `);

  const items = await pg.query<{ id: string; code: string }>(
    `select id, code from public.reference_items where type = 'education_level'`,
  );
  for (const item of items.rows) {
    await pg.query(
      `insert into public.reference_translations (reference_item_id, locale, label)
       values ($1, 'en', $2)
       on conflict do nothing`,
      [item.id, item.code === 'edu_bachelors' ? 'Bachelor degree' : 'Master degree'],
    );
  }
}

export const randomAuthId = (): string => crypto.randomUUID();
