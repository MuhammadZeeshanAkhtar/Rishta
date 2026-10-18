# NikahMate — Entity Inventory

**Status:** ✅ **D8 APPROVED** · 🟡 **D12 PROPOSED** (Family Safety) · **Version:** 0.3 · **Date:** 2026-09-25
**Parent document:** [../README.md](../README.md)

> ## ⚠️ NOTHING IS CREATED
>
> No tables, no migrations, no Supabase project, no credentials.
> This is an inventory for review. Columns, types, relationships, indexes and RLS
> policies come in `docs/ERD.md` **after you approve this list**.

This is the **consolidated** design described in README §14 D8. Where it differs from
the original 110-entity outline, the collapse is marked and the alternative stated, so
you can accept or reject each one individually.

---

## How to read this

### Phase

| Mark      | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| **M1**    | Closed beta — Phases 1–6b–7, ~6–7 months solo                            |
| **M2**    | Public launch — Phases 8–9 + hardening                                   |
| **1.1**   | Next release — proposals, Manager tier, voice notes, selfie verification |
| **1.2**   | Gemini features and payments                                             |
| **later** | Beyond v1.2                                                              |

### Access class — _drives the RLS policy shape_

| Class        | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `public`     | Readable by anyone. No PII.                                                             |
| `owner`      | The acting user's own rows only. Simple `user_id = auth.uid()` policies.                |
| `shared`     | **Permission-resolved.** The authorization service decides what returns. The hard ones. |
| `restricted` | Service-role only. Never reachable from a client, ever.                                 |
| `system`     | Append-only internal records. Written by the server, read by admin and audit.           |

---

## Summary

| Domain                           | Entities | In v1  | In M1  |
| -------------------------------- | -------- | ------ | ------ |
| 1. Identity & account            | 7        | 7      | 6      |
| 2. Profile                       | 3        | 3      | 3      |
| 3. Reference data                | 2        | 2      | 2      |
| 4. Location                      | 2        | 2      | 2      |
| 5. Media                         | 6        | 6      | 5      |
| 6. Preferences                   | 2        | 2      | 2      |
| 7. Discovery & matching          | 7        | 6      | 6      |
| 8. Interest & match              | 4        | 4      | 4      |
| 9. Conversation                  | 9        | 6      | 6      |
| 10. Family / Wali                | 8        | 7      | 5      |
| 11. Proposal & journey           | 5        | 0      | 0      |
| 12. Verification                 | 5        | 3      | 2      |
| 13. Safety & moderation          | 9        | 9      | 3      |
| 14. Notifications                | 5        | 5      | 3      |
| 15. Subscriptions & entitlements | 6        | 4      | 2      |
| 16. AI                           | 5        | 0      | 0      |
| 17. Admin, audit & ops           | 8        | 8      | 1      |
| **Total**                        | **93**   | **74** | **52** |

**52 tables for the closed beta.** That is the number that matters for your next six or seven months.

By access class across the 74 v1 entities: `owner` 20 · `shared` 20 · `restricted` 19 · `system` 12 · `public` 3.
The **20 `shared` entities are where R6 lives** — they carry the permission-resolved policies and need the most test coverage.

> **Revised by [ADR 0011](adr/0011-family-safety-wali-communication.md) (D12).** Family Safety became a core
> layer, so domain 10 grew from 5 entities to 8 and five of them moved into M1. The closed beta went
> from 47 tables to 52. Everything else in this inventory is unchanged from the D8 approval.

---

## 1. Identity & account — 7

| Entity                      | Purpose                                                                                                      | Phase | Access       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ----- | ------------ |
| `users`                     | Core identity. The stable internal UUID every other table references.                                        | M1    | `owner`      |
| `user_auth_links`           | Maps Supabase Auth id(s) to `users.id`. **The indirection that keeps auth replaceable.**                     | M1    | `restricted` |
| `user_devices`              | Registered devices for revoke and security notifications.                                                    | M1    | `owner`      |
| `user_settings`             | Locale, timezone, read-receipt and online-status toggles, display preferences.                               | M1    | `owner`      |
| `user_consents`             | Granular consent records, including the **Article 9 consent for religious data**. Timestamped and versioned. | M1    | `restricted` |
| `security_events`           | Append-only: sign-ins, credential changes, device additions.                                                 | M1    | `system`     |
| `account_deletion_requests` | Erasure workflow with delay window and retention holds for abuse evidence.                                   | M2    | `restricted` |

---

## 2. Profile — 3 ⬅ _consolidated from 6_

| Entity                     | Purpose                                                                                             | Phase | Access       |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `profiles`                 | All discoverable attributes: basics, education, career, marriage, **religious, family, lifestyle**. | M1    | `shared`     |
| `profile_sensitive`        | Phone, email, employer name, exact workplace. **Never present in a discovery read.**                | M1    | `restricted` |
| `profile_field_visibility` | Per-field visibility state: `public` / `matched_only` / `on_request` / `private`.                   | M1    | `owner`      |

> **Consolidation:** `profile_religious`, `profile_family` and `profile_lifestyle` fold into `profiles` as columns.
> **Gain:** discovery is the hottest read path in the product and this removes three joins from it; three fewer policy sets.
> **Cost:** a wider table with some sparse columns.
> **Not consolidated:** `profile_sensitive` stays separate. That is the privacy boundary and it does not move.

---

## 3. Reference data — 2 ⬅ _consolidated from 19_

| Entity                   | Purpose                                                                                                                                                                                                                                                                                                                                       | Phase | Access   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| `reference_items`        | Every coded list in one table, keyed by `type` + `code`: countries, regions, cities, languages, education levels, fields of study, professions, industries, employment statuses, marital statuses, religious practice levels, sects, prayer frequencies, Quran levels, marriage timelines, relocation options, hobbies, lifestyle attributes. | M1    | `public` |
| `reference_translations` | Localised label per item per locale. **Adding a language never requires a release.**                                                                                                                                                                                                                                                          | M1    | `public` |

> **Consolidation:** 19 near-identical tables become 2.
> **Gain:** one migration instead of 19; one admin CRUD screen instead of 19; one policy set. It also **matches the API contract already written** — README §7.2 is a single `GET /reference/:type`, not nineteen endpoints.
> **Cost:** per-type column constraints are replaced by a composite key.
> **Integrity is preserved:** a unique key on `(id, type)` plus a composite FK means a profile's education level still cannot point at a country.

---

## 4. Location — 2

| Entity           | Purpose                                                                                                      | Phase | Access       |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ----- | ------------ |
| `user_locations` | Coarse: country, region, city. **This is what discovery reads.**                                             | M1    | `shared`     |
| `user_geo`       | Exact coordinates (PostGIS geography). Used server-side for distance only. **Never returned to any client.** | M1    | `restricted` |

---

## 5. Media — 6

| Entity                     | Purpose                                                                                            | Phase | Access       |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `photos`                   | Photo records: visibility tier, display order, primary flag, moderation state.                     | M1    | `shared`     |
| `photo_variants`           | Server-generated thumbnail and blurred derivatives. **Blur is generated here, not in the client.** | M1    | `shared`     |
| `photo_grants`             | Explicit per-viewer access grants.                                                                 | M1    | `shared`     |
| `photo_requests`           | Request → approve/decline workflow for private photos.                                             | M1    | `owner`      |
| `photo_views`              | Who viewed which photo and when. Abuse investigation and "who viewed you".                         | M2    | `system`     |
| `media_moderation_results` | Automated upload check outcomes, before a photo becomes visible.                                   | M1    | `restricted` |

---

## 6. Preferences — 2

| Entity                | Purpose                                                                                                 | Phase | Access  |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ----- | ------- |
| `partner_preferences` | The user's stated criteria across every dimension.                                                      | M1    | `owner` |
| `preference_rules`    | Hard vs soft classification and weight per criterion. **Drives filter-vs-rank in the matching engine.** | M1    | `owner` |

---

## 7. Discovery & matching — 7

| Entity                  | Purpose                                                                                                                   | Phase | Access   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| `compatibility_scores`  | Overall score plus per-dimension sub-scores for a viewer/candidate pair.                                                  | M1    | `system` |
| `compatibility_factors` | **The facts behind each sub-score.** Makes explanations regenerable and complaints investigable. Non-negotiable given D6. | M1    | `system` |
| `match_candidates`      | Precomputed candidate sets produced by the nightly scoring job.                                                           | M1    | `system` |
| `profile_views`         | Who viewed whose profile. Feeds "who viewed you" and abuse investigation.                                                 | M1    | `system` |
| `shortlists`            | Saved profiles.                                                                                                           | M1    | `owner`  |
| `dismissed_profiles`    | "Not interested" — permanently hidden from discovery.                                                                     | M1    | `owner`  |
| `profile_embeddings`    | pgvector embeddings for free-text similarity.                                                                             | 1.2   | `system` |

---

## 8. Interest & match — 4

| Entity            | Purpose                                                                              | Phase | Access   |
| ----------------- | ------------------------------------------------------------------------------------ | ----- | -------- |
| `interests`       | Sent interests with status: pending / accepted / declined / maybe-later / withdrawn. | M1    | `shared` |
| `interest_events` | State transition history. Audit and abuse-pattern detection.                         | M1    | `system` |
| `matches`         | Mutual matches. The gate that opens conversation.                                    | M1    | `shared` |
| `match_events`    | Unmatch and match-level state changes.                                               | M1    | `system` |

---

## 9. Conversation — 9

| Entity                      | Purpose                                                                                                       | Phase | Access   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| `conversations`             | One thread per match.                                                                                         | M1    | `shared` |
| `conversation_participants` | Who is in the thread. Extends to wali in 1.1 without restructuring.                                           | M1    | `shared` |
| `conversation_stages`       | Current stage: Introduction → Getting to Know → Marriage Expectations → Family Discussion → Serious Proposal. | M1    | `shared` |
| `stage_transitions`         | Proposed and accepted advances. **Stage changes are mutual and explicit.**                                    | M1    | `system` |
| `messages`                  | Text messages.                                                                                                | M1    | `shared` |
| `message_reads`             | Read receipts, honouring the user's read-receipt setting.                                                     | M1    | `shared` |
| `message_attachments`       | Voice notes and in-chat media.                                                                                | 1.1   | `shared` |
| `message_translations`      | Cached translations, so the same message is never translated twice.                                           | 1.2   | `shared` |
| `conversation_suggestions`  | Generated question suggestions per stage.                                                                     | 1.2   | `owner`  |

---

## 10. Family / Wali — 8 ⬅ _core safety layer (ADR 0011)_

| Entity                     | Purpose                                                                                                              | Phase | Access   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| `family_relationships`     | The granted relationship between an owner and a family member. `tier` is a preset label, not an authorization input. | M1    | `shared` |
| `family_invitations`       | Invite workflow: send, accept, decline, cancel.                                                                      | M1    | `owner`  |
| `family_permissions`       | **The authority on what a delegate may do.** One row per granted permission. Explicit, revocable, auditable.         | M1    | `shared` |
| `family_reviews`           | **NEW.** One review per match per side: approve · reject · request more info · revoke, with who decided and why.     | M1    | `shared` |
| `family_access_log`        | Every delegate action and the permission used, surfaced to the owner. Anti-coercion.                                 | M1    | `system` |
| `family_calls`             | **NEW.** A family-mediated call session attached to a match.                                                         | M2    | `shared` |
| `family_call_participants` | **NEW.** Who is in the call: side, role, relationship, join and leave times.                                         | M2    | `shared` |
| `delegated_actions`        | Manager-tier writes taken on the owner's behalf. `family_access_log` covers M1; this arrives with the tier.          | 1.1   | `system` |

> **Family involvement is no longer a v1 reduction.** ADR 0005 shipped an Observer tier only, to shrink R6.
> [ADR 0011](adr/0011-family-safety-wali-communication.md) reverses that for the review layer: accepting an
> interest no longer opens a conversation, and a delegate holding `approve_communication` stands between the
> two. Five of these tables move into the closed beta as a result.
>
> **Two things did not change.** `family_permissions` and `family_access_log` ship exactly as designed in D8 —
> the permission vocabulary widens, the table shape does not. And `acted_by_user_id` (A7) remains the single
> attribution mechanism across `interests`, `messages`, `reports` and `blocks`.
>
> **Calls are the deferred half.** `family_calls` and `family_call_participants` land at M2, after the text
> gate is proven. Direct owner-to-owner calling is not built in v1 and is gated by a `system_flags` entry
> that is off — a switched-off path gets reviewed before it is switched on; an absent one gets rebuilt under
> deadline pressure.

---

## 11. Proposal & journey — 5 _(none in v1)_

| Entity               | Purpose                                                                 | Phase | Access   |
| -------------------- | ----------------------------------------------------------------------- | ----- | -------- |
| `proposals`          | Formal proposal record.                                                 | 1.1   | `shared` |
| `proposal_terms`     | Intent, timeline, location, relocation, family involvement, next step.  | 1.1   | `shared` |
| `proposal_responses` | Accept / decline / discuss further, with history.                       | 1.1   | `shared` |
| `marriage_journeys`  | Matched → Talking → Families Introduced → Proposal → Engaged → Married. | 1.1   | `owner`  |
| `success_stories`    | Opt-in, moderated.                                                      | later | `public` |

---

## 12. Verification — 5

| Entity                   | Purpose                                                                                         | Phase | Access       |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ----- | ------------ |
| `verification_status`    | Current verification levels per user.                                                           | M1    | `shared`     |
| `verification_requests`  | In-flight verification attempts with outcomes.                                                  | M1    | `owner`      |
| `verification_badges`    | What is publicly claimed and **exactly** what it means. Honest badges are a product commitment. | M2    | `shared`     |
| `verification_documents` | Selfie and ID artefacts. Short retention, tight policies.                                       | 1.1   | `restricted` |
| `kyc_sessions`           | Third-party identity provider sessions.                                                         | later | `restricted` |

---

## 13. Safety & moderation — 9

| Entity                | Purpose                                                                                                              | Phase | Access       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `blocks`              | Bidirectional, invisible to the blocked party.                                                                       | M1    | `owner`      |
| `reports`             | User reports with category.                                                                                          | M1    | `owner`      |
| `report_evidence`     | **Snapshot captured at report time** — messages and profile state as they were, so deletion cannot destroy evidence. | M1    | `restricted` |
| `moderation_cases`    | Grouped investigation across reports and signals.                                                                    | M2    | `restricted` |
| `moderation_actions`  | Decisions taken: warn, restrict, suspend, ban.                                                                       | M2    | `restricted` |
| `moderation_queue`    | The work queue a human works through.                                                                                | M2    | `restricted` |
| `risk_signals`        | Velocity, duplicate-account and anomaly signals.                                                                     | M2    | `restricted` |
| `device_fingerprints` | Duplicate-account detection.                                                                                         | M2    | `restricted` |
| `abuse_rules`         | Configurable detection rules, editable without a release.                                                            | M2    | `restricted` |

> **`blocks`, `reports` and `report_evidence` are in M1** even though the beta is invite-only. An invite-only beta still has real people talking to each other, and the Play Store requires the pipeline at M2 regardless. Retrofitting evidence capture after the fact means the early reports have no evidence.

---

## 14. Notifications — 5

| Entity                     | Purpose                                                                 | Phase | Access       |
| -------------------------- | ----------------------------------------------------------------------- | ----- | ------------ |
| `notifications`            | In-app inbox. **The source of truth**; push is just a delivery channel. | M1    | `owner`      |
| `notification_preferences` | Per-type settings and timezone-aware quiet hours.                       | M1    | `owner`      |
| `push_tokens`              | Device push tokens.                                                     | M1    | `restricted` |
| `notification_templates`   | Localised templates, editable without a release.                        | M2    | `system`     |
| `notification_deliveries`  | Delivery attempts and outcomes. Debugging and deliverability.           | M2    | `system`     |

---

## 15. Subscriptions & entitlements — 6

| Entity              | Purpose                                                                                                 | Phase | Access       |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `user_entitlements` | **Effective entitlements per user.** Feature code asks `can(user, 'x')`, never "is this user premium?". | M1    | `owner`      |
| `usage_counters`    | Quota consumption — daily interests, etc. Needed in M1 because quotas are a v1 feature.                 | M1    | `owner`      |
| `plans`             | Plan definitions with localised pricing.                                                                | M2    | `public`     |
| `plan_entitlements` | What each plan grants.                                                                                  | M2    | `public`     |
| `subscriptions`     | Billing state from the store.                                                                           | 1.2   | `restricted` |
| `payment_events`    | Webhook events from RevenueCat / Play Billing.                                                          | 1.2   | `restricted` |

> The **abstraction ships in v1 with money switched off.** Everyone is on a free plan; quotas are enforced through the same code path that will later enforce premium. Adding payments in 1.2 touches billing, not feature code.

---

## 16. AI — 5 _(none in v1)_

| Entity                  | Purpose                                                                       | Phase | Access       |
| ----------------------- | ----------------------------------------------------------------------------- | ----- | ------------ |
| `ai_runs`               | Model, tokens, cost, latency, outcome for every call. Cost control and audit. | 1.2   | `system`     |
| `ai_moderation_results` | Gemini triage outcomes, with the human decision that followed.                | 1.2   | `restricted` |
| `ai_suggestions`        | Generated suggestions and whether the user accepted them.                     | 1.2   | `owner`      |
| `ai_feedback`           | User feedback on AI output. Tuning signal.                                    | 1.2   | `system`     |
| `ai_cost_budgets`       | Per-user and global ceilings.                                                 | 1.2   | `restricted` |

---

## 17. Admin, audit & ops — 8

| Entity                | Purpose                                                                                    | Phase | Access       |
| --------------------- | ------------------------------------------------------------------------------------------ | ----- | ------------ |
| `system_flags`        | Feature flags, maintenance mode, force-update. Useful from day one.                        | M1    | `restricted` |
| `admin_users`         | Admin accounts, separate from members.                                                     | M2    | `restricted` |
| `roles`               | Support agent, moderator, verification officer, finance, admin, super-admin.               | M2    | `restricted` |
| `permissions`         | Granular permission definitions.                                                           | M2    | `restricted` |
| `role_assignments`    | Who holds which role.                                                                      | M2    | `restricted` |
| `admin_action_audit`  | Actor, target, action, reason, timestamp — every privileged action.                        | M2    | `system`     |
| `pii_access_log`      | **Which moderator viewed which member's PII.** Moderators are a real insider-risk surface. | M2    | `system`     |
| `data_retention_jobs` | Scheduled purges per data class, per the retention policy.                                 | M2    | `system`     |

---

## What this list assumes

These follow from decisions already locked in the README. Flag any you disagree with.

1. **`users.id` is the universal reference**, not the Supabase Auth id — `user_auth_links` is the indirection that keeps auth replaceable.
2. **Reference data is coded, never free text.** A profile stores `edu_bachelors`, not `"Bachelor's Degree"`.
3. **Sensitive data is physically separated** into `restricted` tables, not hidden by a flag on a shared table.
4. **Soft-delete first.** Abuse investigation needs history; hard deletion is a separate deliberate process.
5. **Scores are stored with their inputs** (`compatibility_factors`), because D6 requires explanations to be regenerable and auditable.
6. **Evidence is snapshotted at report time**, so a bad actor deleting their content cannot destroy the case against them.
7. **The entitlement abstraction ships in v1** with money switched off.
8. **A delegate's sight is an intersection, never a union** — `delegate_view(target) = owner_view(target) ∩ delegate_grants`. A family member can never see more of a counterpart than the person they act for (ADR 0011).

---

## Schema decisions — ✅ RESOLVED

All Group A questions are answered (README §15). Net effect on this inventory:

| Q                              | Resolution                                                        | Effect here                                          |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------- |
| **A1** photos default          | Private by default                                                | Default on `photos.visibility`                       |
| **A2** sect / madhhab          | Collected, optional, filterable; "not stated" never auto-excluded | `profiles.sect_code` + a `reference_items` type      |
| **A3** polygyny                | Not supported in v1                                               | **No country-gating tables** — count stays 90        |
| **A7** Manager sends interests | Yes, always visibly attributed                                    | **`acted_by_user_id` on `interests` and `messages`** |
| **A9** multi-valued attributes | **Array columns**, not join tables                                | **No new entities** — count stays 90                 |

> **A gap this review caught:** consolidating profile 6→3 left languages, hobbies and lifestyle attributes — all many-to-many — without a home. Resolved as `text[]` columns of reference codes with GIN indexes rather than three join tables. Had it gone the other way, the inventory would be 93, and discovery would join three extra tables on its hottest read path.

**These decisions left the count at 90.** It moved later, for one reason only — see D12 below.

---

## Decision — ✅ D8 LOCKED

Approved as listed: **90 entities · 71 in v1 · 47 in M1.** Both consolidations taken (reference 19→2, profile 6→3), `profile_sensitive` kept separate as the privacy boundary, `blocks` / `reports` / `report_evidence` and `usage_counters` / `user_entitlements` kept in M1, deferred entities phased as marked.

## Revision — 🟡 D12 PROPOSED _(Family Safety)_

**93 entities · 74 in v1 · 52 in M1.** Three new tables in domain 10
(`family_reviews`, `family_calls`, `family_call_participants`) and five family tables moved
into M1, per [ADR 0011](adr/0011-family-safety-wali-communication.md).

Two columns are added to existing tables rather than modelled as new ones:
`matches.communication_state` (the authorization gate) and
`user_settings.communication_policy` (the owner's choice of whether family review applies).
`match_events` gains `acted_by_user_id` and `relationship_id` so the state machine's history
carries the full attribution chain.

**No existing table is restructured, and no D8 consolidation is reopened.**

Next deliverable: `docs/ERD.md` — columns, types, relationships, indexes and RLS policy outlines. **Still no tables created.**
