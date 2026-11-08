# Known limitations

What a team taking this project over should expect to find missing, and why.

Every entry here was verified against the code on the date below — not inferred
from the roadmap. Where something is absent **by design**, the reasoning is given
so it is not "fixed" by accident.

**Verified:** 2026-10-19; sections 3–5 and 9 updated 2026-11-05 · 1,730 tests passing · 31 migrations · 56 tables. Hosted and device checks are still outstanding: see [HANDOVER.md](HANDOVER.md).

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
interest, match, family review, conversation. The staff console (section 5)
now makes `reports` useful.

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

**The SLA sweep is ready to schedule.** The 72-hour warning is swept when the owner opens their
family screen, and since migration 0035 also by `maintenance` (`app.notify_stalled_family_reviews`),
so an owner who never opens the app is warned too, once a scheduler runs it. `sla_notified_at`
keeps it to one warning either way.

---

## 3. Cross-user photos: built, verified only locally

_Updated 2026-11-05 (code review Phase 5, L3)._

Another member's photos are served by `GET /profiles/{userId}/photos`, and
members can request, approve and decline access
([routes/photo-access.ts](../services/api/src/routes/photo-access.ts),
[migration 0031](../supabase/migrations/20261105000031_review_phase5_photo_access.sql)).
The API still holds no Storage credential: it signs with the VIEWER's token,
and a Storage policy applies the same rule the API uses
(`app.photo_variant_readable`) — so a variant the rule refuses cannot be
signed. `private` photos are never shown to anyone else, grant or not.

What remains:

- **Hosted verification.** The Storage policy is a no-op outside Supabase.
  The rule itself is tested on PGlite, and the API tests run against a Storage
  double that enforces it, but real Supabase Storage has not been exercised.
- **Discovery cards** (`ProfileCard.primaryPhoto`) are still `null`: signing a
  URL per card per page is a performance decision not taken yet. Photos appear
  on the profile screen.
- **No grant-revocation endpoint** (not in the contract). An owner withdraws
  access by setting photos private, or by blocking.

---

## 4. Public profile: built (L4)

_Updated 2026-11-05 (code review Phases 3 and 5)._

`GET /profiles/{userId}` applies per-field visibility for the viewer (public,
matched-only; on-request and private are withheld) and the profile screen
renders only what it returns
([app/(app)/profile/[userId].tsx](<../apps/mobile/app/(app)/profile/[userId].tsx>)).
The session card cache remains only as a name to show while loading.

Still absent: the distance band (no coordinates are stored) and on-request
FIELDS (only photos have a request flow).

---

## 5. Reports: a moderation console exists; no cases or evidence snapshots

_Updated 2026-11-05 (code review Phases 3 and 5, L1)._

Staff triage, action and dismiss reports, decide photo, profile and
date-of-birth queues, and warn/suspend/ban members, in the staff console at
`/admin` (the Expo web build), against the Phase 3 moderation API. Staff need
an `admin_users` row with a role and a second factor (aal2); every decision is
written with an append-only audit row the console can read. Still absent:
grouped cases, risk signals, PII-access logging, automatic suspension expiry,
and hosting for the console (it ships inside the web build today).

`report_evidence` (ERD §14) is deliberately absent: its purpose is snapshotting
message content by value so a bad actor deleting messages cannot destroy the
case, and there are no messages yet.

---

## 6. `interests.note`: contact details are filtered

_Updated 2026-11-05 (code review L9, company decision 3)._

`POST /interests` refuses a note containing a phone number, email, link, handle or messaging
platform. The filter cannot catch everything: Urdu number words and letter-for-digit substitution
get through. Direct writes are closed by 0026 and direct reads of other members by 0032, once
applied; the Supabase Dashboard change (B7) is still required, see `DATABASE_MIGRATION_REPORT.md`.

---

## 7. Play Store requirements not yet met

_Updated 2026-11-05._

- **Account deletion is built but not scheduled.** Members can ask for deletion and cancel it, and
  `account-erasure` carries it out after the grace period. It still needs counsel's review of ERD E1,
  a rehearsal on a copy of the hosted project, a scheduler, and a process for who places and lifts
  legal holds (`account_retention_holds`, built in 0035). There is no staff screen for holds or for
  releasing a held request: both are supervised database changes. `/me/export` is absent. Google also requires a web
  deletion page. See `docs/PRODUCTION_SECURITY.md`.
- No data-safety form, no privacy policy, no age-rating submission.
- `apps/mobile/eas.json` builds an APK for direct distribution only. A Play Store upload needs an
  AAB profile.

Report and block, the other Play requirement for user-generated content, **are** implemented.

---

## 8. Push notifications are not delivered

_Updated 2026-11-05._

The in-app inbox is the only delivery channel. The API stores push tokens and per-type preferences,
but no provider is chosen and nothing sends a push, so a member must open the app to learn anything.

---

## 9. Testing gaps

1,730 tests pass, and the database suites run against a real Postgres (PGlite)
applying the migration files exactly as written. What that does **not** cover:

- **No end-to-end test.** No Detox, Maestro or Playwright. No test has ever run
  against a live Supabase project.
- **No mobile component tests.** Logic behind the newest screens has unit tests; the screens
  themselves are only type-checked and bundled.
- **No load or penetration testing** (Phase 13).
- **No real-device testing.** The project targets low-end Android; it has not
  been run on one.

---

## 10. Operational gaps

- **No mobile crash reporting.** Sentry is wired on the API only; a crash on a
  user's phone is invisible.
- **No deployment configuration** — no Dockerfile, no hosting config. The API is
  a plain Node process (`pnpm --filter @nikahmate/api start`).
- **No scheduler.** pg-boss was deferred, so nothing runs on a timer. Retention, invitation
  expiry, expired suspensions and the family review SLA sweep are ready to schedule through
  `maintenance`, and account erasure through `account-erasure` ([MAINTENANCE.md](MAINTENANCE.md)).
  Nothing schedules them yet.

  Candidate generation is the exception, and it is not scheduled: it runs
  on-demand when a member opens Discover, claimed through
  `discovery_generation_runs` with a 15-minute cooldown and a 2-minute stale
  window ([candidates.ts](../services/api/src/discovery/candidates.ts)). That is
  deliberate — it removes the dependency on a runner that does not exist — but
  it means the FIRST feed open after the cooldown pays the generation cost, and
  nothing refreshes a dormant member's candidates in the background.

---

## 11. Unimplemented contract operations

_Updated 2026-11-05._

18 of the 111 contract operations are not built. Each is marked `x-status: not-implemented` with
its blocker in [openapi.yaml](openapi.yaml), and a test keeps that list matched to the running routes.
No screen calls them. The ones a company should know about: `POST /me/export` (a member cannot
export their data), `POST /support/contact` and `GET /safety/center`, resending the verification
email, phone verification, family calls and plans.

**Discover does not reload when someone returns to it,** because a reload goes back to the first
page and would lose their place. A card for someone already sent an interest from their profile
stays until the next refresh. Pressing Express Interest on it now just removes the card, instead
of showing an error.

---

## 12. Documentation drift

- **"No hardcoded strings" is reviewed, not enforced.** README §12.3 used to
  claim CI enforced it; [ci.yml](../.github/workflows/ci.yml) has no such check
  and the claim has been corrected. Nothing stops a literal being typed into a
  screen. ADR 0012 narrowed the launch to English only, so the cost of a stray
  literal is low today — but it is the thing that will bite when a second
  locale is added.
- [Migration 0006](../supabase/migrations/20260930000006_media.sql) records `photo_requests` as
  deliberately absent. That comment is historical: migration 0031 added the table.
