# Code review fix tracker

Tracks every finding in the **NikahMate Code Review Report, 28 October 2026**
(reviewed commit `6c67581`) through to resolution.

**Last updated:** 2026-11-01 · end of Phase 1, after the final Phase 1 review (R1, R2 fixed) and the approved follow-ups (0026/0027 release split, `verify:db` Phase 1 checks) · working tree on top of `6c67581`, uncommitted · workspace suite 1,257 passing

## Status definitions

| Status          | Meaning                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Pending**     | Confirmed present in the code; not started.                                                               |
| **In Progress** | Work started in the current phase.                                                                        |
| **Fixed**       | Code changed and tests pass, but some part of the fix cannot be proven by the test suite (noted).         |
| **Verified**    | Fixed, with a regression test that was **shown to fail without the fix** or exercises the reported order. |
| **Blocked**     | Cannot proceed without a decision or an action outside the repository (noted).                            |

All 26 bugs and all 12 limitations were re-confirmed against the code in the
Phase 0 audit. None had been fixed before this work began.

## Product decisions recorded (2026-11-01)

| #   | Decision                                                                                  | Applies to | Phase  |
| --- | ----------------------------------------------------------------------------------------- | ---------- | ------ |
| 1   | Incognito: visible only to members the user has liked; paid entitlement, server-enforced. | B3         | 1 done |
| 2   | Cross-member photos: secure Storage policies; only authorised viewers, approved photos.   | L3         | 5      |
| 3   | Interest notes: block phone, email and direct contact details before mutual acceptance.   | L9         | 2      |
| 4   | DOB correction: a support/admin verification workflow with an audit trail.                | B6         | 4      |

**Interpretation of decision 1, flagged for confirmation.** The product has no
"like" action. Its positive signal is **Express interest** (an `interests`
row); **Save** is a private shortlist the other person never learns about. So
"members the user has liked" is implemented as _members the incognito user has
sent an interest to, in any state except `withdrawn`_. Incognito governs
**discovery** — the feed and the shortlist. Existing interests and matches are
unaffected, because hiding someone from a relationship they already have would
break it.

## Bugs

| ID  | Severity | Issue                                           | Status       | Phase | Resolution / notes                                                                                                                                                                                                                                                                                                         |
| --- | -------- | ----------------------------------------------- | ------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | High     | One family's approval overrides a rejection     | **Verified** | 1     | Approval now requires every other review `approved`; decisions refused (409) unless the match is `pending_family_review`; DB trigger `matches_guard_family_approval` (0026) refuses the transition for any caller. Match row also locked so two simultaneous approvals cannot strand the match. Review R2 fixed (below). ¹ |
| B2  | High     | Family invitation cannot be accepted in the app | Pending      | 2     |                                                                                                                                                                                                                                                                                                                            |
| B3  | High     | Pause discovery and Incognito never applied     | **Verified** | 1     | New `app.discoverable_to()` used for feed generation, feed reads and the shortlist. Incognito requires the entitlement: route answers 403 `entitlement_required`; trigger `user_settings_guard_incognito` (0026) blocks the Data API path. `/me` reports the _effective_ value.                                            |
| B4  | High     | "Maybe later" freezes an interest               | **Verified** | 1     | Deferred interests can be accepted, declined or withdrawn; app shows the buttons. `interests_responded_consistent` relaxed for `withdrawn` only (0026), so withdrawing a deferred interest keeps its deferral time.                                                                                                        |
| B5  | High     | Photos auto-approved; re-finalize re-approves   | Pending      | 4     | Removing the stub before a moderation queue exists would strand every photo in `pending`; sequenced with L1.                                                                                                                                                                                                               |
| B6  | High     | Profiles auto-approved; edits never re-reviewed | Pending      | 4     | As B5. DOB correction workflow per decision 4.                                                                                                                                                                                                                                                                             |
| B7  | High     | Members can bypass the API via the Data API     | **Fixed**    | 1     | DB half done: policy pins `kind = 'text'` and a non-blank body, `messages_body_not_blank` for every role, member `INSERT` on `interests` revoked (0026); members cannot name `kind` (0027, applied after the API). `verify:db` checks every one. **Complete fix needs a dashboard change — see manual actions.** ²         |
| B8  | High     | Vulnerable `sharp` processes uploads            | **Verified** | 1     | `sharp` 0.34.5 → **0.35.5** (libvips 8.18.7); `pnpm audit` shows 0 sharp advisories. Decoded format must match the declared content type and be JPEG/PNG/WebP; `failOn: 'warning'` pinned. Review R1 fixed: the app now declares the real type. ³                                                                          |
| B9  | Medium   | Rate limiter is per-IP for everyone             | **Verified** | 1     | Limiter keys on the **verified** token subject (falls back to IP); auth stays opt-in per route. Per-member send ceiling on messages, interests, reports, invitations (`RATE_LIMIT_SENDS_PER_MINUTE`, default 30). Test shown to fail on the old key generator.                                                             |
| B10 | Medium   | Pagination duplicates/skips during new messages | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B11 | Medium   | Abandoned uploads use up photo slots            | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B12 | Medium   | Original photo keeps EXIF / GPS                 | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B13 | Medium   | Unapproved photo can be primary                 | Pending      | 3     | Also: the handler clears the old primary _before_ validating the new one.                                                                                                                                                                                                                                                  |
| B14 | Medium   | Malformed IDs cause 500s                        | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B15 | Medium   | Storage error detail returned to clients        | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B16 | Medium   | Stage proposal accepted after block/revoke      | Pending      | 2     |                                                                                                                                                                                                                                                                                                                            |
| B17 | Medium   | Double-tapped Accept duplicates events          | **Fixed**    | 1     | `select … for update` plus an update conditional on the status read. Repeat answers 409 with one event and one notification. ¹                                                                                                                                                                                             |
| B18 | Medium   | Email links hard-wired to the mobile scheme     | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B19 | Low      | Concurrent first sign-ins 500                   | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B20 | Low      | Verification timestamps exposed                 | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B21 | Low      | Every 4xx is `validation_failed`                | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B22 | Low      | `PATCH /me` update has no WHERE clause          | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B23 | Low      | Daily quota resets at UTC midnight              | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |
| B24 | Low      | Some users cannot be blocked                    | Pending      | 2     |                                                                                                                                                                                                                                                                                                                            |
| B25 | Low      | Leaving a conversation is one-sided             | Pending      | 2     |                                                                                                                                                                                                                                                                                                                            |
| B26 | Low      | Noisy logs and unbounded tables                 | Pending      | 3     |                                                                                                                                                                                                                                                                                                                            |

¹ **Concurrency is code-inspected, not tested.** The PGlite test harness runs
every transaction on one connection without serialising them, so two
"concurrent" requests share a transaction rather than contending for a row
lock. A race test there would pass with or without the lock. The deterministic
consequences are tested; the race itself needs a multi-connection Postgres
(tracked under L12).

² **B7 is Fixed, not Verified,** because the remaining exposure is a live
project setting the repository cannot change.

³ **Correction to the report.** The report suggested `sharp(buf, { failOn:
'error' })`. In sharp's ordering — `none` < `truncated` < `error` < `warning` —
that is one level _looser_ than the default, and sharp's documentation says to
keep `warning` for untrusted input. The strict default is pinned explicitly
instead.

## Phase 1 review findings (2026-11-01)

Regressions found by the final Phase 1 review in the Phase 1 work itself, not
in the original report.

| ID  | Introduced by | Issue                                                                  | Status       | Resolution / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------- | ---------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | B8            | Every PNG/WebP upload rejected after it had taken a photo slot         | **Verified** | The app hard-coded `image/jpeg`; B8 made the server compare that with the decoded file. New `resolvePhotoContentType()` (`packages/domain`) declares the picker's `mimeType` (the blob type only if that is missing), JPEG/PNG/WebP only, `image/jpg` aliased. Unsupported or missing → refused in the app **before** `createPhotoUploadTarget`, so no slot is used. Server check unchanged. 23 unit + 12 API tests; the 4 mismatch tests fail with the server check disabled. ⁴ |
| R2  | B1            | After one family rejected, the other side's review stayed live forever | **Verified** | The match left `pending_family_review`, but the other household's undecided review still sat in its inbox (decide → 409), showed as "pending / overdue" in the owner's list, and drove stall notifications. Inbox, owner list and SLA sweep now require a live match (`pending_family_review`, not ended); decided reviews are still listed. 2 API tests that fail with the filter neutralised; the reproduction probe re-run clean.                                             |

⁴ **Not verified on a device.** Native picks are re-encoded by the picker
(`allowsEditing`, `quality: 0.85`), so PNG/WebP mainly arrive from the web
build, which returns the original file. The app path is covered by typecheck
and the production web export, not by an automated UI test (L12).

## Approved follow-ups to the Phase 1 review (2026-11-01)

| ID  | Change                                                                          | Status       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Split release: the `messages.kind` revoke moved out of 0026 into a new **0027** | **Verified** | Removes the broken window where the old API (which names `kind`) could not send messages. Order: 0026 → API → 0027. `review-phase1-release.test.ts` runs the routes on a database migrated through 0026 only and through 0027; with the revoke put back into 0026 the old-API send fails. 0026 was editable only because it has never been applied.                                                                                                                        |
| F2  | `verify:db` checks every Phase 1 security change                                | **Verified** | New `scripts/phase1-security-checks.ts`: both triggers (presence, enabled, timing, columns, function, guard body), `messages.kind` and `interests` INSERT privileges (column, table and `PUBLIC` grants), the send columns, the insert policy and `messages_body_not_blank`. `verify-phase1-security.test.ts`: all pass on a correct database, and each of 23 deliberate breakages fails exactly its own check. Not run against a live database (dev project unreachable). |

## Manual actions required (outside the repository)

| #   | Action                                                                                                                                                                                                   | For         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Supabase Dashboard → API → remove `public` from the exposed schemas. Completes B7; until then the Data API stays a second entry point, limited only by grants and RLS.                                   | B7          |
| 2   | Release 0026 → API → 0027 per environment (development first), exactly as in `DATABASE_MIGRATION_REPORT.md` → Deployment order. Commit 0027 separately so step 2 can migrate from a checkout without it. | B1 B3 B4 B7 |

## Limitations

| ID  | Limitation                                    | Status  | Phase | Notes                                                       |
| --- | --------------------------------------------- | ------- | ----- | ----------------------------------------------------------- |
| L1  | No admin panel or moderation                  | Pending | 4     | Unblocks B5, B6.                                            |
| L2  | Calls, voice notes and media not built        | Pending | —     | Out of the approved phases; needs a transport decision.     |
| L3  | Other members' photos never appear            | Pending | 5     | Decision 2.                                                 |
| L4  | No public profile endpoint                    | Pending | 5     | Will use `app.discoverable_to()` / field visibility.        |
| L5  | Proposal / marriage journey and AI layer      | Pending | 5     | AI per ADR 0006 and the existing specification.             |
| L6  | Family / Wali partial                         | Pending | 2, 6  | Invitation flow (B2) in 2; SLA scheduler in 6.              |
| L7  | Play Store blockers (deletion, EAS, policies) | Pending | 7     |                                                             |
| L8  | No push notifications                         | Pending | 6     |                                                             |
| L9  | Interest note can carry contact details       | Pending | 2     | Decision 3.                                                 |
| L10 | ~42 of 95 API paths unbuilt                   | Pending | 5     |                                                             |
| L11 | No background job runner                      | Pending | 6     |                                                             |
| L12 | Testing gaps (E2E, mobile, real device, load) | Pending | 8     | Includes multi-connection concurrency tests for B1/B17 (¹). |

## Dependencies (report section 4)

| Package                  | Where it runs | Status                                                    |
| ------------------------ | ------------- | --------------------------------------------------------- |
| sharp                    | API runtime   | **Fixed** — 0.35.5 (B8)                                   |
| fastify, fast-uri        | API runtime   | Pending — `>=5.12.6`; low/moderate; outside Phase 1 scope |
| tinypool, vite, vitest   | Test only     | Pending — vitest 4 upgrade                                |
| shell-quote, node-forge… | Build tooling | Pending — via Expo CLI                                    |

`pnpm audit` today: 3 critical, 10 high, 17 moderate, 10 low (was 3 / 13 / 17 /
10 before Phase 1). The three remaining criticals are test and build tooling.
