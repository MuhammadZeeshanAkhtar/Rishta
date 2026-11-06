import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../scripts/phase1-security-checks';
import { phase3ModerationChecks } from '../scripts/phase3-moderation-checks';

/**
 * The Phase 3 checks `verify:db` runs (migration 0029), against a correct
 * database, one from before 0029, and databases broken one way at a time.
 */

const DOB = 'B6 trigger users_dob_locked';
const EDIT = 'B6 trigger profiles_rereview_on_edit';
const RENAME = 'B6 trigger users_rereview_on_name_change';
const SNAPSHOT = 'B6 trigger dob_correction_requests_snapshot';
const AUDIT = 'L1 trigger admin_action_audit_append_only';
const PRIMARY = 'B13 photos_primary_approved';
const INVOKER = 'B6 rename re-review runs with the caller’s rights';
const ADMIN = 'L1 no member privilege on admin tables';
const MFA = 'L1 app.is_active_moderator requires aal2 when MFA is required';
const PURGE = 'B26 app.purge_expired_notifications is service-role only';
const ALL = [DOB, EDIT, RENAME, SNAPSHOT, AUDIT, PRIMARY, INVOKER, ADMIN, MFA, PURGE];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

async function failures(pg: PGlite): Promise<{ names: string[]; detail: string }> {
  const results = await phase3ModerationChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  const failed = results.filter((r) => !r.ok);
  return {
    names: failed.map((r) => r.name).sort(),
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join('\n'),
  };
}

describe('a correctly migrated database', () => {
  it('passes every Phase 3 check', async () => {
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

describe('a database from before 0029', () => {
  it('fails every Phase 3 check except the one that holds vacuously', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261101000028' });
      const { names, detail } = await failures(pg);
      // With no admin tables there is nothing a member can reach: that check
      // passes by absence, which is the honest answer.
      expect(names, detail).toEqual(ALL.filter((n) => n !== ADMIN).sort());
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
    [DOB, 'missing', `drop trigger users_dob_locked on public.users`],
    [DOB, 'disabled', `alter table public.users disable trigger users_dob_locked`],
    [EDIT, 'missing', `drop trigger profiles_rereview_on_edit on public.profiles`],
    [
      EDIT,
      'neutered',
      `create or replace function app.rereview_on_profile_edit() returns trigger
         language plpgsql as $$ begin return new; end; $$`,
    ],
    [RENAME, 'missing', `drop trigger users_rereview_on_name_change on public.users`],
    [
      INVOKER,
      'made SECURITY DEFINER again (the bug 0029 found in itself)',
      `alter function app.rereview_on_name_change() security definer`,
    ],
    [
      SNAPSHOT,
      'missing',
      `drop trigger dob_correction_requests_snapshot on public.dob_correction_requests`,
    ],
    [AUDIT, 'missing', `drop trigger admin_action_audit_append_only on public.admin_action_audit`],
    [PRIMARY, 'dropped', `alter table public.photos drop constraint photos_primary_approved`],
    [
      ADMIN,
      'a member granted SELECT on admin_users',
      `grant select on public.admin_users to authenticated`,
    ],
    [
      ADMIN,
      'anon granted INSERT on moderation_actions',
      `grant insert on public.moderation_actions to anon`,
    ],
    [
      MFA,
      'the aal2 requirement removed',
      `create or replace function app.is_active_moderator() returns boolean language sql stable
         security definer set search_path = public, pg_temp as $$
           select exists (select 1 from public.admin_users a where a.user_id = app.current_user_id()) $$`,
    ],
    [
      PURGE,
      'members allowed to purge',
      `grant execute on function app.purge_expired_notifications() to authenticated`,
    ],
  ])('%s fails when %s', async (check, _how, breakage) => {
    const { names, detail } = await brokenBy(breakage);
    expect(names, detail).toEqual([check]);
  });
});
