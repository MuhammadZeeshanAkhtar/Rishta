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
