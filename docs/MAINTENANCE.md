# Maintenance task — runbook

Code review B26 (retention) and L11 (background jobs). The part of L11 that
needs no job runner: periodic database housekeeping, run by any scheduler.

**Status:** implemented and tested locally (PGlite). **Never run against a
hosted database.** It needs migrations 0029 and 0030 applied first.

## What it does

| Task                                          | Changes with `--apply`                                                                                | Source                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Notifications older than 12 months            | deletes them                                                                                          | `app.purge_expired_notifications()` (0029)                   |
| Security events older than 12 months          | deletes them                                                                                          | `app.purge_expired_security_events()` (0030)                 |
| Profile views older than 12 months            | deletes them                                                                                          | `app.purge_expired_profile_views()` (0030)                   |
| Suspensions past their moderator-set end date | back to the status held before, recorded in `moderation_actions` with `reason = 'suspension_expired'` | `app.lift_expired_suspensions()`                             |
| Family invitations past `expires_at`          | `pending` → `expired`, `responded_at = now()`                                                         | `app.expire_family_invitations()` (0030)                     |
| Deletion requests past their grace            | **nothing — reported only**                                                                           | execution needs the Supabase Auth admin API and a job runner |
| Abandoned photo uploads (> 1 day)             | **nothing — reported only**                                                                           | byte removal needs a Storage service key                     |

The retention periods are the ERD's (12 months for notifications, security
events and profile views). Soft-deleted messages (90 days, with a retention
hold for open reports) are **not** purged: the hold rule is not built.

## Safety properties

- **Dry run by default.** Without `--apply` it only counts.
- **One run at a time.** A session advisory lock
  (`hashtext('nikahmate.maintenance')`); an overlapping run logs `skipped` and
  exits 0.
- **Idempotent.** A second applied run changes nothing.
- **Each task in its own transaction**, with `statement_timeout = 60s`. A
  failing task is rolled back and reported; the others still run.
- **Structured logs.** One JSON line per task on stdout:
  `{"at":…,"level":"info","msg":"maintenance task","task":…,"mode":"applied","rows":3,"ok":true,"durationMs":12}`.
  The connection string is never printed — only a masked host.
- **The functions are service-role only.** Members and `anon` cannot execute
  them (`verify:db` checks this: "B26 …" and "L11 …").

Exit codes: `0` success or skipped · `1` a task failed or no connection ·
`2` configuration (`DATABASE_URL` missing).

## Running it

```bash
pnpm --filter @nikahmate/api maintenance
```

```bash
pnpm --filter @nikahmate/api maintenance -- --apply
```

Run the dry run first against any new environment and read the counts.

## Environment

| Variable       | Required | Notes                                                                                                                                                                                                                                                            |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | Postgres connection string with rights to execute the `app.*` functions above (the service role / `postgres`). Use the **session** pooler (port 5432), not the transaction pooler: the advisory lock is per session. Read from `services/api/.env` when present. |

No other variable is read. Nothing in `.env` is printed.

## Scheduling (infrastructure — not in this repository)

No scheduler exists for this project yet. Any of these works, once a hosted
database exists and 0029/0030 are applied:

- a cron entry on a host with the repository and Node ≥ 20.9:
  `15 3 * * * cd /srv/nikahmate && pnpm --filter @nikahmate/api maintenance -- --apply >> /var/log/nikahmate-maintenance.log 2>&1`
- the hosting platform's scheduled job (Render cron job, GitHub Actions
  `schedule`) running the same command with `DATABASE_URL` as a secret.

Once a day is enough for every task. Alert on a non-zero exit code.

## Not done here (needs approval or infrastructure)

- A job runner (e.g. pg-boss — a new dependency, needs approval) for work that
  must happen at a specific time: deletion execution, review-SLA sweeps,
  suspension expiry, push delivery.
- Deletion execution (Supabase Auth admin API).
- Removal of abandoned upload bytes from Storage on a schedule (the API already
  removes them, best effort, when the member next uploads — review B11).
