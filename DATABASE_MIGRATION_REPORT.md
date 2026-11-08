# Database migration report

Forward-only migrations added during the code review remediation (review dated
28 October 2026). No migration that existed before this work has been edited.

**Rules followed:** every change is in a new file; every migration is applied in
full by the `packages/db` and `services/api` test suites against real Postgres
(PGlite); none has been applied to any hosted Supabase project as part of this
work.

**Phase 1 migrations:** 0026 and 0027, released in that order **with the API
deployed between them**. See [Deployment order](#deployment-order-phase-1).
**Phase 2 migration:** 0028, applied after Phase 1 completes and **before** the
Phase 2 API.
**Phase 3 migration:** 0029, applied after 0028 and **before** the Phases 2–3 API
(`## 0029` below). See [Deployment order (Phase 2)](#deployment-order-phase-2).
**Phase 4 migration:** 0030, applied after 0029 and **before** the Phase 4 API
(`## 0030` below).
**Phase 5 migration:** 0031, applied after 0030 and **before** the Phase 5 API
(`## 0031` below). It carries a Storage policy that only Supabase can verify.
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

**Correction (2026-11-02).** A production environment does exist outside the
repository: the manager's report names a manually deployed web app, API and
Supabase project (the live deployment and the production Supabase project). That
project is not the one in the local `.env`. When this was written it ran the reviewed commit
`6c67581`. `main` has since moved to `75d435b`, and what the host now runs, and which migrations
its database holds, have not been checked. It needs the release order in
`docs/PRODUCTION_SECURITY.md`, through an approved process once one exists, never from a laptop.

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

## 0028 — `20261101000028_review_phase2_conversation_safety.sql` (Phase 2)

**Status:** written and tested on PGlite · **not applied** to any hosted
project.

| Change                                                                                       | Finding | Kind                 |
| -------------------------------------------------------------------------------------------- | ------- | -------------------- |
| `stage_transitions_status_valid` gains `cancelled`                                           | B16     | check constraint     |
| `stage_transitions_responded_consistent`: `cancelled` has a time and **no** responder        | B16     | check constraint     |
| `app.cancel_pending_stage_proposals(conversation)`: pending → cancelled, service role only   | B16     | new function         |
| trigger `blocks_cancel_stage_proposals` (AFTER INSERT on `blocks`)                           | B16     | new function/trigger |
| trigger `matches_cancel_stage_proposals` (AFTER UPDATE OF `ended_at`, `communication_state`) | B16     | new function/trigger |
| trigger `conversation_participants_cancel_stage_proposals` (AFTER UPDATE OF `left_at`)       | B16/B25 | new function/trigger |
| one-time cancellation of proposals already stranded in closed threads                        | B16     | data backfill        |
| `app.can_write_message`: refuses a thread **anyone** has left                                | B25     | replaced function    |
| `app.has_interacted_with(target)`: caller-scoped, STABLE SECURITY DEFINER                    | B24     | new function         |

### Behaviour changes a caller could notice

- A pending stage proposal becomes `cancelled` the moment its thread closes:
  by a block (including one inserted through the Data API), an unmatch, a
  family revocation, or either participant leaving. The current stage never
  moves.
- Once either participant has left, **neither** can insert a message, through
  the API or the Data API. Decision (2026-11-01): permanent, no rejoin.
- `app.has_interacted_with` is new and changes nothing on its own; the Phase 2
  block route calls it.

### Trigger interactions (checked before writing it)

- **No recursion.** The only table these functions write is
  `stage_transitions`, which has no triggers. They watch `blocks`, `matches`
  and `conversation_participants`, none of which they write.
- **Ordering.** All three are AFTER triggers, so they see each row as left by
  every BEFORE trigger (0021's `matches_gate_new_period`, 0026's
  `matches_guard_family_approval`, the `touch` triggers), never a value one of
  those is about to change. `matches_open_conversation` (AFTER, 0025) only
  creates threads and is unaffected.
- **No inconsistent stage.** Only `status` and `responded_at` of a **pending**
  row change. `conversation_stages.current_stage` is never written.
- **Races.** Stage respond locks the pending row `FOR UPDATE`; the cancelling
  `UPDATE … where status = 'pending'` re-checks after waiting. Exactly one
  wins and the other changes nothing. Respond also re-checks
  `app.can_write_message` inside its transaction, holding the lock. (Proven by
  reasoning and by the deterministic tests; PGlite cannot run the race itself,
  see L12.)
- **Revival.** An ended match revived by setting `ended_at` back to null is not
  a closing; its proposals were cancelled when it ended. The one-pending index
  no longer holds a cancelled row, so a new proposal can be made (tested).
- **Scope.** A block cancels only conversations between that pair; an unmatch
  or revocation only that match's conversation. Answered proposals are history
  and are never touched (tested).

### Safety for existing data

- Both replaced constraints accept every row their predecessors accepted, so
  neither can fail on existing data.
- The backfill cancels only **pending** proposals in threads that are already
  closed (match ended, not in a writable state, blocked, or someone left). Open
  threads keep theirs. Tested on a database built at 0027 with real rows, then
  migrated.
- `app.can_write_message` is replaced with the same signature, so its grants and
  the message insert policy that calls it are kept.

---

## Deployment order (Phase 2)

**After Phase 1 has completed** (0026 → Phase 1 API → 0027). Then
**0028 → Phase 2 API**. The runner applies pending files in filename order, so
0028 cannot be applied before 0027 from any checkout that contains both.

### Compatibility

| Database   | Phase 1 API (`0de536f`)                                                                                                                                                                                                                                        | Phase 2 API                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Up to 0027 | works (status quo)                                                                                                                                                                                                                                             | **breaks every block**: `PUT /blocks/:id` calls `app.has_interacted_with`, which does not exist yet. Do not deploy before 0028. |
| 0028       | works, with one edge: a send into a thread the counterpart has left passes that API's route check (it does not know `counterpart_left`) and is then refused by the database, so it returns an error instead of a clean 409. Derived from the code, not tested. | **works** (every Phase 2 suite runs on it)                                                                                      |

Keep the window between applying 0028 and deploying the Phase 2 API short.

### Exact order (DEV ONLY)

The same rule as Phase 1: a local checkout, the development project only. Do
not run staging or production migrations this way (see
[Staging and production](#staging-and-production-not-configured)).

1. Phase 1 complete on dev: `migrate:status` shows 0001–0027 applied.
2. Optional, read-only: how many proposals the backfill will cancel.

   ```sql
   select count(*) from public.stage_transitions st
     join public.conversations c on c.id = st.conversation_id
     join public.matches m on m.id = c.match_id
    where st.status = 'pending'
      and (m.ended_at is not null
           or m.communication_state not in ('open', 'family_approved')
           or app.is_blocked(m.user_a_id, m.user_b_id)
           or exists (select 1 from public.conversation_participants p
                       where p.conversation_id = c.id and p.left_at is not null));
   ```

3. From a checkout of the Phase 2 commit, `migrate:status` must list exactly one
   pending migration, **0028**:

   ```bash
   pnpm --filter @nikahmate/api migrate:status
   ```

   ```bash
   pnpm --filter @nikahmate/api migrate
   ```

4. Verify. Every Phase 1 **and** Phase 2 check must pass:

   ```bash
   pnpm --filter @nikahmate/api verify:db
   ```

5. Deploy the Phase 2 API, then the web build of the app.
6. Smoke-test: open an invitation link as a second account and accept it;
   propose a stage, block from the chat header, and confirm the proposal is
   gone; leave a conversation and confirm the other side shows it closed;
   send an interest with a phone number in the note and confirm it is refused.

**Recovery.** If step 3 fails it rolls back cleanly. If the Phase 2 API
misbehaves after step 5, roll the API back to `0de536f`: it runs on 0028 with
the one edge above. Reversing 0028 itself is a new migration (below).

---

## What `verify:db` checks for Phase 2

`services/api/scripts/phase2-safety-checks.ts`, called from `verify-db.ts`,
reusing Phase 1's trigger checker.

| Check                                                                             | Fails when                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `B16 trigger blocks_cancel_stage_proposals`                                       | missing; disabled; not AFTER INSERT FOR EACH ROW; another function; its function no longer cancels       |
| `B16 trigger matches_cancel_stage_proposals`                                      | missing; disabled; not watching exactly `communication_state, ended_at`; another function; body neutered |
| `B16 trigger conversation_participants_cancel_stage_proposals`                    | missing; disabled; not AFTER UPDATE OF `left_at`; another function; body neutered                        |
| `B16 app.cancel_pending_stage_proposals cancels only, and members cannot call it` | missing; members can EXECUTE it; it touches `current_stage`; it is no longer limited to pending rows     |
| `B16 stage_transitions allows cancelled, with no responder`                       | either constraint lacks the `cancelled` branch                                                           |
| `B25 app.can_write_message refuses a thread anyone has left`                      | missing, or reverted to 0025's one-sided rule                                                            |
| `B24 app.has_interacted_with is caller-scoped and not callable by anon`           | missing; not STABLE SECURITY DEFINER; not caller-scoped; anon can EXECUTE it; authenticated cannot       |

**Proven to fail:** `services/api/test/verify-phase2-safety.test.ts`. All checks
pass on a correct database, all fail on a database from before 0028, and each of
18 single breakages fails exactly its own check. Not run against a live database
(the development project is unreachable).

---

## Rollback implications (0028)

0028 is unapplied everywhere, so it can still be corrected in place. Once
applied anywhere, every reversal is a new migration.

| Change                                          | Reversal (in a new migration)        | Data loss    | Hazard                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three cancellation triggers and their functions | `drop trigger`, `drop function`      | None         | Stage proposals outlive closed threads again; the route still refuses to accept them.                                                                                                                                        |
| `app.cancel_pending_stage_proposals`            | `drop function`, after the triggers  | None         | Dropping it first breaks every block, unmatch, revocation and leave at runtime, because the triggers call it.                                                                                                                |
| `stage_transitions` constraints                 | Drop them and re-add 0025's forms    | **Possible** | **Re-adding fails** once any row is `cancelled`: every proposal a closing cancelled, plus the backfill. Making it pass means rewriting those rows as `declined` with an invented responder. A data decision, not a rollback. |
| `app.can_write_message`                         | `create or replace` with 0025's body | None         | Reopens one-sided leaving (B25), through the Data API as well.                                                                                                                                                               |
| `app.has_interacted_with`                       | `drop function`                      | None         | The Phase 2 block route calls it: revert the API first, or every block fails.                                                                                                                                                |

---

## 0029 — `20261102000029_review_phase3_moderation.sql` (Phase 3)

**Status:** written and tested on PGlite · **not applied** to any hosted
project. Corrected once before release: its own test showed the rename
re-review trigger, written as `SECURITY DEFINER`, saw its owner as
`current_user` and never fired for members. It now runs with the caller's
rights and calls an argument-free definer helper.

| Change                                                                                                     | Finding | Kind                        |
| ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------- |
| Existing pending primaries cleared; `photos_primary_approved`                                              | B13     | data fix + check constraint |
| `app.enforce_dob_locked` + trigger `users_dob_locked`                                                      | B6      | function/trigger            |
| `app.rereview_on_profile_edit` + trigger `profiles_rereview_on_edit`                                       | B6      | function/trigger            |
| `app.send_own_profile_to_review` + `app.rereview_on_name_change` + trigger `users_rereview_on_name_change` | B6      | functions/trigger           |
| `admin_users`, `admin_role_assignments`, `admin_action_audit` (append-only trigger), `moderation_actions`  | L1      | 4 restricted tables         |
| `dob_correction_requests` + snapshot trigger, owner RLS, column INSERT grant                               | B6      | table                       |
| `app.purge_expired_notifications` (12 months, service role only)                                           | B26     | function                    |
| `app.is_active_moderator` (role + `aal2` when MFA required)                                                | L1      | function                    |
| Storage policy `photos_bucket_select_moderator` (guarded; no-op outside Supabase)                          | L1 / B5 | storage policy              |

### Behaviour changes a caller could notice

- A member cannot change their date of birth once their profile is complete —
  through the API (409 with a pointer to the correction request) or the Data
  API. The server can, through the audited correction workflow.
- A member editing their about-me, looking-for, institution or family
  background, or renaming themselves, after a review decision sends the
  profile back to `pending` — out of discovery until a moderator decides.
- Only an approved photo can be primary.
- Admin tables exist but no member can read or write them.

### Safety for existing data

- Pending photos that were primary are un-set first, so the constraint cannot
  fail on existing rows. Nothing else rewrites data.
- Triggers act on future writes only.

### Release order and compatibility

**0026 → Phase 1 API → 0027 → 0028 → 0029 → Phases 2–3 API.** 0028 and 0029
can be applied in one `migrate` run; then deploy the API immediately.

| Database   | Phase 1/2 API                                                                                                                                                                                                                                                                                                                  | Phase 3 API                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| up to 0028 | works                                                                                                                                                                                                                                                                                                                          | admin routes and `/me/dob-correction-requests` fail (tables missing); submitted profiles stay `pending` with no moderator path. **Do not deploy before 0029.** |
| 0029       | works, with edges: a DOB change after completion or a primary set on an unfinalized photo returns 500 instead of a clean 4xx (no error mapping in those versions); a member editing reviewed text goes back to `pending` and is re-approved only by resubmitting (the old stub). Derived from the code; keep the window short. | **works** (every Phase 3 suite runs on it)                                                                                                                     |

**After applying 0029, before anyone can moderate,** an operator creates the
first staff account with the service role (SQL editor on the dev project) —
there is deliberately no API for this:

```sql
insert into public.admin_users (user_id)
select user_id from public.user_auth_links where auth_user_id = '<staff auth user id>';

insert into public.admin_role_assignments (admin_user_id, role_key)
select id, 'moderator' from public.admin_users
 where user_id = (select user_id from public.user_auth_links where auth_user_id = '<staff auth user id>');
```

Staff then need **MFA enabled in Supabase Auth** (Dashboard) and must sign in
with a second factor: the API refuses an admin token that is not `aal2`.

### What `verify:db` checks for Phase 3

`services/api/scripts/phase3-moderation-checks.ts`, called from `verify-db.ts`:
the five triggers (presence, enabled, timing, columns, function, body), the
primary-photo constraint, that the rename trigger is NOT `SECURITY DEFINER`
and its helper takes no argument, that members hold no privilege on any admin
table, that the moderator predicate requires `aal2`, and that only the service
role can purge notifications. **Proven to fail:** `test/verify-phase3-moderation.test.ts`
— all pass on a correct database, all but one (vacuous) fail before 0029, and
each of 13 single breakages fails exactly its own check.

### Rollback implications (0029)

| Change                                   | Reversal                                                                   | Data loss          | Hazard                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| Triggers (DOB lock, re-review, snapshot) | `drop trigger`, `drop function`                                            | None               | Reopens B6 for members (and the Data API).                                                |
| `photos_primary_approved`                | `drop constraint`                                                          | None               | Reopens B13 at the database level; the route still refuses.                               |
| Admin tables                             | **Do not drop.** Revoke staff by setting `admin_users.status = 'disabled'` | **Yes** if dropped | `admin_action_audit` is the record of every moderation decision (ERD retention: 7 years). |
| `dob_correction_requests`                | Keep; stop the API routes instead                                          | Yes if dropped     | The history of corrections and who approved them.                                         |
| Storage moderator policy                 | `drop policy`                                                              | None               | Moderators can no longer view queued photos.                                              |
| `purge_expired_notifications`            | `drop function`                                                            | None               | Retention stops; the maintenance task then fails loudly.                                  |

---

## 0030 — `20261104000030_review_phase4_account_api.sql` (Phase 4)

**Status:** written and tested on PGlite · **not applied** to any hosted
project. Additive only: four new tables, one trigger, four functions. No
existing table, column, policy or grant is changed.

| Change                                                                                                                                                                     | Finding  | Kind                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| `notification_preferences` — owner-only RLS (forced), member SELECT/INSERT/DELETE; 15 valid types; `security_alert` cannot be silenced in-app; quiet hours both or neither | L10 / L8 | table                                |
| `app.respect_notification_preferences` + trigger `notifications_respect_preferences` (BEFORE INSERT on `notifications`: in-app OFF → no row, for every writer)             | L10      | function/trigger                     |
| `push_tokens` (one per user and device)                                                                                                                                    | L8       | restricted table (service role only) |
| `profile_views` (no self-views; source enum; two indexes)                                                                                                                  | L10      | system table (service role only)     |
| `account_deletion_requests` (one open per member; grace ≥ request; hold needs reason; `previous_status` kept for cancel)                                                   | L7 / L10 | restricted table (service role only) |
| `app.purge_expired_security_events`, `app.purge_expired_profile_views` (12 months), `app.expire_family_invitations`                                                        | L11      | functions, service role only         |

### Behaviour changes a caller could notice

- A member who turns a notification type's in-app setting off receives no
  inbox entry of that type from any path (API, Data API, service role). Before
  0030 every type was always delivered.
- Nothing else changes for an existing caller: the other tables are new and
  unreachable by members.

### Safety for existing data

- No existing row is read or rewritten by the migration. The trigger acts on
  future `notifications` inserts only, and only when a preference row exists
  (none do at release), so delivery is unchanged until a member opts out.

### Release order and compatibility

**… → 0029 → 0030 → Phase 4 API.** 0030 can be applied in the same `migrate`
run as 0028 and 0029.

| Database   | Phase 1–3 API                                                               | Phase 4 API                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| up to 0029 | works                                                                       | `/me/notification-preferences`, `/me/push-tokens`, `/me/delete`, `/profiles/{id}/view`, `/me/profile-views`, device revoke fail (tables missing). **Do not deploy before 0030.** |
| 0030       | works (the new tables are unused; the trigger is inert with no preferences) | **works** (every Phase 4 suite runs on it)                                                                                                                                       |

### What `verify:db` checks for Phase 4

`services/api/scripts/phase4-account-checks.ts`, called from `verify-db.ts`:
the trigger (presence, enabled, BEFORE INSERT FOR EACH ROW, function, body);
no member privilege on `push_tokens`, `profile_views`,
`account_deletion_requests` (and that they exist); `notification_preferences`
RLS enabled, forced, every policy scoped to the owner; the three L11 functions
present and not executable by `anon` or `authenticated`. **Proven to fail:**
`test/verify-phase4-account.test.ts` — all pass on a correct database, all
fail before 0030, and each of 10 single breakages fails exactly its own check.

### Rollback implications (0030)

| Change                                      | Reversal                                     | Data loss                         | Hazard                                                               |
| ------------------------------------------- | -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Trigger `notifications_respect_preferences` | `drop trigger`, `drop function`              | None                              | Opted-out members receive inbox entries again.                       |
| `notification_preferences`                  | Keep; stop the API routes instead            | Yes if dropped (members' choices) | —                                                                    |
| `push_tokens`                               | `drop table` is safe while push is not built | Tokens (re-registered by the app) | —                                                                    |
| `profile_views`                             | Keep                                         | Yes if dropped                    | The views are also an abuse-investigation record.                    |
| `account_deletion_requests`                 | **Do not drop**                              | **Yes**                           | Accounts in `pending_deletion` lose the status to restore on cancel. |
| L11 functions                               | `drop function`                              | None                              | The maintenance task then reports those tasks as failed (exit 1).    |

The maintenance task that calls these functions is documented in
`docs/MAINTENANCE.md`.

## 0031 — `20261105000031_review_phase5_photo_access.sql` (Phase 5)

**Status:** written and tested on PGlite · **not applied** to any hosted
project. **Its Storage policy is a no-op outside Supabase and has never run
against real Storage.** Additive: two tables, three functions, one Storage
policy. No existing table, policy or grant is changed.

| Change                                                                                                                          | Finding | Kind                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------- |
| `photo_requests` — one open request per pair, not to oneself, message 1–300 chars, answered ⇔ `responded_at`; parties read only | L3      | table (member SELECT only)              |
| `photo_grants` — owner → grantee, `photo_id` null = all eligible photos, one live grant per pair; parties read only             | L3      | table (member SELECT only)              |
| `app.has_photo_grant`, `app.photo_variant_readable` (the rule), `app.can_read_photo_object` (the rule by exact Storage path)    | L3      | functions (authenticated, service_role) |
| Storage policy `photos_bucket_select_authorised_viewer` on `storage.objects` (guarded; no-op without the storage schema)        | L3      | storage policy                          |

**The rule** (company decision 2): approved, not deleted, viewer may view the
profile (`app.can_view_profile`), and by visibility — `public`: every object;
`blurred`: the blurred file only, the rest with a grant; `on_request`: nothing
without a grant; `private`: nothing, ever, grant or not. **Interpretation
flagged for confirmation:** a grant reveals `blurred` and `on_request` photos,
never `private` ones (so setting a photo private is also how an owner
withdraws a grant), and a declined request blocks a new one for 30 days.

### Behaviour changes a caller could notice

- None for an existing caller: the tables are new and the Storage policy only
  ADDS read access, for the objects the rule allows.
- On Supabase, a signed-in member can now sign (and so download) another
  member's allowed photo objects directly from Storage — exactly the objects
  the API would return. This is the intended effect of decision 2.

### Safety for existing data

- No existing row is read or rewritten. Existing photos are `private` by
  default (A1), so nothing becomes visible to anyone until an owner chooses a
  wider visibility and a moderator approves the photo.

### Release order and compatibility

**… → 0030 → 0031 → Phase 5 API.** 0031 can be applied in the same
`migrate` run as 0028–0030.

| Database   | Phase 1–4 API                                     | Phase 5 API                                                                                                      |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| up to 0030 | works                                             | `/profiles/{id}/photos`, photo requests fail (functions and tables missing). **Do not deploy before 0031.**      |
| 0031       | works (new tables unused; policy only adds reads) | **works on PGlite**; on Supabase, signing another member's photo depends on the Storage policy — verify it there |

### What `verify:db` checks for Phase 5

`services/api/scripts/phase5-photo-checks.ts`, called from `verify-db.ts`:
both tables exist with RLS enabled and forced, `authenticated` holds SELECT
and nothing else, `anon` nothing; the three functions exist and `anon` cannot
execute them; the rule's body still refuses private and unapproved photos and
still calls `app.can_view_profile`; and, **on a Supabase database only**, that
`photos_bucket_select_authorised_viewer` exists for SELECT and uses
`app.can_read_photo_object` (on a database without the storage schema this
check reports "verify on the hosted project" rather than passing silently).
**Proven to fail:** `test/verify-phase5-photos.test.ts` — all pass on a correct
database, the table and rule checks fail before 0031, and each of 7 single
breakages fails its check.

### Hosted verification still required (company)

1. Apply 0031; run `verify:db`; confirm the Storage check passes (not the
   "verify on the hosted project" message).
2. With two test members: owner uploads, a moderator approves, owner sets
   `blurred`. As the viewer, `GET /profiles/{owner}/photos` returns the
   blurred URL and it downloads; a direct Storage sign request for the
   original is refused.
3. Request → approve → the original downloads; owner sets the photo
   `private` → signing it is refused again.

### Rollback implications (0031)

| Change                           | Reversal                      | Data loss                             | Hazard                                                             |
| -------------------------------- | ----------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Storage viewer policy            | `drop policy`                 | None                                  | Cross-member photos stop working (back to the pre-L3 state). Safe. |
| Rule functions                   | `drop function … cascade`     | None                                  | Drops the policy with them; the photo routes then fail (500).      |
| `photo_requests`, `photo_grants` | Keep; stop the routes instead | Yes if dropped (who shared with whom) | A dropped grant table silently un-shares; harmless but surprising. |

---

## 0032 — `20261106000032_review_post_merge_security.sql` (post-merge security audit)

**Not applied anywhere.** Findings N2/B7, N1 and N4 from the post-merge audit.

### What it changes

- **N2/B7.** `profiles_select_visible`, `photos_select_visible` and
  `photo_variants_select_visible` are replaced by owner-only policies. A member's
  direct read (Data API, GraphQL, or any future exposure) returns only their own
  rows, whatever the Dashboard says. The API's own cross-member reads already ran
  under registered service-role uses, except photo access, which this change moves
  to `photo.read_access`.
- **N1.** `app.current_account_can_act()`, and a `*_refuse_restricted_account`
  RESTRICTIVE policy on every member-reachable table. Exempt for read only, because
  `GET /me` needs them: `users`, `user_settings`, `verification_status`,
  `family_relationships`, `family_permissions`. `users` and `user_settings` still
  refuse writes. A matching restrictive policy on the `photos` bucket.
- **N1, timed suspensions.** `moderation_actions.previous_status`, a nullable
  `actor_admin_id` allowed to be null only for the system's own expiry record, and
  `app.lift_expired_suspensions()`.

### Behaviour changes a caller could notice

- Every protected API route answers 403 `account_restricted` to a suspended, banned,
  deactivated or pending-deletion account. The exceptions are
  `RESTRICTED_ACCOUNT_ROUTES` in `services/api/src/auth/plugin.ts`.
- A suspension with an end date now ends on that date. Without a date it never ends
  by itself.
- `POST /admin/users/:id/actions` refuses an end date on anything but a suspension,
  an end date in the past, and suspending a banned account (409).
- Staff are refused (403 `staff_protected`) on their own account and content, and on
  anyone the hierarchy places above them. See `routes/admin.ts`.

### Safety for existing data

No row is changed. Suspensions recorded before 0032 keep their stored `expires_at`,
so any such date already past **will take effect** at the member's next request or
the next maintenance run. Check them before applying:

```sql
select subject_user_id, expires_at, reason from public.moderation_actions
 where action = 'suspend' and expires_at <= now();
```

### Release order and compatibility

Apply with the other unapplied migrations: **0026 → Phase 1 API → 0027 → 0028 + 0029

- 0030 + 0031 + 0032 → this API.**

* This API on a database without 0032: account actions fail, because they write
  `previous_status`. So 0032 goes first.
* The previous API on a database with 0032: other members' photo galleries are empty
  and photo requests say there is nothing to request, until the new API is live. No
  private data is exposed in that window. Measured by running the previous API's
  tests against 0032: every other route behaved as before.

### Required Dashboard action (not performed)

See `docs/PRODUCTION_SECURITY.md`. An earlier version of this section said Realtime was
unused. That was wrong: chat uses it for live delivery (`subscribeToMessages`), which is why
0034 keeps exactly the `messages` access Realtime needs.

### What `verify:db` checks

`scripts/storage-policy-checks.ts` replaces the old four-name comparison, which failed
on every correctly migrated project: each `photos_bucket_*` policy's command, role,
permissive or restrictive mode and clause, and any other policy that can reach the
bucket. `scripts/account-security-checks.ts` checks the three items above. `verify:db`
still has not been run against a hosted project.

### Defaults that need a company decision

These were chosen as the most restrictive reading of existing rules, and are easy to
change. None of them is a policy the company has stated.

- **Staff ranks.** `admin` outranks `moderator` and `support`, which rank equally. On
  account actions the target must rank strictly below the actor, so an admin cannot
  act on another admin, and that case needs an operator with the service role.
- **Honouring end dates.** A suspension with an end date ends on that date. The field,
  and the admin screen's end-date input, already existed; only the effect is new.
- **Clearing a ban.** A moderator can still clear a ban an admin imposed.
- **What a restricted member is told.** The status only. No reason, end date, appeal
  route or support contact appears, because none has been decided.
- **What a restricted member can reach.** Nothing but `RESTRICTED_ACCOUNT_ROUTES`, so
  also not their own messages, notifications or profile.
- **A family delegate.** The check applies to the caller, so a delegate can still act
  on a suspended owner's review, as far as those routes otherwise allow.

### Rollback implications (0032)

Recreating the 0012 policies **reopens N2**. Dropping the restrictive policies leaves
only the API gate in front of restricted accounts. Keep the `moderation_actions` rows
with a null actor: they are the record of a suspension ending.

## 0033 and 0034 — Stage 2: a role only the API can use

`20261106000033_review_stage2_api_role.sql` and `20261106000034_review_stage2_cutover.sql`.
**Not applied anywhere.**

### What they change

- **B7, root cause.** The API and the Data API both ran as `authenticated`, so every write the
  API needs was open to anyone with a member JWT. 0033 creates `api_member`, which inherits
  `authenticated` (so every RLS policy and function grant applies) and copies its table and
  column privileges. `authenticator` is not a member, so a forged `role` claim cannot reach it.
  0034 then revokes everything from `authenticated`, except `id`, `conversation_id` and
  `created_at` on `messages`, which Realtime needs.
- **Storage writes follow moderation.** A member can write an object only for their own photo
  while it is pending and not yet finalized. They could previously replace an approved photo, or
  the blurred copy no moderator sees, directly through the Storage API.
- **N3.** `photos.original_needs_strip` marks every photo present when 0033 runs, and
  `app.photo_variant_readable` refuses another member's `full` read while it is set.
  `primary_before_requeue` keeps a main photo's place through re-review. No photo's visibility
  changes. See `docs/LEGACY_CONTENT_RUNBOOK.md`.
- **Staff photo access.** `pii_access_log` (ERD, 24-month retention) and, from 0034,
  `photos_bucket_select_moderator` requires a fresh row there. The API writes those only for
  photos in the moderation queue.
- **Deletion from onboarding.** `users_identity_complete` also allows `pending_deletion`, because
  asking before filling in a profile failed with a 400.

### Release order and compatibility

**0026 to 0033 in one run → current API → 0034.** `migrate --through=<version>` stops at a given
migration. A fresh project can apply everything, then start the API. This replaces the older plan
of deploying an API between 0026 and 0027: the API that exists now needs 0033, so that is no
longer possible. 0033 lends back the column 0027 revokes, so messages keep sending on the live API
(`6c67581`) from the end of this run until 0034. Only the seconds between 0027 and 0033 are affected.

| Combination                  | Result                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| Previous API, through 0033   | Works: 555 of 561 of its tests. See docs/PRODUCTION_SECURITY.md for the 6 |
| Current API, through 0033    | Works. Tested                                                             |
| Previous client, current API | Works: 68 of 68 checks of the old client's own code                       |
| Current API, before 0033     | **Every member request fails**: `api_member` does not exist               |
| Previous API, after 0034     | **Every member request fails**: `authenticated` holds nothing             |

If the API connects as a different database user from the one that ran the migration,
`grant api_member to <user>` is needed too. `verify:db` checks it can `SET ROLE api_member`.

### Hosted verification required

Creating a role and granting it to the migration user, Realtime with the reduced `messages`
access, and the Storage policies have only been tested against a local stand-in.

### Rollback implications

Rolling back 0034 reopens direct Data API access. Rolling back 0033 needs the previous API
restored first. Keep `pii_access_log`: it is the record of who viewed what.

## 0035 — `20261107000035_account_erasure.sql`: account erasure and the family SLA sweep

**Status:** written and tested on PGlite · **not applied** to any hosted project.

- `app.erase_account(uuid)` anonymises an account whose deletion request is open, due and unheld
  (ERD E1). What it removes, closes and keeps is listed at the top of the file. It keeps
  `user_auth_links` pointing at the tombstone, so a session token issued before the erasure cannot
  bootstrap a new account.
- `app.erasure_blocker(uuid)` says why an account cannot be erased, or null. The erasure tool asks it
  to decide what to skip, then runs `erase_account`, which asks it again under row locks, before any
  file or sign-in is deleted. The 30 days are checked from `requested_at` as well as
  `scheduled_for`, so a wrong stored date cannot bring an erasure forward.
- `app.notify_stalled_family_reviews(integer)` is the Family screen's 72-hour sweep for everyone, for
  `maintenance` to run.
- `public.account_retention_holds` records a retention (legal) hold on an account. While one is
  unreleased, `erasure_blocker` answers `retention_hold` and `erase_account` holds the request. A
  member who cancels a held request and asks again cannot clear it, as they could a hold that lived
  only on the request. Row security is forced and members have no access to it.
- All three functions are service-role only, and the holds table is out of members' reach.
  `verify:db` checks both (`E1 only the server can erase…`), and the Data API suite now covers 58
  tables.

**Order.** Additive, and nothing in the API depends on it: apply it with 0034, after the API is
deployed, or at any time after that. `account-erasure` and the new `maintenance` task need it.

**Safety for existing data.** Creates one empty table and three functions. It changes no row until
someone runs the erasure tool with `--apply` or places a hold.

**Rollback.** Drop the three functions, then `public.account_retention_holds`. Before dropping the
table, export any holds it contains: dropping it removes them. An erasure already carried out cannot
be undone: that is what erasure means, which is why the tool runs dry by default.

## Environment changes

| Variable                      | Default | Phase | Purpose                                                                 |
| ----------------------------- | ------- | ----- | ----------------------------------------------------------------------- |
| `RATE_LIMIT_SENDS_PER_MINUTE` | `30`    | 1     | Per-member ceiling on messages, interests, reports, family invitations. |

`RATE_LIMIT_PER_MINUTE` is unchanged in name and default; it is now genuinely
per member (B9).

**Runtime:** Node **≥ 20.9** is now required (sharp 0.35). CI runs 22.
