/**
 * Periodic maintenance — review B26 (retention) and the part of L11 that needs
 * no job runner.
 *
 *   pnpm --filter @nikahmate/api maintenance              # dry run: counts only
 *   pnpm --filter @nikahmate/api maintenance -- --apply   # makes the changes
 *
 * SAFE TO RUN REPEATEDLY, AND CONCURRENTLY:
 *   - DRY RUN BY DEFAULT. Nothing changes without `--apply`, so a mistyped
 *     schedule or a manual run against the wrong database only reports.
 *   - ONE RUN AT A TIME. A session advisory lock: a second run that starts
 *     while one is going reports `skipped` and exits 0.
 *   - IDEMPOTENT. Every task is a database function that changes nothing the
 *     second time (retention deletes rows past a cutoff; expiry flips state
 *     once).
 *   - EACH TASK IN ITS OWN TRANSACTION, with a statement timeout, so one slow
 *     or failing task neither blocks nor rolls back the others.
 *   - STRUCTURED LOGS. One JSON line per task: what, how many, how long. The
 *     connection string is never printed — the host only, masked.
 *
 * Exit codes: 0 success or skipped, 1 a task failed, 2 configuration.
 *
 * Scheduling it (a cron job, a platform scheduled task) is infrastructure,
 * outside this repository. Required environment: DATABASE_URL (session
 * pooler, port 5432 — see docs/SUPABASE_SETUP.md), read from services/api/.env.
 *
 * Tasks (database functions, migrations 0029–0030, ERD retention table):
 *   notifications older than 12 months     app.purge_expired_notifications()
 *   security events older than 12 months   app.purge_expired_security_events()
 *   profile views older than 12 months     app.purge_expired_profile_views()
 *   family invitations past their expiry   app.expire_family_invitations()
 *   suspensions past their end date        app.lift_expired_suspensions()
 *   staff access log older than 24 months  app.purge_expired_pii_access_log()
 *   family reviews past the 72-hour SLA    app.notify_stalled_family_reviews()
 * Reported, never changed (they need a key this script does not hold):
 *   deletion requests past their grace     — `account-erasure execute --apply` runs them
 *   abandoned photo uploads                — byte removal needs a Storage key
 */

import { Client, type QueryResultRow } from 'pg';
import { databaseConnection, explainTlsFailure } from '../src/db/tls';

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Task {
  name: string;
  /** How many rows `apply` would change, without changing them. */
  count: string;
  /** Makes the change; returns how many rows it changed. Absent = report only. */
  apply?: string;
}

export const TASKS: readonly Task[] = [
  {
    name: 'notifications older than 12 months',
    count: `select count(*)::int as n from public.notifications where created_at < now() - interval '12 months'`,
    apply: 'select app.purge_expired_notifications() as n',
  },
  {
    name: 'security events older than 12 months',
    count: `select count(*)::int as n from public.security_events where created_at < now() - interval '12 months'`,
    apply: 'select app.purge_expired_security_events() as n',
  },
  {
    name: 'profile views older than 12 months',
    count: `select count(*)::int as n from public.profile_views where viewed_at < now() - interval '12 months'`,
    apply: 'select app.purge_expired_profile_views() as n',
  },
  {
    name: 'family invitations past their expiry',
    count: `select count(*)::int as n from public.family_invitations where status = 'pending' and expires_at < now()`,
    apply: 'select app.expire_family_invitations() as n',
  },
  {
    name: 'suspensions past their end date',
    count: `select count(*)::int as n
              from public.users u
              join lateral (
                select m.action, m.expires_at from public.moderation_actions m
                 where m.subject_user_id = u.id and m.action in ('suspend', 'ban', 'clear')
                 order by m.created_at desc, m.id desc limit 1
              ) latest on true
             where u.status = 'suspended' and u.deleted_at is null
               and latest.action = 'suspend'
               and latest.expires_at is not null and latest.expires_at <= now()`,
    apply: 'select app.lift_expired_suspensions() as n',
  },
  {
    name: 'staff access log older than 24 months',
    count: `select count(*)::int as n from public.pii_access_log where accessed_at < now() - interval '24 months'`,
    apply: 'select app.purge_expired_pii_access_log() as n',
  },
  {
    // D12-g. The Family screen also sweeps this on read; this is for everyone else.
    name: 'family reviews past the 72-hour SLA',
    count: `select count(*)::int as n from public.family_reviews r
             where r.decision in ('pending', 'more_info_requested')
               and r.sla_notified_at is null
               and r.requested_at < now() - interval '72 hours'
               and exists (select 1 from public.matches m
                            where m.id = r.match_id
                              and m.communication_state = 'pending_family_review'
                              and m.ended_at is null)`,
    apply: 'select app.notify_stalled_family_reviews() as n',
  },
  {
    // Executed by `account-erasure execute --apply`, which holds the key this lacks.
    name: 'deletion requests past their grace period (report only)',
    count: `select count(*)::int as n from public.account_deletion_requests
             where status = 'pending' and scheduled_for < now()`,
  },
  {
    name: 'abandoned photo uploads (report only)',
    count: `select count(*)::int as n from public.photos p
             where p.deleted_at is null and p.moderation_status = 'pending'
               and not exists (select 1 from public.photo_variants v where v.photo_id = p.id)
               and p.created_at < now() - interval '1 day'`,
  },
];

const LOCK_KEY = "hashtext('nikahmate.maintenance')";
const STATEMENT_TIMEOUT = '60s';

export interface TaskResult {
  task: string;
  mode: 'dry_run' | 'applied' | 'report';
  rows: number;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface MaintenanceReport {
  skipped: boolean;
  results: TaskResult[];
}

/**
 * Runs every task once. `apply: false` (the default) only counts. Never
 * throws for a task failure: it is reported and the next task runs.
 */
export async function runMaintenance(
  db: Queryable,
  options: { apply?: boolean; log?: (line: Record<string, unknown>) => void } = {},
): Promise<MaintenanceReport> {
  const apply = options.apply ?? false;
  const log = options.log ?? (() => {});

  const lock = await db.query<{ locked: boolean }>(
    `select pg_try_advisory_lock(${LOCK_KEY}) as locked`,
  );
  if (!lock.rows[0]?.locked) {
    log({ level: 'info', msg: 'maintenance skipped: another run holds the lock' });
    return { skipped: true, results: [] };
  }

  const results: TaskResult[] = [];
  try {
    for (const task of TASKS) {
      const started = Date.now();
      const mode: TaskResult['mode'] = task.apply ? (apply ? 'applied' : 'dry_run') : 'report';
      try {
        await db.query('begin');
        await db.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
        const sql = mode === 'applied' ? task.apply! : task.count;
        const { rows } = await db.query<{ n: number }>(sql);
        await db.query('commit');
        const result = {
          task: task.name,
          mode,
          rows: Number(rows[0]?.n ?? 0),
          ok: true,
          durationMs: Date.now() - started,
        };
        results.push(result);
        log({ level: 'info', msg: 'maintenance task', ...result });
      } catch (error) {
        await db.query('rollback').catch(() => {});
        const result = {
          task: task.name,
          mode,
          rows: 0,
          ok: false,
          durationMs: Date.now() - started,
          error: (error as Error).message,
        };
        results.push(result);
        log({ level: 'error', msg: 'maintenance task failed', ...result });
      }
    }
  } finally {
    await db.query(`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
  }
  return { skipped: false, results };
}

function maskedHost(url: string): string {
  try {
    return new URL(url).host.replace(/^[^.]*/, (s) => `${s.slice(0, 4)}…`);
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const write = (line: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  };
  if (!url || url.trim().length === 0) {
    write({ level: 'error', msg: 'DATABASE_URL is not set; see services/api/.env.example' });
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const client = new Client({
    ...databaseConnection(url),
    application_name: 'nikahmate-maintenance',
  });
  try {
    await client.connect();
  } catch (error) {
    write({
      level: 'error',
      msg: `could not connect to ${maskedHost(url)}`,
      error: explainTlsFailure(error) ?? (error as Error).message,
    });
    process.exit(1);
  }
  write({
    level: 'info',
    msg: 'maintenance start',
    host: maskedHost(url),
    mode: apply ? 'apply' : 'dry_run',
  });
  let failed = false;
  try {
    const report = await runMaintenance(
      {
        query: <T>(sql: string, params?: unknown[]) =>
          client.query<T & QueryResultRow>(sql, params),
      },
      { apply, log: write },
    );
    failed = report.results.some((r) => !r.ok);
  } finally {
    await client.end().catch(() => {});
  }
  write({ level: failed ? 'error' : 'info', msg: 'maintenance done', failed });
  if (failed) process.exit(1);
}

// Only when run as a script — tests import runMaintenance and TASKS.
if (process.argv[1] && /maintenance\.ts$/.test(process.argv[1])) {
  void main();
}
