import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../scripts/phase1-security-checks';
import { phase5PhotoChecks } from '../scripts/phase5-photo-checks';

/**
 * The Phase 5 checks `verify:db` runs (migration 0031), against a correct
 * database, one from before 0031, and databases broken one way at a time.
 */

const TABLES = 'L3 photo_requests and photo_grants: RLS forced, members read only';
const RULE = 'L3 app.photo_variant_readable refuses private photos; anon cannot run the rule';
const STORAGE = 'L3 Storage policy photos_bucket_select_authorised_viewer uses the rule';
const ALL = [TABLES, RULE, STORAGE];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

async function failures(pg: PGlite): Promise<{ names: string[]; detail: string }> {
  const results = await phase5PhotoChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  const failed = results.filter((r) => !r.ok);
  return {
    names: failed.map((r) => r.name).sort(),
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join('\n'),
  };
}

describe('a correctly migrated database', () => {
  it('passes every Phase 5 check (Storage reported as Supabase-only)', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([]);
      const storage = (await phase5PhotoChecks(queryable(pg))).find((r) => r.name === STORAGE);
      expect(storage?.detail).toMatch(/verify on the hosted project/);
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database from before 0031', () => {
  it('fails the table and rule checks', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261104000030' });
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([TABLES, RULE].sort());
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
    [
      TABLES,
      'members may insert requests',
      `grant insert on public.photo_requests to authenticated`,
    ],
    [TABLES, 'members may update grants', `grant update on public.photo_grants to authenticated`],
    [TABLES, 'RLS no longer forced', `alter table public.photo_grants no force row level security`],
    [TABLES, 'anon may read requests', `grant select on public.photo_requests to anon`],
    [
      RULE,
      'anon may run the rule',
      `grant execute on function app.can_read_photo_object(text) to anon`,
    ],
    [
      RULE,
      'the rule no longer refuses private photos',
      `create or replace function app.photo_variant_readable(viewer uuid, photo uuid, kind text)
         returns boolean language sql stable security definer set search_path = public, pg_temp
         as $$ select true $$`,
    ],
    [RULE, 'a function dropped', `drop function app.has_photo_grant(uuid, uuid, uuid) cascade`],
  ])('%s fails when %s', async (check, _how, breakage) => {
    const { names, detail } = await brokenBy(breakage);
    expect(names, detail).toContain(check);
  });
});
