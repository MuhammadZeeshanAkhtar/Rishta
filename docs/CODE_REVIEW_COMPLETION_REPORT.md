# NikahMate — Code Review Completion Report

**Baseline:** _NikahMate Code Review Report_, 28 October 2026 (11 pages;
reviewed commit `6c67581`; PDF SHA-256
`ec75ef9b8fa1c753b671260511b185f4ab65eeb02a099a27ad988906d9f295c1`).

**Updated:** 5 November 2026, after Phase 5 and handover preparation. Nothing has been
verified on hosted Supabase or a device. Reconciled against the code and the test results,
not against earlier reports.

> **Superseded for current status.** This is the 5 November snapshot. The current item-by-item
> status, checked against the code on 8 November 2026, is in
> [CODE_REVIEW_FIX_TRACKER.md](../CODE_REVIEW_FIX_TRACKER.md) → _Verification against the code_.

| Where                                       | What it contains                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GitHub `main`                               | `75d435b`, which merged Phases 1–5. The review was of `6c67581`.                                              |
| Branch `review/phases-2-5-handover`, merged | Phase 1: `d74a3f3` (with 0026), `0de536f` (0027). Phases 2–5: five further commits, with migrations 0028–0031 |
| Live deployment (named in the report)       | Not checked. Carries every original finding if it still runs `6c67581`                                        |
| Hosted Supabase                             | none reachable; **no migration has been applied anywhere**                                                    |

---

## 1. Executive summary

Of the 38 items in the manager's report:

| Status                           | Count  | Items                                                          |
| -------------------------------- | ------ | -------------------------------------------------------------- |
| **FULLY FIXED LOCALLY**          | **10** | B8, B9, B10, B11, B14, B15, B20, B21, B22, B23                 |
| **AWAITING SUPABASE**            | **14** | B1, B3, B4, B5, B6, B12, B13, B16, B17, B18, B19, B24, B25, L9 |
| **AWAITING DEVICE VERIFICATION** | **2**  | B2, L4                                                         |
| **PARTIALLY FIXED**              | **9**  | B7, B26, L1, L3, L6, L7, L8, L10, L11                          |
| **NOT FIXED**                    | **1**  | L12                                                            |
| **BLOCKED BY COMPANY DECISION**  | **2**  | L2, L5                                                         |

- **Every one of the 26 bugs now has its fix written in code.** 10 are
  verified completely in local tests; 13 are code-complete but depend on a
  hosted Supabase database, Storage or Dashboard setting to be verified; 1 needs
  a device; 2 (B7, B26) also need an external setting or a scheduler.
- **Limitations** are mostly product areas: 2 need company decisions (L2, L5); 1 is not
  started (L12); 7 are partly delivered (L1, L3, L6, L7, L8, L10, L11); L4 awaits a device;
  L9 awaits Supabase.
- **Phases 4–5:** every OpenAPI operation that can be built without a company decision or
  an external service now is. 18 remain, each marked `x-status: not-implemented` with its
  blocker. A test holds the document and the running routes to each other in both directions.
- **Verified end to end on a real environment: 0 of 38.**

**Completion, by stated rule:**

| Measure                                                                          | Count   | Share     |
| -------------------------------------------------------------------------------- | ------- | --------- |
| Genuinely verified (FULLY FIXED LOCALLY: no external dependency, tests prove it) | 10 / 38 | **26.3%** |
| Code-complete (above + AWAITING SUPABASE + AWAITING DEVICE)                      | 26 / 38 | 68.4%     |
| Touched at all (adds PARTIALLY FIXED)                                            | 35 / 38 | 92.1%     |
| Bugs code-complete (excluding B7 and B26, which also need external steps)        | 24 / 26 | 92.3%     |
| Verified on hosted Supabase or a device                                          | 0 / 38  | 0%        |

Partially fixed and unverified work is **not** counted as complete.

---

## 2. Status definitions

- **FULLY FIXED LOCALLY** — the manager's fix is implemented; nothing in it
  depends on an unapplied migration, hosted Storage, a Dashboard setting or a
  device; regression tests prove it (most shown to fail without the fix).
- **AWAITING SUPABASE** — code-complete and passing every local (PGlite)
  test, but correctness depends on migrations 0026–0031, real Supabase Storage,
  a Supabase Dashboard setting, or real multi-connection Postgres.
- **AWAITING DEVICE VERIFICATION** — server side tested; the app behaviour has
  been type-checked and bundled, never exercised on a device.
- **PARTIALLY FIXED** — some of the manager's fix is done; the rest is listed.
- **NOT FIXED** — not started.
- **BLOCKED BY COMPANY DECISION** — cannot be specified without one.

---

## 3. Bugs B1–B26

| ID  | Finding                                                     | Status                       | What was implemented (files)                                                                                                                                                                                                                                           | Tests (all passing locally)                                                                                                                                             | Remaining / needs                                                                                                           |
| --- | ----------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B1  | One family's approval overrides a rejection                 | AWAITING SUPABASE            | Route requires every review approved, 409 unless `pending_family_review`, row locks (`routes/family.ts`); trigger `matches_guard_family_approval` (0026); review R2 liveness filters                                                                                   | `review-phase1.test.ts`, `review-phase1-rls.test.ts`, `verify-phase1-security.test.ts`                                                                                  | Apply 0026; `verify:db`; two-approvals race on real Postgres                                                                |
| B2  | Family invitation cannot be accepted                        | AWAITING DEVICE VERIFICATION | Join link + Share (`family/invite.tsx`), Join screen (`family/join.tsx`), `FamilyInviteLinkHandler`, `packages/domain/src/family-invite.ts`                                                                                                                            | API end-to-end in `review-phase2.test.ts`; `family-invite.test.ts` (19); `pendingInviteStore.test.ts` (10)                                                              | Click-through on device/web; email/SMS delivery (needs provider); universal links (needs domain)                            |
| B3  | Pause / Incognito never applied                             | AWAITING SUPABASE            | `app.discoverable_to`, `has_entitlement_flag`, incognito trigger (0026); feed, shortlist, `/me`                                                                                                                                                                        | `review-phase1*.test.ts`                                                                                                                                                | Apply 0026; company to confirm the incognito interpretation                                                                 |
| B4  | "Maybe later" freezes an interest                           | AWAITING SUPABASE            | Respond/withdraw accept `maybe_later` (`routes/interests.ts`); app buttons; constraint (0026)                                                                                                                                                                          | `review-phase1.test.ts` (B4)                                                                                                                                            | Apply 0026                                                                                                                  |
| B5  | Photos auto-approved; re-finalize re-approves               | AWAITING SUPABASE            | Finalize only once, only from pending (409); verdict `review`, photo stays pending (`routes/photos.ts`); moderator approve/reject (`routes/admin.ts`); tables (0029)                                                                                                   | `review-phase3.test.ts` (B5, L1 photo decisions); `photos.test.ts` updated; mutation: guard removed → test fails                                                        | Apply 0029; Storage moderator read policy (only verifiable on Supabase); automated screening is a company/provider decision |
| B6  | Profiles auto-approved; edits not re-reviewed; DOB editable | AWAITING SUPABASE            | Auto-approval stub removed (`routes/profile.ts`); re-review triggers on text edits and rename; DOB lock trigger; correction workflow: `POST/GET /me/dob-correction-requests` (`routes/account.ts`), support decision `POST /admin/dob-corrections/:id`, audited (0029) | `review-phase3.test.ts` (B6), `review-phase3-rls.test.ts` (25), `verify-phase3-moderation.test.ts` (15); the rename test found and fixed a SECURITY DEFINER bug in 0029 | Apply 0029; member screen and staff queue built in Phase 5, not yet run on a device                                         |
| B7  | Data API bypass                                             | PARTIALLY FIXED              | Message kind/blank policy, interests INSERT revoked (0026); `messages.kind` revoked (0027)                                                                                                                                                                             | `review-phase1-rls.test.ts`, `verify-phase1-security.test.ts`                                                                                                           | **Supabase Dashboard: remove `public` from exposed schemas** (and check `graphql_public`); apply 0026/0027                  |
| B8  | Vulnerable sharp                                            | FULLY FIXED LOCALLY          | sharp 0.35.5; strict decode; declared = decoded; client sends real MIME (`variants.ts`, `media.ts`, `PhotoManager.tsx`)                                                                                                                                                | `photos.test.ts`, `media.test.ts`                                                                                                                                       | Deploy on Node ≥ 20.9                                                                                                       |
| B9  | Rate limit per IP                                           | FULLY FIXED LOCALLY          | Keyed on verified subject; per-member send ceiling (`app.ts`, `auth/plugin.ts`)                                                                                                                                                                                        | `review-phase1.test.ts` (B9)                                                                                                                                            | —                                                                                                                           |
| B10 | Pagination repeats/skips                                    | FULLY FIXED LOCALLY          | Keyset cursors on `(created_at, id)` / `(activity, id)` (`http/cursor.ts`, `routes/conversations.ts`)                                                                                                                                                                  | `review-phase3.test.ts` (B10: no repeats after new messages; list pages without repeats; old cursors refused); `review-phase3-units.test.ts`                            | A thread that gets a message while the list is paged shows at the top on refresh (inherent to activity order)               |
| B11 | Abandoned uploads hold slots                                | FULLY FIXED LOCALLY          | Expire unfinalized uploads past the URL TTL and remove their bytes; count finalized + live uploads (`routes/photos.ts`)                                                                                                                                                | `review-phase3.test.ts` (B11); mutation: expiry removed → test fails                                                                                                    | — (the count clause is defence in depth: with the expiry it is redundant)                                                   |
| B12 | Original keeps EXIF/GPS                                     | AWAITING SUPABASE            | Original re-encoded without metadata and overwritten at finalize (`variants.ts` `stripOriginal`, `routes/photos.ts`)                                                                                                                                                   | `review-phase3.test.ts` (B12: EXIF present before, absent after)                                                                                                        | Overwrite-in-place verified only against the in-memory Storage double; real Supabase Storage (`x-upsert`) unverified        |
| B13 | Unapproved photo can be primary                             | AWAITING SUPABASE            | Route: approved-only, validated before clearing (409); constraint `photos_primary_approved` (0029)                                                                                                                                                                     | `review-phase3.test.ts` (B13), `review-phase3-rls.test.ts`; mutation: route check removed → test fails                                                                  | Apply 0029                                                                                                                  |
| B14 | Malformed ids → 500                                         | FULLY FIXED LOCALLY          | One uuid helper on every path param (`http/params.ts`, 8 route files); Postgres 22P02/23505/23514/42501 → 400/409/403 (`http/problems.ts`, `app.ts`)                                                                                                                   | `review-phase3.test.ts` (8 routes → 400; nil uuid → 404), `review-phase3-units.test.ts`                                                                                 | —                                                                                                                           |
| B15 | Storage error detail leaked                                 | FULLY FIXED LOCALLY          | Upstream text moved to the logged `cause`; 5xx ApiErrors logged and reported (`storage/client.ts`, `errors.ts`, `app.ts`)                                                                                                                                              | `review-phase3-units.test.ts` (B15)                                                                                                                                     | —                                                                                                                           |
| B16 | Stage proposal after block/unmatch/revoke                   | AWAITING SUPABASE            | Respond writability checks; cancellation triggers (0028)                                                                                                                                                                                                               | `review-phase2.test.ts`, `review-phase2-rls.test.ts`, `verify-phase2-safety.test.ts`                                                                                    | Apply 0028; race on real Postgres                                                                                           |
| B17 | Double Accept duplicates events                             | AWAITING SUPABASE            | `for update` + conditional update (`routes/interests.ts`)                                                                                                                                                                                                              | `review-phase1.test.ts` (B17)                                                                                                                                           | Prove the race on real multi-connection Postgres                                                                            |
| B18 | Email links hard-wired / PKCE                               | AWAITING SUPABASE            | `redirectTo` per platform via `Linking.createURL` (`apps/mobile/src/api/client.ts`); cross-device PKCE failure reported as `link_other_device` with its own message (`api-client/src/errors.ts`, i18n)                                                                 | `errors.test.ts` (api-client)                                                                                                                                           | **Supabase Dashboard: register web and app redirect URLs**; device/browser check; optional `token_hash` template            |
| B19 | Concurrent first sign-ins 500                               | AWAITING SUPABASE            | Bootstrap serialised per auth identity with a transaction advisory lock (`routes/account.ts`)                                                                                                                                                                          | `review-phase3.test.ts` (B19: second call returns the same account)                                                                                                     | The race itself needs real multi-connection Postgres (PGlite cannot run two transactions at once)                           |
| B20 | Verification timestamps exposed                             | FULLY FIXED LOCALLY          | Cards and public profile return badge keys, `earnedAt: null` (`discovery/cards.ts`, `routes/public-profile.ts`)                                                                                                                                                        | `review-phase3.test.ts` (B20)                                                                                                                                           | —                                                                                                                           |
| B21 | Every 4xx `validation_failed`                               | FULLY FIXED LOCALLY          | `payload_too_large`, `unsupported_media_type`, `malformed_request`, status-specific codes (`http/problems.ts`, `domain/constants.ts`, client 413/415)                                                                                                                  | `review-phase3.test.ts` (413/400/415), units                                                                                                                            | —                                                                                                                           |
| B22 | `PATCH /me` update without WHERE                            | FULLY FIXED LOCALLY          | `where user_id = app.current_user_id()` (`routes/account.ts`)                                                                                                                                                                                                          | `review-phase3.test.ts` (B22) — note: RLS already confined it, so no test can fail without the clause; this is defence in depth                                         | —                                                                                                                           |
| B23 | Quota resets at UTC                                         | FULLY FIXED LOCALLY          | Counter day = sender's timezone, UTC fallback for unknown zones (`routes/interests.ts`)                                                                                                                                                                                | `review-phase3.test.ts` (B23: UTC+14 and invalid zone)                                                                                                                  | —                                                                                                                           |
| B24 | Some users cannot be blocked                                | AWAITING SUPABASE            | `can_view_profile OR has_interacted_with` (0028); Block in chat header                                                                                                                                                                                                 | `review-phase2*.test.ts`                                                                                                                                                | Apply 0028; chat button on device                                                                                           |
| B25 | Leaving is one-sided                                        | AWAITING SUPABASE            | Closed for both (0028); `counterpart_left`; no notifications to leavers                                                                                                                                                                                                | `review-phase2*.test.ts`                                                                                                                                                | Apply 0028; closed state on device                                                                                          |
| B26 | Noisy logs, unbounded tables                                | PARTIALLY FIXED              | Service-role trace at debug only; one `new_message` notification per conversation with a count; 12-month retention function (0029) + `pnpm --filter @nikahmate/api maintenance`; Phase 4: dry-run default, lock, idempotent, more retention (0030)                     | `review-phase3.test.ts` (B26), `review-phase3-rls.test.ts`, units                                                                                                       | Apply 0029/0030; **schedule the maintenance task** (infrastructure; `docs/MAINTENANCE.md`)                                  |

## 4. Limitations L1–L12

| ID  | Limitation                   | Status                       | What exists now                                                                                                                                                                                                                                                                                                              | Remaining / needs                                                                                                                                                                                                                                                             |
| --- | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | No admin panel or moderation | PARTIALLY FIXED              | Moderation backend (0029) plus the staff console at `/admin` (Phase 5): photo, profile, report and DOB queues; decisions with required reasons; warn/suspend/ban/clear; member history; audit log; second-factor enrolment and verification                                                                                  | Apply 0029; Supabase Auth MFA enabled; first staff accounts; hosting; run the console against a real backend. Cases, PII access log, `restrict` semantics and automatic suspension expiry are not built                                                                       |
| L2  | Calls, voice, media          | BLOCKED BY COMPANY DECISION  | —                                                                                                                                                                                                                                                                                                                            | Transport/provider decision                                                                                                                                                                                                                                                   |
| L3  | Others' photos never appear  | PARTIALLY FIXED              | Migration 0031: photo requests and grants, one visibility rule shared by the API and a Storage policy. `GET /profiles/{id}/photos`, request, list, respond. Profile gallery and photo-requests screen (Phase 5)                                                                                                              | Apply 0031; **verify on real Supabase Storage**; device check. Discovery cards still show no photo; no grant-revocation endpoint (setting a photo private or blocking withdraws access). Rule interpretation for the company to confirm: `DATABASE_MIGRATION_REPORT.md` §0031 |
| L4  | No public profile endpoint   | AWAITING DEVICE VERIFICATION | `GET /profiles/{userId}` (Phase 3) and the real profile screen (Phase 5): only returned fields, one "unavailable" state for 404, withheld-field count                                                                                                                                                                        | Run on a device or browser against a real backend                                                                                                                                                                                                                             |
| L5  | Proposal journey, AI         | BLOCKED BY COMPANY DECISION  | —                                                                                                                                                                                                                                                                                                                            | Scope decision (ADR 0006 keeps AI out of v1)                                                                                                                                                                                                                                  |
| L6  | Family / Wali partial        | PARTIALLY FIXED              | B2 invitation flow; B1/R2 review fixes                                                                                                                                                                                                                                                                                       | Supervised view, quorum, SLA scheduler, delegate-only accounts (decision)                                                                                                                                                                                                     |
| L7  | Play Store blockers          | PARTIALLY FIXED              | Account lifecycle API (Phase 4, 0030): `POST /me/deactivate`, `/me/reactivate` (only active↔deactivated; a suspended member cannot pass through), `POST/DELETE /me/delete` (30-day grace, retention hold for open reports or suspension, cancel restores the previous status) — `review-phase4.test.ts`                      | Deletion **execution** (Supabase Auth admin API + job runner); `/me/export` (job runner + file delivery); public deletion web page; EAS; store policies                                                                                                                       |
| L8  | No push notifications        | PARTIALLY FIXED              | Push-token registration/unregistration; per-type notification preferences + quiet hours; in-app OFF enforced by a database trigger for every writer; device revoke invalidates the token (Phase 4, 0030)                                                                                                                     | Push **delivery** (provider decision); quiet hours applied at send time; devices                                                                                                                                                                                              |
| L9  | Contact details in notes     | AWAITING SUPABASE            | Strict filter (`contact-details.ts`), enforced in `POST /interests`                                                                                                                                                                                                                                                          | Apply 0026 (closes the Data API path) and the B7 Dashboard change                                                                                                                                                                                                             |
| L10 | ~42 of 95 paths unbuilt      | PARTIALLY FIXED              | 110 operations served and documented: 93 of the 111 contract operations plus 17 operational and staff routes                                                                                                                                                                                                                 | 18 operations, each blocked: calls ×8 (L2); SMS ×2; email resend; export; plans; search; suggestions; safety centre; panic exit; support contact                                                                                                                              |
| L11 | No job runner                | PARTIALLY FIXED              | `scripts/maintenance.ts`: dry run by default, `--apply`, advisory lock, per-task transaction + timeout, JSON logs, exit codes; notification/security-event/profile-view retention, family-invitation expiry; deletion-past-grace and abandoned-upload counts reported only. `docs/MAINTENANCE.md`; `maintenance.test.ts` (8) | A runner (pg-boss, needs dependency approval) for timed work (deletion execution, SLA sweeps, suspension expiry, push); a scheduler (infrastructure); apply 0029/0030                                                                                                         |
| L12 | Testing gaps                 | NOT FIXED                    | Regression suite 1,133 → 1,730; verify checks with deliberate breakages; first mobile unit tests                                                                                                                                                                                                                             | E2E (Playwright/Detox/Maestro), mobile component tests (need new dev dependencies), real device, load, penetration, multi-connection concurrency                                                                                                                              |

## 4a. Phase 4 — API completion (L10), OpenAPI, maintenance (L11)

### Operations built (all need migration 0030 except where noted)

| Operation(s)                                                | Rule it enforces                                                                                                               | File                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `GET /me/entitlements`, `/me/quotas`, `/me/usage`           | Plan `free`; daily interests in the member's own timezone (shared with B23)                                                    | `routes/me.ts`, `db/sql.ts`                    |
| `GET /me/verification`                                      | Booleans only, no timestamps (B20)                                                                                             | `routes/me.ts`                                 |
| `GET /me/security-events`                                   | Own events, keyset paging, country only                                                                                        | `routes/me.ts`                                 |
| `GET /me/devices`, `DELETE /me/devices/{id}`                | Own devices; revoke invalidates the push token and records `device_revoked`                                                    | `routes/me.ts`                                 |
| `POST /me/deactivate`, `/me/reactivate`                     | Only active ↔ deactivated (409 otherwise)                                                                                      | `routes/me.ts`                                 |
| `POST`/`DELETE /me/delete`                                  | 30-day grace; hold for open reports or suspension; cancel restores the previous status                                         | `routes/me.ts`                                 |
| `GET`/`PUT /me/notification-preferences`                    | All 15 types; security alerts cannot be silenced in-app; trigger enforces in-app OFF                                           | `routes/me.ts`, 0030                           |
| `POST /me/push-tokens`, `DELETE /me/push-tokens/{deviceId}` | Upsert per device; unregister idempotent                                                                                       | `routes/me.ts`                                 |
| `PATCH /me/preferences`, `GET /me/preferences/impact`       | PATCH shares PUT's validation; impact runs discovery's own eligibility filter, capped at 1,000 (no 0030 needed)                | `routes/profile.ts`, `discovery/candidates.ts` |
| `GET /me/profile/preview?as=`                               | The same projection other members get, per relationship (no 0030 needed)                                                       | `routes/public-profile.ts`                     |
| `POST /profiles/{id}/view`, `GET /me/profile-views`         | Only viewable profiles; 30-minute dedupe; `who_viewed_me` entitlement; incognito viewers excluded                              | `routes/public-profile.ts`                     |
| `GET`/`POST /matches/{id}/family-review`                    | Own side in full, counterpart bare; re-request (R16) only after own family's decline or SLA stall, never over the other family | `routes/matches.ts`                            |
| `POST /compatibility/recompute`                             | One per minute (429 + `retryAfterSeconds`); runs in-request (no queue exists) (no 0030 needed)                                 | `routes/discovery.ts`                          |

Tests: `services/api/test/review-phase4.test.ts` (30), `packages/db/src/review-phase4-rls.test.ts` (13). Guard tests that
asserted these endpoints did not exist were converted to positive assertions, not deleted. Service-role uses added and
documented in `docs/SERVICE_ROLE_USAGE.md`: `account.lifecycle`, `notifications.push_tokens`, `profile.record_view`,
`profile.read_views`, `family.match_review`.

### Operations not built — exact blockers

| Operation(s)                                                              | Blocked by                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/family/calls*` (8)                                                      | L2: call transport/provider — company decision                              |
| `GET /profiles/{id}/photos`, photo requests (3)                           | L3: Storage read policies for granted viewers — verifiable only on Supabase |
| `POST /me/verification/phone/start`, `/confirm`                           | SMS provider (paid) — company decision                                      |
| `POST /me/verification/email/resend`                                      | Supabase Auth (client-side call or Auth admin API) — not decided            |
| `POST /me/export`                                                         | Job runner + secure file delivery (L11)                                     |
| `GET /plans`                                                              | Plans/billing — company decision                                            |
| `POST /discovery/search`                                                  | Which filters are entitlement-gated — company decision                      |
| `GET /conversations/{id}/suggestions`, `GET /safety/center`               | Company-approved content                                                    |
| `POST /safety/panic-exit`                                                 | Ending all sessions needs the Supabase Auth admin API                       |
| `POST /support/contact`                                                   | Support channel and storage — company decision                              |
| Deletion execution; ending a revoked device's Auth session; push delivery | Supabase Auth admin API + job runner; push provider (L8)                    |

### OpenAPI (`docs/openapi.yaml`)

- The 15 implemented but undocumented routes are documented with request and
  response schemas, parameters, access class and error responses: `/health`;
  `GET`/`POST /me/dob-correction-requests`; `PUT /me/photos/order`;
  `POST /conversations/{id}/leave`; `GET /family/my-reviews`; the nine
  `/admin/*` operations (new `staff` access class, `Admin` tag).
- Phase 4 operations aligned with the code: `X-Device-Id` header, 409s on
  deactivate/reactivate, recompute's real 202 body, `capped` on the impact
  result, 400/404s that the routes return, honest notes on what is not built
  (deletion execution, push delivery, Auth session revocation).
- The 22 unbuilt operations carry `x-status: not-implemented` and
  `x-blocked-by`. The header no longer says "nothing is implemented"; the
  server URL no longer claims a `/v1` prefix the server does not have;
  `Problem.code` lists exactly the codes the server emits.
- **Validation:** `services/api/test/openapi-contract.test.ts` (10) — every
  registered Fastify route is documented and every documented operation not
  marked is served; marked ones are not served; operationIds unique; every
  `$ref` resolves; every path placeholder declared; every operation has a 2xx
  and every authenticated one a 401; `Problem.code` equals `PROBLEM_CODES`;
  every path `packages/api-client` calls is served (client compatibility).
  Four deliberate breakages of the document each failed the test; restored
  byte-identical. It is a line-based reader of this document's conventions,
  **not** a full OpenAPI schema validator (no YAML parser is a direct
  dependency). A one-off parse with the `yaml` package already in the pnpm
  store found no syntax errors, 126 operations, every `$ref` resolving.
- Not done: a field-by-field audit of the request/response schemas of the 89
  operations built before Phase 4 against their handlers. There is no
  generated client; `packages/api-client` is hand-written.

### Other fixes

- Timestamps in the admin queues and `/me/dob-correction-requests` now use
  `isoTimestamp()` like every other route. **Consistency, not a wire bug:**
  node-postgres and PGlite both return `Date` objects that already serialised
  as RFC 3339. Assertions added to `review-phase3.test.ts`.
- `verify:db` gains the Phase 4 checks (`scripts/phase4-account-checks.ts`,
  `test/verify-phase4-account.test.ts`, 12).

## 4b. Phase 5 — staff console, others' photos, profile screen, DOB correction

| Item   | Implemented                                                                                                                                                                                                                    | API                                                                                                                 | Tests                                                                                                                                                     | Remaining                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **L1** | `app/admin/*` and `src/admin/*`, inside the existing Expo web build (no new framework). Access is decided by the API; the app holds no service-role credential. An expired session or missing role returns to the right screen | Phase 3 `/admin/*`; new `GET /admin/session`, `GET /admin/audit`. Rejections now require a reason on the server too | `review-phase5.test.ts`, `adminAccess.test.ts`, `phase5.test.ts`                                                                                          | Hosted MFA and Storage moderator policy; real-backend run; hosting |
| **L3** | Migration 0031; `routes/photo-access.ts`; `src/photos/*`; `app/(app)/photo-requests.tsx`                                                                                                                                       | Four contract operations, now served                                                                                | `review-phase5.test.ts` (with a Storage double applying the policies), `review-phase5-rls.test.ts`, `verify-phase5-photos.test.ts`, `photoAccess.test.ts` | Real Storage; device; discovery-card photos                        |
| **L4** | `app/(app)/profile/[userId].tsx`, `src/profile/publicProfileView.ts`                                                                                                                                                           | `GET /profiles/{userId}`; records views through the existing endpoint                                               | `publicProfileView.test.ts`, API suites                                                                                                                   | Device                                                             |
| **B6** | `app/(app)/dob-correction.tsx`, `src/account/dobCorrection.ts`; staff queue `app/admin/dob.tsx`                                                                                                                                | `GET`/`POST /me/dob-correction-requests`                                                                            | `dobCorrection.test.ts`, API suites                                                                                                                       | Apply 0029; device                                                 |

**Screens have type, bundle and logic-test coverage only.** The repository has no component
test tooling (it would need new dev dependencies), and no screen has been clicked through
against a real backend.

**Defects found during final verification, fixed:** (1) `review-phase5-rls.test.ts` had a
broken fixture, so all 22 tests were being skipped; they now run and pass. (2) Eight quota
tests compared against UTC's date while the server correctly counts the member's own day
(B23), so they failed from 19:00 to 24:00 UTC; they now read the member's day. (3) The
profile button said "Interest sent" when the interest had come from the other member.

**Notification text and inbox, fixed at final cleanup:** every notification type now has English
text. The shared schema also lacked the three `family_review_*` types the database accepts, so one
such row made the client refuse the member's whole inbox; `notification-catalog.test.ts` now proves
each type parses and has text. Tapping still navigates only for interest, match and photo-request
types.

---

## 5. Migrations and release order

Six migrations, none applied anywhere: **0026 → Phase 1 API → 0027 → 0028 + 0029 + 0030 +
0031 → Phases 2–5 API.** Details, compatibility windows and rollback in
`DATABASE_MIGRATION_REPORT.md`. Every migration is applied by every local test
suite (PGlite, real Postgres); the Storage policy in 0029 is a no-op there and
is verifiable only on Supabase. 0030 is additive (four tables, one trigger,
four functions) and changes nothing existing; so is 0031, whose Storage policy runs only on Supabase.

## 6. Dependencies and operations

`pnpm audit` on 6 November 2026: 40 advisories (3 critical, 10 high, 17 moderate, 10 low), the same total as before because the Zod advisory is still counted once for `zod` 3.25.76. **Runtime `zod` was upgraded from 4.6.5 to 4.6.7 (GHSA-mrhx-c7xc-m3w5, fixed in 4.6.6)**, with regression tests. The advisory is still reported once, for `zod` 3.25.76 in `@expo/cli`, which is development and build tooling. Other dependencies were not upgraded. Details are in `docs/HANDOVER.md`.

Operations recommendations (build step/Dockerfile, deploy pipeline, Supabase
Pro + PITR, staging/production separation, mobile crash reporting, email
settings, CSP, Fastify deprecation) are unchanged: not done or not verifiable
without infrastructure access.

## 7. Verification evidence (local, 5 November 2026)

| Check                                          | Result                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full test suite                                | **1,730 passed, 0 failed** — domain 254, db 514, api-client 40, i18n 14, api 850, mobile 58                                                                                                |
| Phase 4 API (`review-phase4.test.ts`)          | 30                                                                                                                                                                                         |
| Phase 4 database (`review-phase4-rls.test.ts`) | 13                                                                                                                                                                                         |
| Maintenance (`maintenance.test.ts`)            | 8 (dry run, apply, idempotent, report-only, lock skip, failure isolation)                                                                                                                  |
| OpenAPI contract (`openapi-contract.test.ts`)  | 10                                                                                                                                                                                         |
| Phase 3 API (`review-phase3.test.ts`)          | 43                                                                                                                                                                                         |
| Phase 3 database (`review-phase3-rls.test.ts`) | 25                                                                                                                                                                                         |
| Phase 3 units (`review-phase3-units.test.ts`)  | 23                                                                                                                                                                                         |
| Phase 1/2/3/4/5 verify checks                  | 26 / 20 / 15 / 12 / 9 (each includes deliberate breakages, each caught)                                                                                                                    |
| Mutation checks (Phase 3)                      | B5 guard, B11 expiry, B13 check: each removal fails its test; files restored byte-identical                                                                                                |
| Mutation checks (Phase 4)                      | reactivate guard, cancel-restores-previous-status, other-family refusal, preference trigger, invitation-expiry cutoff: each caught; restored byte-identical                                |
| Typecheck / lint / format                      | clean                                                                                                                                                                                      |
| Mobile production web export                   | succeeds                                                                                                                                                                                   |
| Phase 5 API / database                         | 11 / 22                                                                                                                                                                                    |
| Phase 5 mutation checks                        | 12 rules: 11 caught; removing the private-photo line alone changes nothing because the rule denies by default, and making a grant reach private photos was caught. Restored byte-identical |
| Android bundle, native project generation      | `expo export --platform android` and `expo prebuild` succeed. No Gradle compile (no Android SDK here), no EAS build                                                                        |
| Dependency audit                               | as section 6                                                                                                                                                                               |

**Not run, and not claimed:** migrations on any hosted database (0026–0030);
`verify:db` live; the maintenance task against any real database; Supabase Storage behaviour; any Gradle or EAS build; any device or browser click-through;
concurrency on multi-connection Postgres; anything against the live deployment.

## 8. Readiness

| Stage                   | Ready?                      | Why                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal testing        | After Supabase is connected | Apply 0026–0031 in order with the matching API, run `verify:db`, create the first staff account. **Note:** profiles and photos are no longer auto-approved — testers need a moderator to approve them (the demo seed inserts approved profiles directly). |
| Beta                    | No                          | Admin web UI, B7 Dashboard change, L3, device verification                                                                                                                                                                                                |
| Production / Play Store | No                          | All of the above, plus L7, L8, L12 and the operations items                                                                                                                                                                                               |
