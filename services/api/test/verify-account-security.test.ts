import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountSecurityChecks,
  LIFT_CHECK,
  OWNER_ONLY_CHECK,
  RESTRICTED_CHECK,
} from '../scripts/account-security-checks';
import type { Queryable } from '../scripts/phase1-security-checks';

/**
 * The migration 0032 checks `verify:db` runs: against a correct database, one
 * from before 0032, and databases broken one way at a time.
 */

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

const failures = async (pg: PGlite) => {
  const results = await accountSecurityChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual(
    [OWNER_ONLY_CHECK, RESTRICTED_CHECK, LIFT_CHECK].sort(),
  );
  return results.filter((r) => !r.ok);
};

describe('a database from before 0032', () => {
  it('fails every check, naming the widened read', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261105000031' });
      const failed = await failures(pg);
      expect(failed.map((f) => f.name).sort()).toEqual(
        [OWNER_ONLY_CHECK, RESTRICTED_CHECK, LIFT_CHECK].sort(),
      );
      expect(failed.find((f) => f.name === OWNER_ONLY_CHECK)?.detail).toMatch(
        /profiles_select_visible is not owner-only/,
      );
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
    const failed = await failures(pg);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it.each([
    [
      'a cross-member policy added beside the owner one',
      `create policy leak on public.profiles for select to authenticated using (true)`,
      /leak is not owner-only/,
    ],
    [
      'the old visibility rule restored',
      `create policy leak on public.profiles for select to authenticated
         using (app.profile_visible_to(app.current_user_id(), user_id, review_status))`,
      /leak is not owner-only/,
    ],
    [
      'an owner policy widened with OR',
      `create policy leak on public.photos for select to authenticated
         using (user_id = app.current_user_id() or visibility = 'public')`,
      /photos: leak is not owner-only/,
    ],
    [
      'the variant read dropped altogether',
      `drop policy photo_variants_select_own on public.photo_variants`,
      /photo_variants: no SELECT policy/,
    ],
  ])('owner-only: %s', async (_label, sql, expected) => {
    await whileBroken(sql, OWNER_ONLY_CHECK, expected);
  });

  it.each([
    [
      'the policy dropped from a table',
      `drop policy messages_refuse_restricted_account on public.messages`,
      /messages: no restrictive policy/,
    ],
    [
      'a writable table outside the exemption',
      `drop policy profiles_refuse_restricted_account on public.profiles`,
      /profiles: no restrictive policy/,
    ],
    [
      'a read-exempt table left writable',
      `drop policy users_refuse_restricted_account on public.users`,
      /users: read-exempt but writable/,
    ],
    [
      'a new table a member can read, with no decision about it',
      `create table public.zz_new (id int);
       grant select on public.zz_new to authenticated;`,
      /zz_new: no restrictive policy/,
    ],
  ])('restricted: %s', async (_label, sql, expected) => {
    await whileBroken(sql, RESTRICTED_CHECK, expected);
  });

  it.each([
    [
      'members allowed to run it',
      `grant execute on function app.lift_expired_suspensions(uuid) to authenticated`,
      /authenticated may run/,
    ],
    [
      'the service role unable to run it',
      `revoke execute on function app.lift_expired_suspensions(uuid) from service_role`,
      /service_role cannot run/,
    ],
    ['the function gone', `drop function app.lift_expired_suspensions(uuid)`, /missing/],
  ])('lift: %s', async (_label, sql, expected) => {
    await whileBroken(sql, LIFT_CHECK, expected);
  });
});
