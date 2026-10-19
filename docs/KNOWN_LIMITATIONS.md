# Known limitations

What a team taking this project over should expect to find missing, and why.

Every entry here was verified against the code on the date below — not inferred
from the roadmap. Where something is absent **by design**, the reasoning is given
so it is not "fixed" by accident.

**Verified:** 2026-10-19 · 1,133 tests passing · 25 migrations · 45 tables

---

## 1. Text is the only communication channel

Chat works. Calls, voice notes, media sharing and contact exchange do not.

[ADR 0011](adr/0011-family-safety-wali-communication.md) separates "these two
people matched" from "these two people may talk", and both halves now exist:
Family/Wali review (Phase 6b) decides, and conversations (Phase 7) are gated on
that decision by `app.can_write_message()`.

What is still absent, and why:

- **Voice notes.** `messages.kind` accepts `voice`, and nothing issues an
  upload target or moderates the result. The column is there so the row shape
  does not change later, not because the feature is half-built.
- **Calls.** M2 (ADR 0011). `system_flags` ships them switched OFF rather than
  absent, for both the family-mediated and the direct 1:1 path — a path that is
  switched off gets reviewed before it is switched on.
- **Translation and reply suggestions.** Both are AI, which
  [ADR 0006](adr/) excludes from v1 entirely.
- **Contact exchange.** `profile_sensitive` is `restricted` with zero policies,
  which is the point. Nothing in the product hands over a phone number.

**Consequence for a new team:** the core loop is complete end to end — discover,
interest, match, family review, conversation. Phase 8 (moderation tooling) is
the next piece of work, and it is the one that makes `reports` useful.

---

## 2. Family / Wali ships the M1 review layer only

Built: invitations, relationships, scoped permission grants, the match-scoped
review packet, approve / reject / request-more-info / revoke, the access log,
and the 72-hour stall warning. D12 was settled on 2026-10-19 and the answers
are encoded in [migration 0024](../supabase/migrations/20261019000024_family_safety.sql)
rather than described.

Not built, and deliberately scoped out of M1:

- **Supervised conversation view** (`view_conversation`) and **in-thread family
  participation** (`join_conversation`). The permission vocabulary accepts both
  and the API refuses them at grant time with 400 — a grant that is accepted
  and silently does nothing is worse than a refusal, because the owner believes
  they granted something.
- **Family calls** and their two permissions. M2, and `system_flags` holds the
  switch.
- **Quorum approval.** The first decision stands (D12 row 4). `family_reviews`
  already records WHICH relationship decided, so adding a count rule is
  additive rather than a migration.

**The SLA has no scheduler.** pg-boss was deferred (ADR 0007), so the 72-hour
warning is swept when the owner opens their family screen rather than by a
runner. An owner who never opens the app is never warned — which matters
because this is an R16 control. `sla_notified_at` keeps it to one warning.

---

## 3. Cross-user photo delivery does not work

`ProfileCard.primaryPhoto` is always `null`
([services/api/src/discovery/cards.ts](../services/api/src/discovery/cards.ts)).
Every profile in Discover renders a generated gradient portrait instead.

This is an architectural consequence, not an oversight. The Storage policies in
[migration 0007](../supabase/migrations/20260930000007_storage.sql) scope every
object to its owner by path, and the API calls Storage with the **caller's own
token** — it holds no Storage service-role credential. Signing another member's
object is therefore refused.

Resolving it is a real decision with security weight: either grant the API a
Storage credential (backend environment only), or add a Storage policy allowing
a caller to sign an approved, non-private photo on a profile they may already
view. The second keeps the "no second credential" property.

**A member's own photos work normally** — upload, server-side blurred variant,
moderation, reordering and deletion are all built and tested.

---

## 4. There is no public profile endpoint

`GET /profiles/{userId}` is specified in the contract and unimplemented. The
server exposes another member only as a `ProfileCard` — an enumerated allowlist
of eleven fields — embedded inside discovery, interests and matches.

So the profile-detail screen shows compatibility and little else, and works
around the gap with a session-scoped in-memory card cache
([apps/mobile/src/discovery/cardCache.ts](../apps/mobile/src/discovery/cardCache.ts)).

This also blocks Phase 6b: `FamilyReviewPacket.counterpart` is typed as
`PublicProfile`, so the review packet cannot be built until this projection
exists.

Note that **per-field visibility is enforced nowhere yet**. The fourteen keys in
`profile_field_visibility` are read and written by the owner, and have never been
applied against another viewer, because no endpoint returns another member's
fields. That enforcement arrives with this projection.

---

## 5. Reports are stored and nobody reads them

`POST /reports` works, is tested and writes a row. There is **no moderation
queue, no triage, no admin surface** — that is Phase 8.

Filing a report currently produces no human action. The table has the indexes
the queue will need (`(status, created_at)` and `(reported_user_id)`), and one
open report per reporter/reported pair is enforced by a partial unique index.

`report_evidence` (ERD §14) is deliberately absent: its purpose is snapshotting
message content by value so a bad actor deleting messages cannot destroy the
case, and there are no messages yet.

---

## 6. `interests.note` is an unmediated free-text channel

`POST /interests` accepts an optional 500-character note which is delivered to
the recipient before any match exists. It is contract-required (README §4.7,
ERD §10) and a reviewing wali is specified to see it, so it has been left exactly
as designed.

It is, however, the one place in the product where "no contact exchange" is not
currently true — nothing prevents someone typing a phone number into it. The
boundary that _does_ hold is pinned by tests: the note reaches only the two
parties, is capped at 500 characters, and appears nowhere in the discovery
payload.

**This is an open product decision**, not a defect. Options considered: leave it,
cap it hard, withhold it until acceptance, or remove it.

---

## 7. Play Store requirements not yet met

- **Account deletion is not implemented.** `/me/delete`, `/me/deactivate` and
  `/me/export` are specified and absent. Google requires in-app deletion **and**
  a web deletion route.
- No data-safety form, no privacy policy, no age-rating submission.
- No `eas.json`, so there is no build pipeline for a store artifact.

Report and block — the other Play requirement for user-generated content — **are**
implemented.

---

## 8. No push notifications

The in-app inbox is the only delivery channel. `/me/push-tokens` and
`/me/notification-preferences` are specified and unimplemented, so a member must
open the app to learn anything.

---

## 9. Testing gaps

1,133 tests pass, and the database suites run against a real Postgres (PGlite)
applying the migration files exactly as written. What that does **not** cover:

- **No end-to-end test.** No Detox, Maestro or Playwright. No test has ever run
  against a live Supabase project.
- **No mobile component tests.** Only the profile screens have been visually
  verified, in a browser via `expo start --web`.
- **No load or penetration testing** (Phase 13).
- **No real-device testing.** The project targets low-end Android; it has not
  been run on one.

---

## 10. Operational gaps

- **No mobile crash reporting.** Sentry is wired on the API only; a crash on a
  user's phone is invisible.
- **No deployment configuration** — no Dockerfile, no hosting config. The API is
  a plain Node process (`pnpm --filter @nikahmate/api start`).
- **No scheduler.** pg-boss was deferred, so anything periodic — the Phase 6b
  review SLA sweep, retention sweeps, the verification SLA — has no runner.

  Candidate generation is the exception, and it is not scheduled: it runs
  on-demand when a member opens Discover, claimed through
  `discovery_generation_runs` with a 15-minute cooldown and a 2-minute stale
  window ([candidates.ts](../services/api/src/discovery/candidates.ts)). That is
  deliberate — it removes the dependency on a runner that does not exist — but
  it means the FIRST feed open after the cooldown pays the generation cost, and
  nothing refreshes a dormant member's candidates in the background.

---

## 11. Smaller unimplemented contract paths

Specified in [openapi.yaml](openapi.yaml), not built. None blocks the core loop.

`/discovery/search` · `/me/quotas` · `/compatibility/recompute` ·
`/me/photo-requests` · `/me/devices` · `/me/security-events` ·
`/me/verification/*` · `/me/profile-views` · `/me/entitlements` · `/me/usage` ·
`/plans` · `/safety/center` · `/safety/panic-exit` · `/support/contact`

Roughly 53 of 95 contract paths are implemented. The unimplemented ones are
specified to the same level of detail as the built ones, which is the main asset
here: the contract is the plan.

---

## 12. Documentation drift

- **"No hardcoded strings" is reviewed, not enforced.** README §12.3 used to
  claim CI enforced it; [ci.yml](../.github/workflows/ci.yml) has no such check
  and the claim has been corrected. Nothing stops a literal being typed into a
  screen. ADR 0012 narrowed the launch to English only, so the cost of a stray
  literal is low today — but it is the thing that will bite when a second
  locale is added.
- `ENTITIES.md` lists `photo_requests` as an M1 entity;
  [migration 0006](../supabase/migrations/20260930000006_media.sql) records it as
  deliberately absent.
