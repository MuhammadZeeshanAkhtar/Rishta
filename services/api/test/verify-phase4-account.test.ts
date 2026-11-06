import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../scripts/phase1-security-checks';
import { phase4AccountChecks } from '../scripts/phase4-account-checks';

/**
 * The Phase 4 checks `verify:db` runs (migration 0030), against a correct
 * database, one from before 0030, and databases broken one way at a time.
 */

const TRIGGER = 'L10 trigger notifications_respect_preferences';
const RESTRICTED =
  'L10 no member privilege on push_tokens, profile_views, account_deletion_requests';
const PREFS = 'L10 notification_preferences RLS enabled and forced, owner-only policies';
const MAINT = 'L11 retention and expiry functions are service-role only';
const ALL = [TRIGGER, RESTRICTED, PREFS, MAINT];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

async function failures(pg: PGlite): Promise<{ names: string[]; detail: string }> {
  const results = await phase4AccountChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  const failed = results.filter((r) => !r.ok);
  return {
    names: failed.map((r) => r.name).sort(),
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join('\n'),
  };
}

describe('a correctly migrated database', () => {
  it('passes every Phase 4 check', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([]);
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database from before 0030', () => {
  it('fails every Phase 4 check', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261102000029' });
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([...ALL].sort());
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database broken in one way at a time', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
  }, 180_000);
  afterAll(async () => pg?.close());

  async function brokenBy(breakage: string): Promise<{ names: string[]; detail: string }> {
    await pg.exec('begin');
    try {
      await pg.exec(breakage);
      return await failures(pg);
    } finally {
      await pg.exec('rollback');
    }
  }

  it.each([
    [TRIGGER, 'missing', `drop trigger notifications_respect_preferences on public.notifications`],
    [
      TRIGGER,
      'disabled',
      `alter table public.notifications disable trigger notifications_respect_preferences`,
    ],
    [
      TRIGGER,
      'neutered',
      `create or replace function app.respect_notification_preferences() returns trigger
         language plpgsql security definer set search_path = public, pg_temp as $$ begin return new; end; $$`,
    ],
    [
      RESTRICTED,
      'a member granted SELECT on push_tokens',
      `grant select on public.push_tokens to authenticated`,
    ],
    [
      RESTRICTED,
      'anon granted INSERT on profile_views',
      `grant insert on public.profile_views to anon`,
    ],
    [RESTRICTED, 'a restricted table dropped', `drop table public.account_deletion_requests`],
    [
      PREFS,
      'RLS no longer forced',
      `alter table public.notification_preferences no force row level security`,
    ],
    [
      PREFS,
      'a policy open to every member',
      `create policy notification_preferences_everyone on public.notification_preferences
         for select to authenticated using (true)`,
    ],
    [
      MAINT,
      'members allowed to expire invitations',
      `grant execute on function app.expire_family_invitations() to authenticated`,
    ],
    [MAINT, 'a function dropped', `drop function app.purge_expired_profile_views()`],
  ])('%s fails when %s', async (check, _how, breakage) => {
    const { names, detail } = await brokenBy(breakage);
    expect(names, detail).toEqual([check]);
  });
});
