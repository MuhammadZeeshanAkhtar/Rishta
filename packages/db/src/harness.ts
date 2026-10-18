import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', '..', 'supabase', 'migrations');

/**
 * Emulates the parts of Supabase that migrations depend on.
 *
 * In a real Supabase project the `auth` schema and `auth.uid()` already exist.
 * A plain Postgres — PGlite here, a service container in CI — does not have
 * them, so we create the same surface. Keeping the shim in the test harness
 * rather than in a migration means production never carries a fake auth.uid().
 *
 * The implementation matches Supabase's: read the JWT subject out of the
 * `request.jwt.claims` GUC, which PostgREST sets per request and which a test
 * sets with `set local`.
 *
 * It also reproduces the platform's roles and its automatic grants on `public`.
 * Those are what make a table reachable through the Data API, so a suite that
 * leaves them out tests a stricter database than the one that ships.
 */
export const SUPABASE_SHIM = `
  create schema if not exists auth;

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(
      coalesce(
        current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
        current_setting('request.jwt.claim.sub', true)
      ),
      ''
    )::uuid
  $$;

  create or replace function auth.role()
  returns text
  language sql
  stable
  as $$
    select coalesce(
      current_setting('request.jwt.claims', true)::jsonb ->> 'role',
      current_setting('request.jwt.claim.role', true),
      'anon'
    )
  $$;

  grant usage on schema auth to public;

  -- Supabase's API roles exist before any migration runs. Migration 0001 guards
  -- its own role creation, so on a real project it is a no-op — as it is here.
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin noinherit bypassrls;
    end if;
  end
  $$;

  -- The platform's automatic grants on public. On existing Supabase projects
  -- every new table in public is readable and writable by anon and
  -- authenticated the moment it is created, and the Data API exposes it
  -- (supabase.com/docs/guides/database/hardening-data-api). Newer projects are
  -- moving to opt-in, so a given project may or may not have these.
  --
  -- Emulating the worst case is the point. Without this, every "permission
  -- denied" assertion in the suite passes because PGlite grants nothing — and
  -- would silently become "RLS returned zero rows" on a real project.
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
`;

export type Actor = 'anon' | 'authenticated' | 'service_role';

export interface TestDb {
  /** Run SQL as the given role, with the given JWT subject. */
  as<T = Record<string, unknown>>(
    actor: Actor,
    authUserId: string | null,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run SQL with full privileges — for arranging fixtures, never for assertions. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Applies the shim, then every migration in filename order, to a fresh
 * in-memory Postgres.
 *
 * Migrations run exactly as written — no test-only edits. A migration that
 * cannot apply here is a migration that will not apply in production.
 */
export interface SqlRunner {
  exec(sql: string): Promise<unknown>;
}

/**
 * Applies the Supabase shim and every migration, in filename order.
 *
 * Exported so the API test suite reuses exactly this — one definition of "set
 * up a database", rather than a second copy that can drift.
 */
export async function applyMigrations(db: SqlRunner): Promise<void> {
  await db.exec(SUPABASE_SHIM);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await applyMigrations(db);

  return {
    async as<T = Record<string, unknown>>(
      actor: Actor,
      authUserId: string | null,
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      // A transaction so `set local` is scoped and cannot leak into the next
      // assertion — a leaked role is the kind of thing that makes an RLS suite
      // pass for the wrong reason.
      await db.exec('begin');
      try {
        const claims = JSON.stringify({ sub: authUserId, role: actor });
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await db.exec(`set local role ${actor}`);
        const result = await db.query<T>(sql, params);
        return result.rows;
      } finally {
        await db.exec('rollback');
      }
    },

    async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },

    async close() {
      await db.close();
    },
  };
}

/** Seeds the minimum reference data the identity tables require. */
export async function seedReference(db: TestDb): Promise<void> {
  await db.admin(`
    insert into public.reference_items (type, code, sort_order)
    values ('country', 'pk', 1), ('country', 'gb', 2), ('country', 'ca', 3)
    on conflict (type, code) do nothing
  `);
}

export interface SeededUser {
  userId: string;
  authUserId: string;
}

/** Creates a user with an auth link, settings and verification row. */
export async function seedUser(
  db: TestDb,
  overrides: { displayName?: string; gender?: 'male' | 'female'; status?: string } = {},
): Promise<SeededUser> {
  const rows = await db.admin<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1, $2, date '1995-06-15', 'pk', $3)
     returning id`,
    [
      overrides.displayName ?? 'Test User',
      overrides.gender ?? 'female',
      overrides.status ?? 'active',
    ],
  );
  const userId = rows[0]!.id;

  const authRows = await db.admin<{ auth_user_id: string }>(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1, gen_random_uuid(), 'email')
     returning auth_user_id`,
    [userId],
  );

  await db.admin(`insert into public.user_settings (user_id) values ($1)`, [userId]);
  await db.admin(`insert into public.verification_status (user_id) values ($1)`, [userId]);

  return { userId, authUserId: authRows[0]!.auth_user_id };
}
