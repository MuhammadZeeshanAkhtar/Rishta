# Database migration report

Forward-only migrations added during the code review remediation (review dated
28 October 2026). No migration that existed before this work has been edited.

**Rules followed:** every change is in a new file; every migration is applied in
full by the `packages/db` and `services/api` test suites against real Postgres
(PGlite); none has been applied to any hosted Supabase project as part of this
work.

**Phase 1 migrations:** 0026 and 0027, released in that order **with the API
deployed between them**. See [Deployment order](#deployment-order-phase-1).
The migration procedure documented here is **DEV ONLY**: staging and production
have no approved migration process yet (see
[Staging and production](#staging-and-production-not-configured)).

---

## 0026 — `20261101000026_review_phase1_hardening.sql` (Phase 1)

**Status:** written and tested · **not applied** to any hosted project.

0026 was edited once before release (the `messages.kind` revoke moved into
0027). That is safe only because it has never been applied anywhere: no ledger
holds its checksum. From the first time it is applied, it is frozen.

| Change                                                                        | Finding | Kind                 |
| ----------------------------------------------------------------------------- | ------- | -------------------- |
| `app.guard_family_approval()` + trigger `matches_guard_family_approval`       | B1      | new function/trigger |
| `app.has_entitlement_flag(member, key)`                                       | B3      | new function         |
| `app.guard_incognito_entitlement()` + trigger `user_settings_guard_incognito` | B3      | new function/trigger |
| `app.discoverable_to(viewer, target)`                                         | B3      | new function         |
| `messages_body_not_blank` — body must contain a non-whitespace character      | B7      | check constraint     |
| `messages_insert_when_permitted` recreated with `kind = 'text'` and non-blank | B7      | policy               |
| `revoke insert on interests from authenticated`                               | B7      | privilege            |
| `interests_responded_consistent` — `withdrawn` may keep `responded_at`        | B4      | check constraint     |

### Behaviour changes a caller could notice

- A member can no longer insert into `interests` through the Supabase Data API.
  The application never did; it sends through the service-role path that
  consumes the quota.
- A member insert into `messages` with any `kind` other than `'text'` is refused
  by the policy. Naming `kind = 'text'` still works until 0027.
- A transition into `matches.communication_state = 'family_approved'` raises
  `check_violation` while any `family_reviews` row for the match is not
  `approved`.
- Switching `user_settings.incognito` from false to true raises
  `insufficient_privilege` without an unexpired boolean `incognito` entitlement.
  Switching it off is never refused.
- Inserting a message whose body is empty or whitespace-only raises
  `check_violation`, for every role.

### Safety for existing data

- **`messages_body_not_blank`** validates existing rows when added. The API has
  always trimmed and required at least one character, so no row should violate
  it; if one does, the migration fails and rolls back rather than half-applying.
  Pre-flight query in [Deployment order](#deployment-order-phase-1).
- **`interests_responded_consistent`** is replaced with a condition that accepts
  every row the previous one did, so it cannot fail on existing data.
- The two triggers only act on future writes.
- A member who already has `incognito = true` without an entitlement is not
  touched; `app.discoverable_to()` simply treats them as visible, and `/me`
  reports incognito as off.

---

## 0027 — `20261101000027_review_phase1_messages_kind_revoke.sql` (Phase 1)

**Status:** written and tested · **not applied** to any hosted project.

| Change                                                | Finding | Kind      |
| ----------------------------------------------------- | ------- | --------- |
| `revoke insert (kind) on messages from authenticated` | B7      | privilege |

One statement. A member insert can then not name `kind` at all and takes the
default, `'text'`.

**Why it is separate.** The API released before Phase 1 (`6c67581`) names
`kind` (as `'text'`) in its member insert. Revoking the column while that API
is serving refuses every message send. The Phase 1 API no longer names it. So
0027 must be applied **after** the Phase 1 API is live, and 0026 can be applied
**before** it.

**Defence in depth, not the primary control.** The 0026 policy already refuses
every `kind` except `'text'`. 0027 takes the column out of the member's reach,
so that a future policy change cannot reopen system notices by itself.

**Safety for existing data:** a privilege change only. Touches no rows; cannot
fail on existing data.

---

## Deployment order (Phase 1)

### Compatibility, verified by tests

Each step is pinned by `services/api/test/review-phase1-release.test.ts`, which
builds the database exactly as it stands at that step (migrations applied
through 0026 only, or through 0027) and runs the real routes against it. "Old
API" means the exact member message insert of `6c67581`, run as the member as
that API ran it. That insert is the only old-API statement whose result 0026
or 0027 changes.

| Database    | Old API (`6c67581`)             | Phase 1 API                                                                            |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| Before 0026 | works (status quo)              | **breaks**: `/me`, feed, shortlist, withdrawing a deferred interest                    |
| 0026 only   | **message send works** (tested) | **works** (tested: send, `/me`, incognito 403/200, feed, shortlist, deferred withdraw) |
| 0026 + 0027 | **message send fails** (tested) | **works** (tested: send)                                                               |

Mutation check: with the revoke put back into 0026, the old-API send under
"0026 only" fails, and so do the release-state tests.

### Exact order (DEV ONLY)

> **DEV ONLY.** Every step below runs `migrate` from a local developer
> checkout, using the `DATABASE_URL` in your local `services/api/.env`. That
> is permitted for the **development** project only. `docs/SUPABASE_SETUP.md`
> allows only development credentials in a local `.env` and forbids pointing a
> local machine at production. **Do not run staging or production migrations
> this way.** See
> [Staging and production](#staging-and-production-not-configured).

**Nothing applies migrations automatically.** The API's `start` script does
not migrate; `migrate` is only ever run by hand. `migrate` applies **every**
pending file in `supabase/migrations`. So in step 2, 0027 must not be in the
checkout you migrate from. The simplest way is to commit 0027 separately from
everything else in Phase 1:

- **Commit A:** all Phase 1 code, tests, docs and migration **0026**
- **Commit B:** migration **0027** only, on top of A

Then, against the **development** project only:

1. **Pre-flight**, read-only, against the development database:

   ```sql
   select count(*) from public.messages where body !~ '[^[:space:]]';
   ```

   Must be `0`, or step 2 fails (and rolls back cleanly).

2. **Apply 0026**, from a checkout of commit A (0027 absent):

   ```bash
   pnpm --filter @nikahmate/api migrate:status
   ```

   ```bash
   pnpm --filter @nikahmate/api migrate
   ```

   `migrate:status` must list exactly one pending migration, 0026, before you
   run `migrate`. The old API keeps working.

3. **Deploy the Phase 1 API** (commit A). Then deploy the web build of the app.
   An old web client still declares every photo as `image/jpeg`, and the Phase
   1 API refuses a PNG or WebP declared that way (R1).

4. **Smoke-test** on that environment: send a chat message; open the profile
   screen (`/me`); open Discover.

5. **Apply 0027**, from a checkout of commit B:

   ```bash
   pnpm --filter @nikahmate/api migrate:status
   ```

   ```bash
   pnpm --filter @nikahmate/api migrate
   ```

   `migrate:status` must list exactly one pending migration, 0027.

6. **Verify:**

   ```bash
   pnpm --filter @nikahmate/api verify:db
   ```

   Every check must pass. Run between steps 2 and 5, `verify:db` reports
   exactly one failure, `B7 no member INSERT on messages.kind`. That is
   expected, and it is the reminder that step 5 is outstanding.

7. Send a chat message again.

**If 0027 is applied too early** (for example `migrate` run from commit B
before step 3), message sends from the old API fail with "permission denied
for table messages" until the Phase 1 API is deployed. That is the failure the
split exists to avoid. Deploying the API ends it; no database change is
needed.

### Staging and production: not configured

There is **no approved migration process for staging or production**, and none
is configured. The repository has no deployment configuration, CI never runs
migrations, and `docs/SUPABASE_SETUP.md` defers both projects to Phase 13.

- **Do not** apply 0026 or 0027 to staging or production from a local developer
  checkout, and do not put staging or production credentials in a local
  `.env`.
- Staging and production require a **separately approved deployment/operations
  migration process**. Designing and approving it is outside Phase 1.
- Whatever process is approved must still keep the order this report depends
  on: 0026, then the Phase 1 API, then 0027.

### Temporary security implications

**Between 0026 and 0027, with either API serving:**

- A member using the Data API directly may **name** `messages.kind`, but the
  0026 policy accepts only `'text'`, which is the default anyway. A system
  notice is refused (tested: _still cannot post a system notice_). Practical
  exposure: none beyond the end state.
- Every other Phase 1 database control is already in force: the B1 trigger, the
  incognito trigger, the non-blank check, and no member `INSERT` on
  `interests`.

**Between 0026 and the API deploy, with the old API still serving** (keep it
short):

- **B1:** the old route's faulty approval now hits the trigger, so it errors
  instead of opening a conversation against a rejection. Safe, but an error
  response.
- **Incognito:** the old route never checked the entitlement, so a free member
  switching incognito on hits the trigger and gets an error response instead
  of a free paid feature. Safe. The exact status code from the old API was not
  tested.
- **Bugs that remain until the API deploy:** the remaining Phase 1 bugs stay
  exactly as they were. Pause and incognito are not yet applied to discovery
  (B3), "Maybe later" stays stuck (B4), and rate limiting is per IP (B9).
- **Data API path:** the old API's B7 behaviour does not matter here, because
  the Data API path is closed by 0026 whichever API is serving.

**The Data API itself** stays reachable until `public` is removed from the
exposed schemas in the Supabase Dashboard (manual action, B7). All of the
above holds with it exposed.

---

## What `verify:db` checks for Phase 1

`services/api/scripts/phase1-security-checks.ts`, called from `verify-db.ts`.
Every check reads the catalog for what is actually there.

| Check                                                     | Fails when                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `B1 trigger matches_guard_family_approval`                | missing; disabled; not `BEFORE UPDATE OF communication_state FOR EACH ROW`; on another column; calling another function; guard body neutered |
| `B3 trigger user_settings_guard_incognito`                | missing; disabled; not `BEFORE INSERT OR UPDATE OF incognito FOR EACH ROW`; calling another function; guard no longer checks the entitlement |
| `B7 no member INSERT on messages.kind`                    | `anon` or `authenticated` can insert `kind`: by column grant, table grant, or a grant to `PUBLIC`                                            |
| `B7 members can still insert a message`                   | `authenticated` lost INSERT on `conversation_id`, `sender_user_id` or `body` (a revoke that went too far)                                    |
| `B7 message insert policy pins text and a non-blank body` | the policy no longer pins `kind = 'text'`, a non-blank body and `can_write_message`; or any other permissive insert policy exists            |
| `B7 messages_body_not_blank`                              | missing; `NOT VALID`; a different rule                                                                                                       |
| `B7 no member INSERT on interests`                        | `anon` or `authenticated` can insert into `interests`: by table grant, any single column, or `PUBLIC`                                        |

Also, unchanged: `discoverable_to` and `has_entitlement_flag` must exist as
`STABLE SECURITY DEFINER`, and a table-level `interests` INSERT shows up in the
grant inventory as **UNEXPECTED**.

**Proven to fail:** `services/api/test/verify-phase1-security.test.ts` runs the
checks against a correct database (all pass), the two part-release states, and
23 deliberate single breakages. Each breakage fails exactly its own check and
no other.

**Not run against a live database.** `verify-db.ts` itself needs
`DATABASE_URL`. The development project is unreachable ("tenant not found"),
and hosted databases are out of bounds for this work. Its wiring of the new
module is covered by typecheck; the checks themselves by the test above.

---

## Rollback implications

**Today 0026 and 0027 are unapplied everywhere,** so both files can still be
corrected in place. Once a file is applied to any project, its checksum is
recorded in the ledger and the file is frozen. After that, every correction or
reversal is a new migration (0028 or later). The runner applies each migration
inside one transaction together with its ledger row, so a failure while
applying leaves nothing half-done.

**Postgres does not track what a SQL function body calls.** `drop function`
succeeds even while the API, or another function, still calls it; the failure
appears at runtime. Reverse the API first, or in the same release.

**Reversing 0027 alone** is always safe: `grant insert (kind) on
public.messages to authenticated`. It is also the fix if 0027 was applied
before the API by mistake. Deploying the API is the better fix.

| Change                                              | Reversal (in a new migration)                                                      | Data loss    | Hazard                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 trigger + `guard_family_approval()`              | `drop trigger`, `drop function`                                                    | None         | Removes only the backstop; the route still enforces B1.                                                                                                                                                                                                                                                                                                          |
| `has_entitlement_flag()`                            | `drop function`                                                                    | None         | Called by `/me`, by `discoverable_to()` and by the incognito trigger. Dropping it first breaks all three at runtime.                                                                                                                                                                                                                                             |
| Incognito trigger + `guard_incognito_entitlement()` | `drop trigger`, `drop function`                                                    | None         | Reopens free incognito through the Data API; the route still refuses it.                                                                                                                                                                                                                                                                                         |
| `discoverable_to()`                                 | `drop function`                                                                    | None         | Feed generation, feed reads and the shortlist call it; revert the API first. Reverting unhides paused and incognito members.                                                                                                                                                                                                                                     |
| 0027: `revoke insert (kind)` on `messages`          | `grant insert (kind) ... to authenticated`                                         | None         | Harmless on its own while the 0026 policy still pins `kind = 'text'`.                                                                                                                                                                                                                                                                                            |
| `messages_body_not_blank`                           | `drop constraint`                                                                  | None         | **Applying** fails, and rolls back cleanly, if any existing row is empty or whitespace-only (pre-flight query above). ⁵                                                                                                                                                                                                                                          |
| `messages_insert_when_permitted` (recreated)        | Drop it and recreate the previous definition from the migration that introduced it | None         | The old definition does not pin `kind`; with 0027 still in force a member cannot name it anyway. Reversing both reopens system notices.                                                                                                                                                                                                                          |
| `revoke insert on interests`                        | `grant insert ... to authenticated`                                                | None         | Reopens quota-free interests through the Data API. The insert policy was kept deliberately, so forgery stays closed.                                                                                                                                                                                                                                             |
| `interests_responded_consistent` (relaxed)          | Drop it and re-add 0018's stricter form                                            | **Possible** | **Re-adding fails** if any `withdrawn` row has `responded_at` set, which is every deferred interest withdrawn after 0026. Making it pass means nulling those timestamps, erasing when the deferral happened. A data decision, not a mechanical rollback. Check: `select count(*) from public.interests where status = 'withdrawn' and responded_at is not null`. |

⁵ **Unverified edge, recorded for Phase 3.** The API checks non-blank with
JavaScript's `trim()`; the database uses the regex class `[:space:]`, whose
membership for non-ASCII characters depends on the database's locale. If the
two disagree about a character (U+0085 NEXT LINE is a likely candidate, since
`trim()` keeps it), a body the API accepts could be refused by the constraint
and surface as a 500 rather than a 400. Not established on PGlite and not
tested against hosted Supabase. Mapping `check_violation` to a 4xx belongs with
B14/B21 (Phase 3).

---

## Environment changes

| Variable                      | Default | Phase | Purpose                                                                 |
| ----------------------------- | ------- | ----- | ----------------------------------------------------------------------- |
| `RATE_LIMIT_SENDS_PER_MINUTE` | `30`    | 1     | Per-member ceiling on messages, interests, reports, family invitations. |

`RATE_LIMIT_PER_MINUTE` is unchanged in name and default; it is now genuinely
per member (B9).

**Runtime:** Node **≥ 20.9** is now required (sharp 0.35). CI runs 22.
