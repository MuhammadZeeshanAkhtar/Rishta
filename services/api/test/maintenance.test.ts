import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance, TASKS, type Queryable } from '../scripts/maintenance';
import { seedReferenceData } from './helpers';

/**
 * Review L11 / B26 — the maintenance script. Against a real migrated database:
 * a dry run changes nothing, an applied run changes exactly what the dry run
 * counted, and a second applied run changes nothing. Against a fake: a held
 * lock skips every task, and one failing task does not stop the others.
 */

let pg: PGlite;
let userId: string;
let otherId: string;

const queryable = (db: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params as never[]),
});

const count = async (sql: string): Promise<number> =>
  Number((await pg.query<{ n: number }>(sql)).rows[0]!.n);

const rowsFor = (report: Awaited<ReturnType<typeof runMaintenance>>) =>
  Object.fromEntries(report.results.map((r) => [r.task, r.rows]));

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  await seedReferenceData(pg);
  const users = await pg.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ('Old Data', 'female', date '1995-06-15', 'pk', 'active'),
            ('Other', 'male', date '1994-01-01', 'pk', 'active')
     returning id`,
  );
  userId = users.rows[0]!.id;
  otherId = users.rows[1]!.id;

  // One row past each cutoff and one inside it.
  await pg.query(
    `insert into public.notifications (user_id, type, payload, dedupe_key, created_at) values
       ($1::uuid, 'new_match', '{}', 'old', now() - interval '13 months'),
       ($1::uuid, 'new_match', '{}', 'new', now() - interval '11 months')`,
    [userId],
  );
  await pg.query(
    `insert into public.security_events (user_id, event_type, created_at) values
       ($1::uuid, 'sign_in', now() - interval '13 months'),
       ($1::uuid, 'sign_in', now() - interval '1 day')`,
    [userId],
  );
  await pg.query(
    `insert into public.profile_views (viewer_user_id, viewed_user_id, viewed_at) values
       ($1::uuid, $2::uuid, now() - interval '13 months'),
       ($1::uuid, $2::uuid, now() - interval '1 hour')`,
    [otherId, userId],
  );
  await pg.query(
    `insert into public.family_invitations
       (owner_user_id, invitee_contact, relationship_code, tier, token_hash, expires_at, created_at) values
       ($1::uuid, 'old@example.test', 'father', 'observer', repeat('a', 64), now() - interval '1 day', now() - interval '8 days'),
       ($1::uuid, 'new@example.test', 'mother', 'observer', repeat('b', 64), now() + interval '6 days', now())`,
    [userId],
  );
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

const EXPECTED = {
  'notifications older than 12 months': 1,
  'security events older than 12 months': 1,
  'profile views older than 12 months': 1,
  'family invitations past their expiry': 1,
  'deletion requests past their grace period (report only)': 0,
  'abandoned photo uploads (report only)': 0,
};

describe('runMaintenance against a migrated database', () => {
  it('dry run (the default) counts and changes nothing', async () => {
    const report = await runMaintenance(queryable(pg));
    expect(report.skipped).toBe(false);
    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(rowsFor(report)).toEqual(EXPECTED);
    expect(report.results.filter((r) => r.mode === 'applied')).toEqual([]);

    expect(await count(`select count(*)::int as n from public.notifications`)).toBe(2);
    expect(await count(`select count(*)::int as n from public.security_events`)).toBe(2);
    expect(await count(`select count(*)::int as n from public.profile_views`)).toBe(2);
    expect(
      await count(
        `select count(*)::int as n from public.family_invitations where status = 'pending'`,
      ),
    ).toBe(2);
  });

  it('apply changes exactly what the dry run counted, and only past the cutoff', async () => {
    const report = await runMaintenance(queryable(pg), { apply: true });
    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(rowsFor(report)).toEqual(EXPECTED);

    expect(
      await count(`select count(*)::int as n from public.notifications where dedupe_key = 'new'`),
    ).toBe(1);
    expect(await count(`select count(*)::int as n from public.notifications`)).toBe(1);
    expect(await count(`select count(*)::int as n from public.security_events`)).toBe(1);
    expect(await count(`select count(*)::int as n from public.profile_views`)).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from public.family_invitations
          where invitee_contact = 'old@example.test' and status = 'expired' and responded_at is not null`,
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from public.family_invitations
          where invitee_contact = 'new@example.test' and status = 'pending'`,
      ),
    ).toBe(1);
  });

  it('is idempotent: a second applied run changes nothing', async () => {
    const report = await runMaintenance(queryable(pg), { apply: true });
    expect(report.results.every((r) => r.ok && r.rows === 0)).toBe(true);
  });

  it('reports deletion requests past their grace without executing them', async () => {
    await pg.query(
      `insert into public.account_deletion_requests (user_id, scheduled_for, previous_status, requested_at)
       values ($1::uuid, now() - interval '1 day', 'active', now() - interval '31 days')`,
      [otherId],
    );
    const report = await runMaintenance(queryable(pg), { apply: true });
    const task = report.results.find((r) => r.task.startsWith('deletion requests'))!;
    expect(task).toMatchObject({ mode: 'report', rows: 1, ok: true });
    expect(
      await count(
        `select count(*)::int as n from public.account_deletion_requests where status = 'pending'`,
      ),
    ).toBe(1);
  });

  it('releases its lock, so the next run is not skipped', async () => {
    const report = await runMaintenance(queryable(pg));
    expect(report.skipped).toBe(false);
  });
});

describe('runMaintenance safety, against a fake connection', () => {
  function fake(options: { locked: boolean; failOn?: string }) {
    const seen: string[] = [];
    const db: Queryable = {
      async query<T>(sql: string) {
        seen.push(sql);
        if (sql.includes('pg_try_advisory_lock'))
          return { rows: [{ locked: options.locked }] as T[] };
        if (options.failOn && sql === options.failOn)
          throw new Error('canceling statement due to statement timeout');
        return { rows: [{ n: 3 }] as T[] };
      },
    };
    return { db, seen };
  }

  it('skips every task when another run holds the lock', async () => {
    const { db, seen } = fake({ locked: false });
    const report = await runMaintenance(db, { apply: true });
    expect(report).toEqual({ skipped: true, results: [] });
    expect(seen).toHaveLength(1);
  });

  it('one failing task is rolled back and reported, and the rest still run', async () => {
    const failing = TASKS[1]!.apply!;
    const { db, seen } = fake({ locked: true, failOn: failing });
    const logs: Record<string, unknown>[] = [];
    const report = await runMaintenance(db, { apply: true, log: (l) => logs.push(l) });
    expect(report.results).toHaveLength(TASKS.length);
    expect(report.results.filter((r) => !r.ok).map((r) => r.task)).toEqual([TASKS[1]!.name]);
    expect(report.results.filter((r) => r.ok)).toHaveLength(TASKS.length - 1);
    expect(seen[seen.indexOf(failing) + 1]).toBe('rollback');
    expect(seen.at(-1)).toMatch(/pg_advisory_unlock/);
    expect(
      logs.some((l) => l.level === 'error' && String(l.error).includes('statement timeout')),
    ).toBe(true);
  });

  it('runs every task in its own transaction with a statement timeout', async () => {
    const { db, seen } = fake({ locked: true });
    await runMaintenance(db);
    expect(seen.filter((s) => s === 'begin')).toHaveLength(TASKS.length);
    expect(seen.filter((s) => /set local statement_timeout/.test(s))).toHaveLength(TASKS.length);
    // Dry run: no apply statement is ever sent.
    for (const task of TASKS) if (task.apply) expect(seen).not.toContain(task.apply);
  });
});
