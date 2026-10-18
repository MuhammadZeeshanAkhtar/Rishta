/**
 * Applies the NikahMate migrations to a real Postgres.
 *
 *   pnpm --filter @nikahmate/api migrate:status   # report only, writes nothing
 *   pnpm --filter @nikahmate/api migrate --dry-run
 *   pnpm --filter @nikahmate/api migrate
 *
 * Reads DATABASE_URL from services/api/.env (loaded by --env-file-if-exists).
 * The connection string contains the database password, so it is never printed,
 * logged, or included in an error message — only the masked host is shown, so
 * you can confirm which project you are about to change.
 *
 * Three safety properties, in the order they matter:
 *
 * 1. It refuses to touch a database that holds tables we did not create. That
 *    is the Zufishan prohibition (docs/SUPABASE_SETUP.md) enforced in code
 *    rather than in prose — a wrong connection string should fail, not merge
 *    our schema into someone else's project.
 * 2. Each migration runs inside its own transaction, together with the row that
 *    records it. A failure rolls back both, so the ledger can never claim a
 *    migration was applied when it was not.
 * 3. Applied migrations are checksummed. Editing a file after it has run
 *    stops the next run, because the database no longer matches the files that
 *    supposedly produced it.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { MIGRATIONS_DIR } from '@nikahmate/db';

const STATUS = process.argv.includes('--status');
const DRY_RUN = process.argv.includes('--dry-run') || STATUS;

/**
 * Tables this schema is allowed to find already present, READ FROM THE
 * MIGRATIONS rather than listed here.
 *
 * Anything else in `public` means the connection string points somewhere
 * unexpected, and we stop.
 *
 * This used to be a hand-maintained Set, and it drifted exactly as you would
 * expect: it ended at `notifications`, so once 0022 added `reports` the guard
 * classified our own table as someone else's and refused to run against any
 * database carrying the current schema — including `--status`, which writes
 * nothing. The runner became unusable at precisely the point the schema was
 * complete, and the failure looked like "you are pointed at the wrong project",
 * which is the most alarming thing it can say.
 *
 * Deriving it removes the failure mode instead of correcting one instance of
 * it. The migrations are the only authority on what this schema creates, so a
 * table cannot be added without the guard learning about it in the same commit.
 */
function tablesCreatedBy(migrations: Migration[]): Set<string> {
  // `schema_migrations` is the ledger. This runner creates it, and no migration
  // file does, so it is the one name that has to be named.
  const ours = new Set(['schema_migrations']);

  // Matches `create table public.foo` and `create table if not exists
  // public.foo`, optionally quoted. Every migration uses this form; a future
  // one that does not will fail the assertion below rather than silently
  // leaving a table out of the guard.
  const pattern =
    /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?"?public"?\."?([a-z_][a-z0-9_]*)"?/gim;

  for (const { filename, sql } of migrations) {
    const found = [...sql.matchAll(pattern)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
    for (const name of found) ours.add(name);

    // A `create table` the pattern did not understand would leave one of our
    // own tables out of the guard, and the symptom would be this runner
    // refusing to touch a correct database. Fail here, where the cause is
    // obvious, rather than there.
    const statements = (sql.match(/^\s*create\s+table\s/gim) ?? []).length;
    if (statements !== found.length) {
      throw new Error(
        `${filename}: found ${statements} "create table" statement(s) but could ` +
          `only identify ${found.length}. The guard in scripts/migrate.ts parses ` +
          `"create table public.<name>"; update tablesCreatedBy() to cover the ` +
          `form this migration uses.`,
      );
    }
  }

  return ours;
}

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

function checksum(sql: string): string {
  // Normalise line endings first: this repository is developed on Windows and
  // checked out on Linux in CI. A checksum that changes with the line ending
  // would fail every CI run for no reason.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);

  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: checksum(sql) };
    }),
  );
}

/** Host only — never the user, password, or full connection string. */
function maskedTarget(url: string): string {
  try {
    const { host } = new URL(url);
    return host.endsWith('.supabase.co') || host.endsWith('.supabase.com')
      ? `${host.split('.')[0]!.slice(0, 4)}….supabase.co`
      : host.replace(/^[^.]*/, (s) => s.slice(0, 4) + '…');
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    console.error(
      'DATABASE_URL is not set.\n\n' +
        'Add it to services/api/.env. In the Supabase dashboard:\n' +
        '  Project Settings -> Database -> Connection string -> Session pooler\n' +
        '  (host aws-<n>-<region>.pooler.supabase.com, port 5432,\n' +
        '   user postgres.<project-ref>)\n' +
        '  Replace [YOUR-PASSWORD] with your database password.\n\n' +
        'Session mode, not the transaction pooler on 6543: schema changes need\n' +
        'a connection that lives longer than one transaction.\n\n' +
        'It contains your password. It belongs only in that gitignored file.',
    );
    process.exit(2);
  }

  // Transaction mode pins a connection only for the length of one transaction
  // and does not support prepared statements or session-level state. Supabase
  // points migrations at a direct or session-mode connection for that reason.
  // Refusing here beats a confusing half-applied failure later.
  if (/:6543(\/|$|\?)/.test(url)) {
    console.error(
      'DATABASE_URL points at the TRANSACTION pooler (port 6543).\n\n' +
        'That mode is for a running application, not for schema changes.\n' +
        'Use the session pooler instead — same host, port 5432:\n' +
        '  Project Settings -> Database -> Connection string -> Session pooler\n\n' +
        'Session mode works for the API service too, so one value covers both in dev.',
    );
    process.exit(2);
  }

  const migrations = await loadMigrations();
  const client = new Client({
    connectionString: url,
    // Supabase terminates TLS with a certificate this client does not have a
    // local root for. The connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    application_name: 'nikahmate-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    // Deliberately not re-throwing: a pg connection error can carry the
    // connection string, and this is the one place most likely to print it.
    console.error(`Could not connect to ${maskedTarget(url)}: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`Target   : ${maskedTarget(url)}`);
  console.log(`Migrations: ${migrations.length} file(s) in supabase/migrations`);

  try {
    // --- guard: is this the database we think it is? ------------------------
    const { rows: existing } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const ours = tablesCreatedBy(migrations);
    const foreign = existing.map((r) => r.tablename).filter((t) => !ours.has(t));

    if (foreign.length > 0) {
      console.error(
        `\nREFUSING TO RUN.\n\n` +
          `public contains ${foreign.length} table(s) this schema did not create:\n` +
          `  ${foreign.slice(0, 15).join(', ')}${foreign.length > 15 ? ', …' : ''}\n\n` +
          `NikahMate must have its own Supabase project (docs/SUPABASE_SETUP.md).\n` +
          `Check the project ref in DATABASE_URL before running again.`,
      );
      process.exit(1);
    }

    console.log(
      existing.length === 0
        ? 'Database : empty public schema — a fresh project'
        : `Database : ${existing.length} existing table(s), all ours`,
    );

    // --- ledger -------------------------------------------------------------
    if (!DRY_RUN) {
      await client.query(`create schema if not exists app`);
      await client.query(`
        create table if not exists app.schema_migrations (
          filename    text primary key,
          checksum    text not null,
          applied_at  timestamptz not null default now()
        )
      `);
    }

    const ledgerExists = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_tables
       where schemaname = 'app' and tablename = 'schema_migrations'`,
    );

    const applied = new Map<string, string>();
    if ((ledgerExists.rows[0]?.n ?? 0) > 0) {
      const { rows } = await client.query<{ filename: string; checksum: string }>(
        `select filename, checksum from app.schema_migrations`,
      );
      for (const r of rows) applied.set(r.filename, r.checksum);
    }

    // --- drift check --------------------------------------------------------
    const drifted = migrations.filter(
      (m) => applied.has(m.filename) && applied.get(m.filename) !== m.checksum,
    );
    if (drifted.length > 0) {
      console.error(
        `\nREFUSING TO RUN.\n\n` +
          `These migrations changed after they were applied:\n` +
          drifted.map((m) => `  ${m.filename}`).join('\n') +
          `\n\nThe database no longer matches the files that produced it. Either\n` +
          `restore the files, or roll the change forward in a NEW migration.`,
      );
      process.exit(1);
    }

    const pending = migrations.filter((m) => !applied.has(m.filename));

    console.log('');
    for (const m of migrations) {
      console.log(`  ${applied.has(m.filename) ? 'applied ' : 'PENDING '} ${m.filename}`);
    }
    console.log('');

    if (pending.length === 0) {
      console.log('Nothing to do — the schema is up to date.');
      return;
    }

    if (DRY_RUN) {
      console.log(`${pending.length} migration(s) would be applied. No changes made.`);
      return;
    }

    for (const m of pending) {
      process.stdout.write(`Applying ${m.filename} … `);
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query(
          `insert into app.schema_migrations (filename, checksum) values ($1, $2)`,
          [m.filename, m.checksum],
        );
        await client.query('commit');
        console.log('ok');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        console.log('FAILED');
        console.error(`\n${m.filename}: ${(error as Error).message}`);
        console.error('\nRolled back. No partial schema was left behind.');
        process.exit(1);
      }
    }

    console.log(`\n${pending.length} migration(s) applied.`);
    console.log('Next: pnpm --filter @nikahmate/api verify:db');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(`migrate failed: ${(error as Error).message}`);
  process.exit(1);
});
