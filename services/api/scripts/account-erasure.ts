/**
 * Carries out account deletions whose 30-day grace period has ended (ERD E1).
 *
 *   pnpm --filter @nikahmate/api account-erasure report
 *   pnpm --filter @nikahmate/api account-erasure execute [--limit=N] [--apply]
 *
 * DRY RUN BY DEFAULT. `execute` without `--apply` changes nothing: it says what each
 * due request would do. Erasure is permanent, so whoever runs it with `--apply`, and
 * how often, is a company decision. See docs/PRODUCTION_SECURITY.md.
 *
 * FOR EACH DUE REQUEST, under row locks, in one transaction:
 *   1. ask the database whether the account can be erased (`app.erasure_blocker`), and
 *      skip it, saying why, if anything other than an open report or a retention hold
 *      blocks it
 *   2. run `app.erase_account`, NOT YET COMMITTED. If a report is open, or the account
 *      has a retention hold, it holds the request (R4) and that is committed with
 *      nothing else touched. If the database
 *      cannot erase the account, nothing irreversible has happened yet
 *   3. delete every file in the member's Storage folder, then their sign-in from
 *      Supabase Auth
 *   4. commit.
 * Any failure rolls the database back and moves on to the next request. Storage and
 * Auth deletes are safe to repeat, so the next run finishes what a failed one began.
 * `--limit` counts requests acted on: a request that is skipped every time (a staff
 * account, a banned member) never stops the others being reached.
 *
 * NOTHING PRIVATE IS PRINTED. Request ids, counts, steps and status codes only, never a
 * name, an email, a file path, a response body or a connection string.
 *
 * Deleting files and sign-ins needs the service-role key, in ERASURE_TOOL_SERVICE_KEY,
 * with SUPABASE_URL. The API refuses to start with that key in its environment
 * (FORBIDDEN_ENV_KEYS in config.ts), so this runs as a separate, supervised process.
 */

import { Client, type QueryResultRow } from 'pg';
import { databaseConnection, explainTlsFailure } from '../src/db/tls';
import { PHOTO_BUCKET } from '../src/storage/client';
import type { Queryable } from './phase1-security-checks';

/** Where files and sign-ins are deleted. Absent in a dry run. */
export interface ErasureServices {
  supabaseUrl: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
  /** How long one Storage or Auth call may take. Row locks are held meanwhile. */
  timeoutMs?: number;
}

export interface ErasureSummary {
  applied: boolean;
  considered: number;
  erased: number;
  held: number;
  skipped: { requestId: string; reason: string }[];
  /** `code` is an HTTP status, a Postgres error code or `timeout`: never a message. */
  failed: { requestId: string; step: string; code?: string }[];
  /** In a dry run, what each request would do. `files` counts the rows the database knows. */
  planned: { requestId: string; outcome: 'erase' | 'hold'; files: number; signIns: number }[];
}

export interface ErasureReport {
  due: number;
  held: number;
  inGracePeriod: number;
  executed: number;
}

export async function erasureReport(db: Queryable): Promise<ErasureReport> {
  const { rows } = await db.query<{
    due: number;
    held: number;
    in_grace: number;
    executed: number;
  }>(
    `select count(*) filter (where status = 'pending' and scheduled_for <= now())::int as due,
            count(*) filter (where status = 'held')::int as held,
            count(*) filter (where status = 'pending' and scheduled_for > now())::int as in_grace,
            count(*) filter (where status = 'executed')::int as executed
       from public.account_deletion_requests`,
  );
  const row = rows[0]!;
  return { due: row.due, held: row.held, inGracePeriod: row.in_grace, executed: row.executed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PAGE = 100;

/** A failure whose code is safe to print. */
class StepError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof StepError) return error.code;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  const sqlState = (error as { code?: unknown } | null)?.code;
  return typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : undefined;
}

function send(services: ErasureServices, path: string, init: RequestInit): Promise<Response> {
  const fetchImpl = services.fetchImpl ?? fetch;
  return fetchImpl(`${services.supabaseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${services.serviceKey}`,
      apikey: services.serviceKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(services.timeoutMs ?? 30_000),
  });
}

/**
 * Every file in the member's folder. The rows alone can miss one: a finalize that failed
 * after writing its variants, a member's own delete whose Storage call failed (the
 * Storage client ignores that), or a file written before 0033 narrowed what a member
 * may write. The folder is the member's id, so it can only ever hold their files.
 */
async function folderFiles(services: ErasureServices, userId: string): Promise<string[]> {
  const found: string[] = [];
  const folders = [`${userId}/`];
  while (folders.length > 0) {
    const prefix = folders.pop()!;
    for (let offset = 0; ; offset += LIST_PAGE) {
      const response = await send(services, `/storage/v1/object/list/${PHOTO_BUCKET}`, {
        method: 'POST',
        body: JSON.stringify({
          prefix,
          limit: LIST_PAGE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
      });
      if (!response.ok) throw new StepError(`http_${response.status}`);
      const entries = (await response.json()) as { name: string; id: string | null }[];
      for (const entry of entries) {
        // Storage lists a folder as an entry with no id.
        if (entry.id === null) folders.push(`${prefix}${entry.name}/`);
        else found.push(`${prefix}${entry.name}`);
      }
      if (entries.length < LIST_PAGE) break;
    }
  }
  return found;
}

/** Deletes files, failing loudly. Storage's own client ignores failures on purpose. */
async function removeFiles(
  services: ErasureServices,
  userId: string,
  known: string[],
): Promise<void> {
  // Never list or delete outside one member's own folder: an empty or malformed id
  // would make the prefix the whole bucket.
  if (!UUID.test(userId)) throw new StepError('invalid_user_id');
  const owned = `${userId}/`;
  const paths = [...new Set([...known, ...(await folderFiles(services, userId))])];
  if (paths.some((path) => !path.startsWith(owned))) throw new StepError('path_outside_folder');
  for (let i = 0; i < paths.length; i += 100) {
    const response = await send(services, `/storage/v1/object/${PHOTO_BUCKET}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }),
    });
    if (!response.ok) throw new StepError(`http_${response.status}`);
  }
}

/** Deletes a sign-in. One that is already gone counts as deleted. */
async function removeSignIn(services: ErasureServices, authUserId: string): Promise<void> {
  const response = await send(services, `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw new StepError(`http_${response.status}`);
}

export async function executeDueErasures(
  db: Queryable,
  services: ErasureServices | null,
  options: { apply?: boolean; limit?: number } = {},
): Promise<ErasureSummary> {
  const apply = options.apply ?? false;
  if (apply && !services) throw new Error('Applying an erasure needs Storage and Auth access');
  const limit = options.limit ?? 50;

  const { rows: due } = await db.query<{ id: string; user_id: string }>(
    `select id, user_id from public.account_deletion_requests
      where status = 'pending' and scheduled_for <= now()
      order by scheduled_for, id`,
  );

  const summary: ErasureSummary = {
    applied: apply,
    considered: 0,
    erased: 0,
    held: 0,
    skipped: [],
    failed: [],
    planned: [],
  };
  let actedOn = 0;

  for (const request of due) {
    if (actedOn >= limit) break;
    summary.considered += 1;
    let step = 'lock';
    await db.query('begin');
    try {
      await db.query(
        `select 1 from public.account_deletion_requests where id = $1::uuid for update`,
        [request.id],
      );
      await db.query(`select 1 from public.users where id = $1::uuid for update`, [
        request.user_id,
      ]);

      step = 'check';
      const blocked = await db.query<{ blocker: string | null }>(
        `select app.erasure_blocker($1::uuid) as blocker`,
        [request.user_id],
      );
      const blocker = blocked.rows[0]?.blocker ?? null;
      // These hold the request (R4, retention holds); anything else skips it.
      const holds = blocker === 'open_report' || blocker === 'retention_hold';

      if (blocker !== null && !holds) {
        summary.skipped.push({ requestId: request.id, reason: blocker });
        await db.query('rollback');
        continue;
      }
      actedOn += 1;

      // Gathered before the database forgets them.
      const files = await db.query<{ path: string }>(
        `select p.storage_path as path from public.photos p where p.user_id = $1::uuid
         union
         select v.storage_path from public.photo_variants v
           join public.photos p on p.id = v.photo_id
          where p.user_id = $1::uuid`,
        [request.user_id],
      );
      const signIns = await db.query<{ auth_user_id: string }>(
        `select auth_user_id from public.user_auth_links where user_id = $1::uuid`,
        [request.user_id],
      );

      if (!apply) {
        summary.planned.push({
          requestId: request.id,
          outcome: holds ? 'hold' : 'erase',
          files: files.rows.length,
          signIns: signIns.rows.length,
        });
        await db.query('rollback');
        continue;
      }

      // The database first, uncommitted. Whatever it decides under its own locks is
      // what happens: if a report was closed a moment ago it erases, if one was opened
      // it holds, and if it cannot erase, no file or sign-in has been touched.
      step = 'database';
      const decided = await db.query<{ outcome: string }>(
        `select app.erase_account($1::uuid) as outcome`,
        [request.user_id],
      );
      const outcome = decided.rows[0]?.outcome;
      if (outcome === 'held') {
        await db.query('commit');
        summary.held += 1;
        continue;
      }
      if (outcome !== 'erased') throw new StepError('unexpected_outcome');

      step = 'storage';
      await removeFiles(
        services!,
        request.user_id,
        files.rows.map((f) => f.path),
      );
      step = 'auth';
      for (const signIn of signIns.rows) await removeSignIn(services!, signIn.auth_user_id);
      step = 'commit';
      await db.query('commit');
      summary.erased += 1;
    } catch (error) {
      await db.query('rollback').catch(() => {});
      const code = codeOf(error);
      summary.failed.push({ requestId: request.id, step, ...(code ? { code } : {}) });
    }
  }
  return summary;
}

// --- command line ------------------------------------------------------------

async function main(): Promise<void> {
  const write = (line: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  };
  const [command] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg === undefined ? undefined : Number(limitArg);

  if (!['report', 'execute'].includes(command ?? '')) {
    write({ level: 'error', msg: 'usage: report | execute [--limit=N] [--apply]' });
    process.exit(2);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    write({ level: 'error', msg: '--limit must be a positive whole number' });
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    write({ level: 'error', msg: 'DATABASE_URL is not set' });
    process.exit(2);
  }

  let services: ErasureServices | null = null;
  if (command === 'execute' && apply) {
    const serviceKey = process.env.ERASURE_TOOL_SERVICE_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!serviceKey || !supabaseUrl) {
      write({ level: 'error', msg: 'ERASURE_TOOL_SERVICE_KEY and SUPABASE_URL are required' });
      process.exit(2);
    }
    services = { supabaseUrl, serviceKey };
  }

  const { connectionString, ssl } = databaseConnection(url);
  const client = new Client({ connectionString, ssl, application_name: 'nikahmate-erasure' });
  try {
    await client.connect();
  } catch (error) {
    write({ level: 'error', msg: explainTlsFailure(error) ?? 'could not connect to the database' });
    process.exit(1);
  }
  const db: Queryable = {
    query: <T>(sql: string, params?: unknown[]) => client.query<T & QueryResultRow>(sql, params),
  };

  try {
    if (command === 'report') {
      write({ level: 'info', command, ...(await erasureReport(db)) });
    } else {
      const summary = await executeDueErasures(db, services, {
        apply,
        ...(limit ? { limit } : {}),
      });
      write({ level: summary.failed.length > 0 ? 'error' : 'info', command, ...summary });
      if (summary.failed.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    // A code, never the message: a Postgres message can quote row values.
    write({ level: 'error', command, msg: 'the run stopped', code: codeOf(error) ?? 'unknown' });
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

// Only when run as a script: tests import the functions above.
if (process.argv[1] && /account-erasure\.ts$/.test(process.argv[1])) {
  void main();
}
