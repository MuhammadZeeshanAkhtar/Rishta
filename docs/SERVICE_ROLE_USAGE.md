# Service-role usage register

**Every place the API bypasses row-level security, and why.**

README §9.3 commits to service-role usage being "a short, explicitly enumerated,
code-reviewed list". This is that list.

It is enforced by the compiler, not by discipline: `Db.asService` accepts only a
member of the `ServiceRoleUse` union in
[`services/api/src/db/types.ts`](../services/api/src/db/types.ts). A new
privileged operation cannot be written without editing that union — which is
exactly the diff a reviewer should stop on.

Every call is recorded through `onServiceUse`, so the log answers _why_ the
server read something, not merely that it did.

---

## The default is `asUser`

| Path                    | When                                            | RLS                                                               |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `asUser(authUserId, …)` | Almost everything                               | **Applies.** Runs as `authenticated` with the caller's claims set |
| `asAnon(…)`             | Genuinely public data — reference lists, health | Applies, as `anon`                                                |
| `asService(use, …)`     | Only the reasons below                          | **Bypassed**                                                      |

`asUser` is defence in depth: a bug in a route handler cannot widen what that
request can see, because Postgres is still applying the policy.

---

## Enumerated reasons — v1

### `account.bootstrap`

**Where:** `POST /account/bootstrap`

**Why it cannot run as the caller:** `users` has no `INSERT` policy, deliberately.
A client that could insert its own row could choose its own `status` and skip
onboarding entirely. The row must exist before the caller has an identity to be
scoped to, so there is nothing for RLS to scope against yet.

**Safety:** the JWT is verified _before_ this runs, so the subject is trusted.
Nothing in the request body identifies the account — a supplied `userId`,
`authUserId` or `status` is stripped by the Zod schema and never reaches SQL.
Asserted by test: _"ignores an attacker-supplied account id in the body"_.

**Scope:** inserts into `users`, `user_auth_links`, `user_settings`,
`verification_status` and optionally `user_devices`, for the verified subject only.

---

### `account.register_device`

**Where:** device registration and revocation.

**Why:** `user_devices` rows are written on the owner's behalf during bootstrap,
before a session is fully established.

**Scope:** one row, keyed by `(user_id, device_id)`, for the verified subject.

---

### `security.record_event`

**Where:** append to `security_events`.

**Why:** clients have no `INSERT` policy on this table. An audit log a client can
write is not an audit log.

**Scope:** insert only. Never update, never delete — the table has no policy for
either, for any role.

---

### `consent.record`

**Where:** writing `user_consents`, including the Article 9 religious-data consent.

**Why:** `user_consents` is `restricted` — zero policies, unreachable from any
client, including the member it concerns. Consent records are evidence; a
subject who could edit their own consent history would make that evidence
worthless.

**Scope:** insert only, for the verified subject.

---

### `profile.read_own_sensitive`

**Where:** [`routes/profile.ts:360`](../services/api/src/routes/profile.ts)

**Why:** `profile_sensitive` is `restricted` — zero policies, for every role
including the owner. That absence is what makes "hide my workplace"
structurally true rather than a UI promise, so even the owner's read of their
own contact details has to come through here.

**Scope:** select only, filtered on the caller's own `user_id`.

---

### `profile.update_completion`

**Where:** [`routes/profile.ts:470`](../services/api/src/routes/profile.ts)

**Why:** `profiles.completion_score` carries no member grant, precisely so a
member cannot inflate their own score and jump the ordering it feeds.

**Scope:** updates one column on the caller's own row. The value is computed
server-side from the saved profile, never taken from the request.

---

### `profile.submit_for_review`

**Where:** [`routes/profile.ts:527`](../services/api/src/routes/profile.ts)

**Why:** `profiles.review_status` is ungranted for the same reason. A member who
could write it would be discoverable without ever passing review.

**Scope:** moves the caller's own row to `pending`, and nothing else.

---

### `photo.record_moderation`

**Where:** [`routes/photos.ts:230,257`](../services/api/src/routes/photos.ts)

**Why:** members hold no grant on `photo_variants` or on
`photos.moderation_status`. A member who could write either could point the
blurred variant at the unblurred original, or approve their own photo without it
being checked.

**Scope:** writes the generated variant rows and the moderation verdict for a
photo the caller owns, after ownership is established under the caller's own
session.

---

### `photo.soft_delete`

**Where:** [`routes/photos.ts:406`](../services/api/src/routes/photos.ts)

**Why:** not an ordinary field edit. Under FORCE RLS the soft-deleted row would
be invisible to its own owner under `photos_select_own`, so the member-run
UPDATE is refused outright (migration 0008). The row has to survive for abuse
investigation while the bytes are purged from the bucket.

**Scope:** one row the caller owns.

---

### `entitlement.grant`

**Where:** [`entitlements/service.ts:149,168`](../services/api/src/entitlements/service.ts)

**Why:** `authenticated` holds SELECT on `user_entitlements` and nothing else, so
there is no member-level write path to govern. A member who could write this
table would grant themselves `who_viewed_me` or raise their own
`daily_interests`. Every write is an operator action.

**Scope:** insert or update of entitlement rows. Never reached from a
member-facing route.

---

### `compatibility.write_scores`

**Where:** [`discovery/candidates.ts:424,497,524`](../services/api/src/discovery/candidates.ts)

**Why:** `compatibility_scores` and `compatibility_factors` carry no member write
privilege at all. A member who could write a factor could author an
"explanation" the engine never produced, which would destroy the one property
the deterministic design exists to guarantee (ADR 0001).

**Scope:** reads the preference rows the engine needs, then writes the scores and
their factors. The engine is pure and versioned (`ENGINE_VERSION`), so the same
inputs always produce the same row.

---

### `discovery.write_candidates`

**Where:** [`discovery/candidates.ts:566`](../services/api/src/discovery/candidates.ts)

**Why:** a member who could write here would place themselves in someone else's
Discover feed.

**Scope:** writes the new batch and deletes the previous one in ONE transaction,
so a section is never read half-built.

---

### `discovery.read_cards`

**Where:** [`routes/discovery.ts:166,231,332`](../services/api/src/routes/discovery.ts),
[`routes/interests.ts:120`](../services/api/src/routes/interests.ts)

**Why:** `users` is owner-only and must stay that way — it holds `date_of_birth`,
and the product promises only the AGE is ever shown to anyone else, plus `status`
and `onboarding_step`, which are nobody else's business. A card needs the display
name and the derived age, so the row is read here and the date never leaves this
service.

**Safety:** the confinement is explicit rather than inherited. Every query under
this key filters on the caller's own `match_candidates` rows and re-applies
`app.can_view_profile()` — the same predicate the member's own reads go through.

**Scope:** select only; the birth date is reduced to an integer age before it
leaves the function.

---

### `interest.send`

**Where:** [`routes/interests.ts:162,586`](../services/api/src/routes/interests.ts)

**Why:** ONE TRANSACTION, and that is the whole reason this is a service-role
path. The contract requires the daily quota to be consumed in the same
transaction as the insert — otherwise two concurrent requests both read 4 and
both succeed, and the quota is advisory rather than real (ERD §16).
`usage_counters` is service-role-write by design and `interest_events` has no
member write path at all, so the counter, the interest and its event cannot land
together under `asUser`.

**Safety:** `sender_user_id` comes from `app.current_user_id()` resolved under the
caller's own session before the transaction opens, never from the request body.
The RLS policy on `interests` independently refuses a direct insert naming anyone
else.

**Scope:** `interests`, `interest_events`, `usage_counters` — one row each.

---

### `interest.respond`

**Where:** [`routes/interests.ts:304`](../services/api/src/routes/interests.ts)

**Why:** one transaction covering `interests.status`, its `interest_events` row,
and — on acceptance — the `matches` row and its `match_events` row. None of those
four is member-writable: status is server state, both event tables are
append-only with no member grant, and a member who could insert a match would
manufacture a relationship the other person never agreed to.

**Safety:** only the RECIPIENT may respond, checked against
`app.current_user_id()` under the caller's own session before the transaction
opens.

**Scope:** the four tables above, for the one interest named.

---

### `match.end`

**Where:** [`routes/matches.ts:222`](../services/api/src/routes/matches.ts)

**Why:** `matches` carries no member write grant — a member who could update it
could clear someone else's ending, or move `communication_state` past the Family
Safety gate — and `match_events` has no member path at all.

**Safety:** participation is established before the transaction opens, from
`app.current_user_id()` under the caller's own session.

**Scope:** sets the ending on one match and appends its event.

---

### `report.file`

**Where:** [`routes/safety.ts:304`](../services/api/src/routes/safety.ts)

**Why:** `reports` has no member INSERT grant (migration 0022). `status` and
`outcome_key` are the moderation pipeline's state, and a member able to write
them directly could file a report pre-dismissed, or edit one a moderator had
already triaged.

**Safety:** `reporter_user_id` comes from `app.current_user_id()` resolved under
the caller's own session, never from the request body. Self-reports, an invisible
target and the one-open-report-per-pair rule are all refused on this side, which
is why the insert belongs here rather than in a policy.

**Scope:** one `reports` row.

---

### `safety.read_blocked_identities`

**Where:** [`routes/safety.ts:128`](../services/api/src/routes/safety.ts)

**Why:** `users` is owner-only, so a block list cannot name anyone without a
service-role read — and `discovery.read_cards` cannot serve it, because that path
re-applies `app.can_view_profile()` and a blocked member fails it by definition.
Reusing it would return an empty list and make the blocks unmanageable: you must
be able to see whom you blocked in order to unblock them.

**Scope:** confined by construction. The query joins FROM the caller's own
`blocks` rows and selects nothing but `id` and `display_name`. The birth date,
the status and every other owner-only column stay in this service.

---

### `discovery.claim_generation`

**Where:** [`discovery/candidates.ts:680,720,736`](../services/api/src/discovery/candidates.ts)

**Why:** `discovery_generation_runs` has no member grant and no policy — it is
scheduling state, not member data. A member able to write it could claim another
member's run and starve their feed, or clear their own cooldown and make a
500-candidate scoring pass runnable on every request.

**Safety:** the viewer id comes from `app.current_user_id()` resolved under the
caller's own session before this opens, never from the request.

**Scope:** one row, keyed `(user_id, section_key)`. The claim is a conditional
UPDATE, which is what makes it atomic — two concurrent requests issue the same
statement and exactly one matches.

---

## Not on this list, deliberately

| Operation       | Runs as  | Why                                                                                                         |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /me`       | `asUser` | RLS scopes it. The query has no `WHERE` clause on purpose, and a test asserts the policy is what filters it |
| `PATCH /me`     | `asUser` | The owner policy on `user_settings` is sufficient                                                           |
| Reference reads | `asAnon` | Public data; identical for every caller                                                                     |
| Health check    | `asAnon` | Touches no user data                                                                                        |

---

## Adding a reason

1. Add the member to `ServiceRoleUse` with a comment explaining why RLS cannot
   apply.
2. Add a section here: where, why, safety, scope.
3. Add a test asserting the operation uses **that** reason and no other — see
   _"uses the service role, and only for the enumerated reason"_.

If the answer to "why can this not run as the caller?" is "it would be easier",
it is not a reason. Write the policy instead.
