import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { grantStorageStandIn, seedStorageStandIn } from './helpers';

/**
 * Review N4: the real `verify-db.ts`, start to finish, against a correctly
 * migrated database. Before this nothing ran the script as a whole, which is how
 * it came to fail every correct project without any test noticing.
 *
 * `pg` is replaced with a PGlite-backed client, so this cannot reach any network
 * whatever DATABASE_URL says. The script's own checks and its own exit decision
 * run unchanged.
 */

const state = vi.hoisted(() => ({ pg: null as unknown }));

vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    query(sql: string, params?: unknown[]) {
      return (state.pg as PGlite).query(sql, params as never[]);
    }
  },
}));

let pg: PGlite;
const output: string[] = [];
const exits: number[] = [];

beforeAll(async () => {
  pg = new PGlite();
  await seedStorageStandIn(pg);
  await applyMigrations(pg);
  await grantStorageStandIn(pg);
  state.pg = pg;

  process.env.DATABASE_URL = 'postgres://verify-end-to-end.invalid/none';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as never);

  await import('../scripts/verify-db');
  await vi.waitFor(
    () => {
      expect(output.join('\n')).toMatch(/\d+\/\d+ checks passed\./);
    },
    { timeout: 170_000, interval: 250 },
  );
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await pg?.close();
});

describe('verify-db.ts against a correctly migrated database', () => {
  it('reports no failed check', () => {
    const failed = output.filter((line) => /^\s*FAIL\b/.test(line));
    expect(failed).toEqual([]);
  });

  it('passes every check, and exits 0', () => {
    const summary = /(\d+)\/(\d+) checks passed\./.exec(output.join('\n'));
    expect(summary).not.toBeNull();
    expect(Number(summary![2])).toBeGreaterThan(50);
    expect(summary![1]).toBe(summary![2]);
    expect(exits).toEqual([]);
  });

  it('ran the Storage inventory for real, not the "not a Supabase database" path', () => {
    const line = output.find((l) => l.includes('Storage policies match migrations'));
    expect(line).toMatch(/7 policies as defined/);
    expect(line).not.toMatch(/verify on the hosted project/);
  });

  it('ran the post-merge checks', () => {
    const text = output.join('\n');
    expect(text).toContain('N2 profiles, photos, photo_variants');
    expect(text).toContain('N1 every member-reachable table');
    expect(text).toContain('N1 only the server can end a suspension');
  });

  it('left nothing behind: its probes are rolled back', async () => {
    const rows = await pg.query(`select 1 from public.users where display_name like 'Verify%'`);
    expect(rows.rows).toEqual([]);
  });
});
