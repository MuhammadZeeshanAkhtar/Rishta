import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_LOG_CHECK,
  API_ROLE_CHECK,
  dataApiChecks,
  NO_DIRECT_ACCESS_CHECK,
} from '../scripts/data-api-checks';
import type { Queryable } from '../scripts/phase1-security-checks';

/**
 * The Stage 2 checks `verify:db` runs: against a correct database, one stopped
 * between the two migrations, one from before them, and databases broken one way
 * at a time.
 */

const ALL = [NO_DIRECT_ACCESS_CHECK, API_ROLE_CHECK, ACCESS_LOG_CHECK];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

const failures = async (pg: PGlite) => {
  const results = await dataApiChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  return results.filter((r) => !r.ok);
};

describe('a database from before 0033', () => {
  it('fails all three, saying what to apply', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261106000032' });
      const failed = await failures(pg);
      expect(failed.map((f) => f.name).sort()).toEqual([...ALL].sort());
      expect(failed.find((f) => f.name === API_ROLE_CHECK)?.detail).toMatch(/apply 0033/);
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database between 0033 and 0034', () => {
  it('fails only the direct-access check, naming what is still open', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261106000033' });
      const failed = await failures(pg);
      expect(failed.map((f) => f.name)).toEqual([NO_DIRECT_ACCESS_CHECK]);
      expect(failed[0]!.detail).toMatch(/SELECT on profiles/);
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a correctly migrated database', () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    await pg.exec(`
      create role authenticator noinherit;
      grant anon, authenticated, service_role to authenticator;
    `);
  }, 180_000);

  afterAll(async () => {
    await pg?.close();
  });

  const whileBroken = async (change: string, name: string, expected: RegExp) => {
    await pg.exec('begin');
    try {
      await pg.exec(change);
      const failed = await failures(pg);
      expect(failed.map((f) => f.name)).toEqual([name]);
      expect(failed[0]!.detail).toMatch(expected);
    } finally {
      await pg.exec('rollback');
    }
  };

  it('passes every check', async () => {
    expect((await failures(pg)).map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it.each([
    [
      'an app function open to anon again',
      `grant execute on function app.lift_expired_suspensions(uuid) to anon`,
      /anon may run app\.lift_expired_suspensions/,
    ],
    [
      'a table-level read handed back',
      `grant select on public.profiles to authenticated`,
      /SELECT on profiles/,
    ],
    [
      'a table-level write handed back',
      `grant update on public.users to authenticated`,
      /UPDATE on users/,
    ],
    [
      'one column of a write handed back',
      `grant update (about_me) on public.profiles to authenticated`,
      /UPDATE on profiles\.about_me/,
    ],
    [
      'a message body readable again',
      `grant select (body) on public.messages to authenticated`,
      /SELECT on messages\.body/,
    ],
    [
      'a grant to PUBLIC, which reaches everyone',
      `grant select on public.blocks to public`,
      /SELECT on blocks/,
    ],
    [
      'Realtime broken by removing what it needs',
      `revoke select (conversation_id) on public.messages from authenticated`,
      /Realtime needs SELECT on messages\.conversation_id/,
    ],
  ])('direct access: %s', async (_label, sql, expected) => {
    await whileBroken(sql, NO_DIRECT_ACCESS_CHECK, expected);
  });

  it.each([
    [
      'PostgREST able to become the API role',
      `grant api_member to authenticator`,
      /authenticator can become api_member/,
    ],
    ['the service role able to', `grant api_member to service_role`, /service_role can become/],
    ['it can log in', `alter role api_member login`, /can log in/],
    ['it skips RLS', `alter role api_member bypassrls`, /bypasses RLS/],
    [
      'it no longer inherits the policies',
      `revoke authenticated from api_member`,
      /does not inherit/,
    ],
    [
      'it lost what the API needs',
      `revoke select on public.profiles from api_member`,
      /lacks the privileges/,
    ],
  ])('API role: %s', async (_label, sql, expected) => {
    await whileBroken(sql, API_ROLE_CHECK, expected);
  });

  it.each([
    ['members can read it', `grant select on public.pii_access_log to api_member`, /holds SELECT/],
    ['members can forge it', `grant insert on public.pii_access_log to api_member`, /holds INSERT/],
    [
      'a policy on it',
      `create policy p on public.pii_access_log for select to authenticated using (true)`,
      /has a policy/,
    ],
    [
      'the record can be edited',
      `drop trigger pii_access_log_append_only on public.pii_access_log`,
      /append-only trigger/,
    ],
    [
      'RLS not forced',
      `alter table public.pii_access_log no force row level security`,
      /not enabled and forced/,
    ],
  ])('access log: %s', async (_label, sql, expected) => {
    await whileBroken(sql, ACCESS_LOG_CHECK, expected);
  });
});
