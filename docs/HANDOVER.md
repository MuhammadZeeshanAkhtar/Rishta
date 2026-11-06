# NikahMate — Handover

**Prepared:** 5 November 2026, against the manager's code review of 28 October 2026
(reviewed commit `6c67581`).

**Read this first:** all of this work has been verified locally only. Nothing has been
applied to hosted Supabase, nothing has been deployed, and the app has never been run on a
device or built on EAS. Phases 1–5 are merged into `main` (`75d435b`). The post-merge security work, Stage 2 and the final review are uncommitted changes on `review/post-merge-security`.

| Document                                                             | What it covers                               |
| -------------------------------------------------------------------- | -------------------------------------------- |
| [README.md](../README.md) (Getting started)                          | Install, configure, migrate, run, verify     |
| [SUPABASE_SETUP.md](SUPABASE_SETUP.md)                               | Which dashboard value goes where             |
| [ANDROID_APK_BUILD.md](ANDROID_APK_BUILD.md)                         | EAS APK configuration and steps              |
| [DATABASE_MIGRATION_REPORT.md](../DATABASE_MIGRATION_REPORT.md)      | Each migration, release order, rollback      |
| [CODE_REVIEW_COMPLETION_REPORT.md](CODE_REVIEW_COMPLETION_REPORT.md) | Finding-by-finding evidence                  |
| [CODE_REVIEW_FIX_TRACKER.md](../CODE_REVIEW_FIX_TRACKER.md)          | Status tracker and manual actions            |
| [MAINTENANCE.md](MAINTENANCE.md)                                     | Scheduled maintenance task                   |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)                         | What is missing, and why                     |
| [openapi.yaml](openapi.yaml)                                         | API contract, with unbuilt operations marked |

## Setup

1. **Install, configure, migrate, run and verify:** follow Getting started in the
   [README](../README.md#getting-started). Node 20.9 or later (CI uses 22), pnpm 11.21.0.
2. **Check before migrating:** `pnpm --filter @nikahmate/api migrate:status` names the target host
   and the pending files. Nothing migrates automatically; `migrate` is only run by hand.
3. **Staff console:** it is the `/admin` route of the Expo web build.
   - The build uses single-page output, so the host must send unknown paths to `index.html`.
   - Add the console's origin to `CORS_ALLOWED_ORIGINS` on the API.
   - Staff sign in through the normal sign-in screen, then open `/admin`.
   - An operator creates each staff row by SQL (see the migration report, §0029). Staff then
     enrol an authenticator app in the console, which needs Supabase Auth MFA enabled.
4. **Maintenance task:** see [MAINTENANCE.md](MAINTENANCE.md). It only counts unless given
   `--apply`, and needs a scheduler.
5. **APK:** see [ANDROID_APK_BUILD.md](ANDROID_APK_BUILD.md).

## Environment files

Two examples, both free of values. A test keeps each in step with what the code reads.

| File                        | Trust level                    | Notes                                                             |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `services/api/.env.example` | **Server secrets**             | `DATABASE_URL` above all. Never reaches a device or browser.      |
| `apps/mobile/.env.example`  | **Public**, shipped in the app | For local runs. EAS builds use EAS environment variables instead. |

The API refuses to start if `SUPABASE_SERVICE_ROLE_KEY` is set. All real `.env` files,
including `services/api/.env.local-demo`, are gitignored.

## Review findings (38)

| Class                                    | Count | Items                                                          |
| ---------------------------------------- | ----- | -------------------------------------------------------------- |
| **Fixed and verified locally**           | 10    | B8, B9, B10, B11, B14, B15, B20, B21, B22, B23                 |
| **Fixed in code; needs hosted Supabase** | 14    | B1, B3, B4, B5, B6, B12, B13, B16, B17, B18, B19, B24, B25, L9 |
| **Fixed in code; needs a device**        | 2     | B2, L4                                                         |
| **Partially fixed**                      | 9     | B7, B26, L1, L3, L6, L7, L8, L10, L11                          |
| **Pending: not started**                 | 1     | L12                                                            |
| **Pending: company decision**            | 2     | L2, L5                                                         |

**Verified end to end on a real environment: 0 of 38.**

What each partial item still needs:

| Item | Still needed                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------- |
| B7   | Supabase Dashboard: remove `public` from exposed schemas, check `pg_graphql`; apply 0026, 0027, 0032 |
| B26  | A scheduler for the maintenance task; apply 0029 and 0030                                            |
| L1   | Hosted MFA, staff accounts and console hosting. Cases, PII access log and `restrict` are not built   |
| L3   | Real Storage verification. Discovery cards show no photo; no grant-revocation endpoint               |
| L6   | Supervised view, quorum, SLA scheduler, delegate-only accounts (decision)                            |
| L7   | Deletion execution, data export, public deletion page, store policies                                |
| L8   | Push provider and delivery; quiet hours at send time                                                 |
| L10  | 18 operations, each blocked (see below)                                                              |
| L11  | A job runner (dependency approval) and a scheduler                                                   |

## Migrations

34 files, numbered 0001–0034 with no gaps, and timestamps strictly ascending. Every test
suite applies them all, in order, to real Postgres (PGlite). **None of 0026–0034 has been
applied to a hosted database**, and none is on GitHub `main` until the review branch is
merged.

`migrate` applies **every** pending file in the checkout, so choose the path that fits the
database:

- **New, empty project with no live users:** one `migrate` run applies all 31 from the final code.
  Then deploy the API and run `verify:db`.
- **Existing project on `6c67581` (through 0025) with live users:** release in this order,
  **0026 → Phase 1 API → 0027 → 0028 to 0033 → current API → 0034.** Commits `d74a3f3`
  (with 0026) and `0de536f` (0027 only) exist so `migrate` can run from each in turn. Follow "Exact
  order" in the migration report, including its pre-flight query.

That procedure is written for the **development** project. No migration process has been approved
for staging or production; the company must decide one. `verify:db` includes a Storage policy
check that is only meaningful on Supabase: elsewhere it reports "verify on the hosted project".

## Test results

| Check                             | Result                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Full test suite                   | **2,473 passed, 0 failed** (domain 254, db 622, api-client 45, i18n 14, api 1283, mobile 255) |
| Typecheck, lint, formatting       | Clean                                                                                         |
| Android JavaScript bundle         | `expo export --platform android` succeeds                                                     |
| Android native project generation | `expo prebuild` succeeds; output removed                                                      |
| Web build (includes `/admin`)     | `expo export --platform web` succeeds                                                         |
| Lockfile                          | In sync with every `package.json`                                                             |
| Secret scan                       | No keys or credentials in tracked or new files                                                |
| Phase 5 mutation checks           | Every leak-relevant break caught; files restored                                              |
| Notification regression           | Every database notification type parses in the inbox and has English text                     |
| `eas.json` schema                 | Valid against EAS's own validator; no login or build involved                                 |

**Not run, and not claimed:** hosted migrations; live `verify:db`; real Supabase Storage or
Auth MFA; a Gradle or EAS build; any device; a browser click-through of the photo upload and
restricted-account screens in the final round (both were covered earlier or by tests); concurrency on multi-connection Postgres; a fresh-clone install; component tests (no tooling
exists without new dev dependencies).

## Blockers needing company credentials or access

| Blocker                      | Needs                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted database verification | A reachable Supabase project (the local `.env` project does not resolve). Apply 0026–0034, in the order in `docs/PRODUCTION_SECURITY.md`, run `verify:db`                                                                                        |
| B7, B18                      | Supabase Dashboard: remove `public` from exposed schemas; add `nikahmate://auth/callback` and the web callback URL                                                                                                                               |
| L1 console use               | Supabase Auth MFA enabled; first staff row inserted by an operator (SQL in the migration report)                                                                                                                                                 |
| L3 photos                    | Real Storage, using the three-step check in the migration report                                                                                                                                                                                 |
| APK                          | Expo account, `eas init`, API on `https://`, **approval to start a build**                                                                                                                                                                       |
| Deployment                   | API host and scheduler; approval to deploy                                                                                                                                                                                                       |
| Unbuilt operations           | Calls ×8: provider decision. SMS ×2: paid provider. Email resend and panic exit: Supabase Auth. Export: job runner and file delivery. Plans, search filters, support channel: company decisions. Suggestions and safety centre: approved content |

## Decisions for the company to confirm

1. **Photo rule (L3), as implemented in migration 0031:** a grant reveals `blurred` and
   `on_request` photos, never `private`. Setting a photo private or blocking withdraws access. A
   decline blocks a new request for 30 days. Any change must be made before 0031 is applied.
2. **Incognito (B3):** "liked" is read as "sent an interest to", as recorded in the tracker.
3. **Staff reasons (L1):** the server requires a reason on rejections. The console also
   requires a note on every decision; the API does not enforce that note on approvals.

## Security advisories

`pnpm audit` on 6 November 2026, after the Zod fix: 40 advisories (3 critical, 10 high, 17 moderate, 10 low), the same total as before because the Zod advisory is still counted once for `zod` 3.25.76.

**Fixed: Zod, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high).**
`services/api`, `packages/domain` and `packages/api-client` moved from 4.6.5 to **4.6.7**, with a
minimum of `^4.6.6`. No source code changed. The tarball's hash, npm signature and SLSA provenance
were verified, and its code was compared with 4.6.5.

- **What changed:** 4.6.6 checks a declared `.max()` before parsing elements. A 1 MiB body against a
  bounded array went from 524,279 issues and about 180 MB of heap to 1 issue and no measurable heap.
- **Rule for new code:** an array with **no** `.max()` is still parsed in full. Every array in a
  request schema must declare a bound. `collection-bounds.test.ts` in `packages/domain` and
  `services/api` covers today's request arrays; add new ones there.
- **Still reported, accepted for now:** `zod` 3.25.76 is required only by `@expo/cli@57.0.27`, so
  `pnpm audit` still lists this advisory once. It runs on development and build machines; it is not
  in the API's dependency tree, and the app bundles contain no Zod 3 code. There is no patched 3.x
  release. The registry listing for `@expo/cli` 57.0.33 and 58.1.19 shows no Zod dependency, so the
  Expo update below should remove it (confirm whether those versions bundle it). Do not force Zod 4
  on it with an override.

**Not upgraded (approval needed):**

| Package                                                                                       | Severity       | Where it runs                    | Fix                  |
| --------------------------------------------------------------------------------------------- | -------------- | -------------------------------- | -------------------- |
| `fastify` 5.12.5, `fast-uri` 3.1.8                                                            | Low, moderate  | **API**                          | 5.12.6, 3.1.9        |
| `tinypool`, `vite`, `vitest`, `@vitest/mocker`, `source-map-js`                               | Up to critical | Tests and tooling                | Needs a vitest major |
| `shell-quote`, `node-forge`, `decode-uri-component`, `glob`, `minimatch`, `uuid`, `deepmerge` | Up to critical | Through Expo; not traced further | Expo updates         |

The critical items (`tinypool`, `shell-quote`) were not traced into runtime code. Have someone
confirm the Expo-side items are build tooling only before beta.

## Known limitations

- **Notification taps.** Every type now has readable text, but tapping only navigates for interest,
  match and photo-request types. A `new_message` tap marks it read and stays on the inbox.
- **`verification_update`, `security_alert`, `stage_advance_proposed`, `family_invitation`:** text is
  ready, but no route currently creates these notifications.
- **No component or end-to-end tests** (L12). Screens have type, bundle and logic-test coverage only.
- **Tests using UTC dates.** Eight quota tests that failed from 19:00 to 24:00 UTC are fixed. Others
  still use UTC `current_date`; they passed during that window.

Everything else is in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Git state

- **`main` on GitHub:** `75d435b`, which merged Phases 1–5.
- **Not committed:** everything since, on `review/post-merge-security`, including migrations
  0032 to 0034. Nothing from it has been pushed, deployed or applied.
- **What is live has not been checked.** If the host deploys from `main`, the live API may already be
  `75d435b` rather than the reviewed `6c67581`, and it needs migrations through 0031. Check this first:
  it decides what the release starts from. The release order was tested from both.

To see what has been merged since the reviewed commit:

```bash
git diff --stat 6c67581 main
```
