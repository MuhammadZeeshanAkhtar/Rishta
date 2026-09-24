# NikahMate — ERD (v1)

**Status:** 🟡 Proposed for review · **Version:** 0.1 · **Date:** 2026-09-24
**Parent:** [../README.md](../README.md) · **Entity inventory:** [ENTITIES.md](ENTITIES.md)

> ## ⚠️ NOTHING IS CREATED
>
> No tables, no migrations, no Supabase project, no credentials, no code.
> This is a design document for review.

**Covers all 71 v1 entities** — M1 and M2 together, not M1 alone. RLS policies cross that
boundary: a moderator reading `messages` (M1) depends on `role_assignments` (M2), so
designing M1 policies in isolation would guarantee rework.

The 19 deferred entities (proposals, AI, payments, embeddings, translations, KYC) are
out of scope here and get their own pass at v1.1.

---

## Table of contents

| §   | Section                                           |
| --- | ------------------------------------------------- |
| 1   | [Conventions](#1-conventions)                     |
| 2   | [RLS strategy](#2-rls-strategy)                   |
| 3   | [Identity & account](#3-identity--account--7)     |
| 4   | [Profile](#4-profile--3)                          |
| 5   | [Reference data](#5-reference-data--2)            |
| 6   | [Location](#6-location--2)                        |
| 7   | [Media](#7-media--6)                              |
| 8   | [Preferences](#8-preferences--2)                  |
| 9   | [Discovery & matching](#9-discovery--matching--6) |
| 10  | [Interest & match](#10-interest--match--4)        |
| 11  | [Conversation](#11-conversation--6)               |

_(Domains 12–17 continue in the second half of this document.)_

---

## 1. Conventions

Applied everywhere unless a table says otherwise. Stated once so the tables below stay readable.

| Convention          | Rule                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary key**     | `id uuid primary key default gen_random_uuid()`                                                                                                                                                         |
| **Timestamps**      | `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` (trigger-maintained). **Always `timestamptz`, never `timestamp`** — this product spans every timezone. |
| **Soft delete**     | `deleted_at timestamptz` on user-content tables. Queries filter it; abuse investigation does not.                                                                                                       |
| **User references** | `references users(id) on delete restrict` — **restrict, not cascade.** Account deletion is a workflow with retention holds (R4), not a cascade that destroys evidence.                                  |
| **Reference codes** | `text` columns holding `reference_items.code`. Validated by the shared Zod schema at the API. Composite FK `(code, type)` where database-level integrity is worth the cost.                             |
| **Multi-valued**    | `text[]` of reference codes with a **GIN index** (A9).                                                                                                                                                  |
| **Enums**           | No Postgres `enum` types — they are painful to alter. Either a `check` constraint for small fixed sets, or `reference_items` for anything a non-developer might change.                                 |
| **Naming**          | `snake_case`, plural tables, `_at` for timestamps, `_code` for reference codes, `_id` for FKs.                                                                                                          |
| **Money**           | None in v1.                                                                                                                                                                                             |

---

## 2. RLS strategy

### 2.1 The identity helper — everything depends on this

`users.id` is **not** `auth.uid()`. That indirection is what keeps Supabase Auth replaceable (README §8 rule 1), and it means every policy needs a resolver:

```sql
create function app.current_user_id() returns uuid
  language sql stable security definer
  set search_path = public
as $$ select user_id from user_auth_links where auth_user_id = auth.uid() $$;
```

**`stable` matters.** It lets Postgres evaluate this once per statement instead of once per row — the difference between a fast discovery query and an unusable one. `user_auth_links.auth_user_id` carries a unique index specifically for this lookup.

### 2.2 Policy pattern per access class

| Class        | Policy shape                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`     | `select` granted to `anon` + `authenticated`. No write policies at all.                                                                                                           |
| `owner`      | `using (user_id = app.current_user_id())` for all four verbs. Mechanical; easy to test.                                                                                           |
| `shared`     | `select` via a `security definer` predicate function (below). **Deny by default** — no permissive fallback policy exists.                                                         |
| `restricted` | **RLS enabled, zero policies.** That is deny-all for every client. Reachable only by the service role, from the explicitly enumerated call sites in `docs/SERVICE_ROLE_USAGE.md`. |
| `system`     | Insert and update by service role only. Owner may `select` their own rows where it makes sense (`security_events`, `family_access_log`).                                          |

### 2.3 The shared predicates

Three functions encapsulate the permission model from README §9.4. They are the **database mirror** of the API's authorization service — the backstop, not the primary control.

```sql
app.is_blocked(a uuid, b uuid) returns boolean        -- checks BOTH directions
app.relationship(viewer uuid, target uuid) returns text
   -- 'self' | 'stranger' | 'interest_pending' | 'match'
   -- | 'own_wali' | 'counterpart_wali' | 'blocked'
app.can_view_profile(viewer uuid, target uuid) returns boolean
```

**`is_blocked` is bidirectional.** A blocks B means neither sees the other. Checking one direction is the single most likely policy bug in this schema, so it lives in one function that every policy calls rather than being re-expressed per table.

**Field-level filtering is not done in RLS.** RLS decides _row_ visibility; `profile_field_visibility` decides _field_ visibility, and that is applied by the API. Attempting per-field RLS in Postgres means column-level grants that cannot express "visible to matches only" — it is the wrong tool.

### 2.4 Non-negotiables

1. Every table has `alter table ... enable row level security` in the same migration that creates it. No table ships without it.
2. `restricted` tables get **zero policies** — the absence is the control.
3. Every policy has a test asserting both the positive and the **negative** case.
4. No policy calls another table's policy — predicates are `security definer` functions to avoid recursion.

---

## 3. Identity & account — 7

#### `users` — core identity, referenced by everything

| Column                 | Type             | Notes                                                                                                |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                   | uuid PK          | The universal reference                                                                              |
| `display_name`         | text NOT NULL    | First name or chosen display name                                                                    |
| `gender`               | text NOT NULL    | `check in ('male','female')`. **Immutable after `profile_completed_at`** — enforced by trigger (A10) |
| `date_of_birth`        | date NOT NULL    | Age is computed, never stored (A11)                                                                  |
| `country_code`         | char(2) NOT NULL | ISO 3166-1 alpha-2                                                                                   |
| `status`               | text NOT NULL    | `onboarding` · `active` · `deactivated` · `suspended` · `banned` · `pending_deletion`                |
| `onboarding_step`      | text             | Resume point — onboarding must survive a dropped connection                                          |
| `profile_completed_at` | timestamptz      | Null means not discoverable                                                                          |

**Indexes:** `(status)` · `(gender, date_of_birth)` — the discovery prefilter, since matching is strictly cross-gender · `(country_code)`
**RLS:** `shared` · **Note:** the gender-immutability trigger is a correctness control, not a convenience — matching, discovery and the entire preference model assume it cannot change.

#### `user_auth_links` — the indirection that keeps auth replaceable

| Column         | Type                 | Notes                                  |
| -------------- | -------------------- | -------------------------------------- |
| `user_id`      | uuid FK → users      |                                        |
| `auth_user_id` | uuid NOT NULL UNIQUE | Supabase `auth.users.id`               |
| `provider`     | text NOT NULL        | `email` · `phone` · `google` · `apple` |
| `linked_at`    | timestamptz          |                                        |

**Indexes:** `unique(auth_user_id)` — **hot path**, read by `app.current_user_id()` on every policy evaluation · `(user_id)`
**RLS:** `restricted`

#### `user_devices`

| Column         | Type            | Notes                 |
| -------------- | --------------- | --------------------- |
| `user_id`      | uuid FK → users |                       |
| `device_id`    | text NOT NULL   | Stable per install    |
| `platform`     | text            | `android` · `ios`     |
| `app_version`  | text            | Drives force-update   |
| `last_seen_at` | timestamptz     |                       |
| `revoked_at`   | timestamptz     | User-initiated revoke |

**Indexes:** `unique(user_id, device_id)` · **RLS:** `owner`

#### `user_settings`

| Column               | Type                          | Notes                                     |
| -------------------- | ----------------------------- | ----------------------------------------- |
| `user_id`            | uuid PK FK → users            | One row per user                          |
| `locale`             | text NOT NULL default `'en'`  |                                           |
| `timezone`           | text NOT NULL default `'UTC'` | IANA. Drives notification quiet hours     |
| `show_online_status` | bool default true             |                                           |
| `send_read_receipts` | bool default true             |                                           |
| `incognito`          | bool default false            | Entitlement-gated                         |
| `discovery_paused`   | bool default false            | "I'm taking a break" without deactivating |

**RLS:** `owner`

#### `user_consents` — R1 lives here

| Column                        | Type            | Notes                                                                               |
| ----------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `user_id`                     | uuid FK → users |                                                                                     |
| `consent_type`                | text NOT NULL   | `terms` · `privacy` · **`article9_religious_data`** · `ai_processing` · `marketing` |
| `version`                     | text NOT NULL   | Which version of the document was consented to                                      |
| `granted`                     | bool NOT NULL   |                                                                                     |
| `granted_at` / `revoked_at`   | timestamptz     |                                                                                     |
| `ip_hash` / `user_agent_hash` | text            | Hashed, not raw — evidence without retaining PII                                    |

**Indexes:** `(user_id, consent_type, granted_at desc)` · **RLS:** `restricted`

> **`article9_religious_data` is a separate consent record, versioned independently.** Religion is GDPR special-category data and this product is built on it. Bundling that consent into a general "I accept the terms" checkbox is the failure mode R1 describes.

#### `security_events` — append-only

| Column                        | Type            | Notes                                                                                     |
| ----------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `user_id`                     | uuid FK → users |                                                                                           |
| `event_type`                  | text NOT NULL   | `sign_in` · `sign_out` · `password_change` · `email_change` · `new_device` · `mfa_change` |
| `ip_hash` / `user_agent_hash` | text            |                                                                                           |
| `metadata`                    | jsonb           |                                                                                           |

**Indexes:** `(user_id, created_at desc)` · **RLS:** `system` — owner may `select` own; no client write, ever. No `update` or `delete` policy exists on this table at all.

#### `account_deletion_requests` _(M2)_

| Column                           | Type            | Notes                                           |
| -------------------------------- | --------------- | ----------------------------------------------- |
| `user_id`                        | uuid FK → users |                                                 |
| `requested_at` / `scheduled_for` | timestamptz     | Grace period before execution                   |
| `status`                         | text            | `pending` · `held` · `executed` · `cancelled`   |
| `retention_hold_reason`          | text            | **R4** — an open moderation case blocks erasure |
| `executed_at`                    | timestamptz     |                                                 |

**RLS:** `restricted`

---

## 4. Profile — 3

#### `profiles` — consolidated from 6 tables (D8)

One row per user. Everything discovery reads.

| Group          | Columns                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free text**  | `about_me text` · `looking_for text`                                                                                                                                            |
| **Basics**     | `nationality_code char(2)` · `languages text[]` · `height_cm int`                                                                                                               |
| **Marriage**   | `marital_status_code text NOT NULL` · `has_children bool` · `children_count int` · `children_live_with_me bool` · `wants_children_code text` · `marriage_timeline_code text`    |
| **Relocation** | `relocation_willingness_code text` · `relocation_target_countries text[]`                                                                                                       |
| **Education**  | `education_level_code text` · `field_of_study_code text` · `institution text`                                                                                                   |
| **Career**     | `profession_code text` · `industry_code text` · `employment_status_code text`                                                                                                   |
| **Religious**  | `religious_practice_code text` · **`sect_code text NULL`** (A2 — null means _not stated_) · `prayer_frequency_code text` · `quran_level_code text` · `dress_practice_code text` |
| **Family**     | `family_religiosity_code text` · `living_with_family_expectation_code text` · `family_background text`                                                                          |
| **Lifestyle**  | `hobbies text[]` · `lifestyle_attributes text[]` · `personality_traits text[]` · `diet_code text` · `smoking_code text`                                                         |
| **State**      | `completion_score int` · `review_status text` (`draft`/`pending`/`approved`/`rejected`)                                                                                         |

**Indexes:**

- **GIN** on `languages`, `hobbies`, `lifestyle_attributes`, `personality_traits`, `relocation_target_countries` (A9)
- btree on `marital_status_code`, `religious_practice_code`, `marriage_timeline_code`, `education_level_code`
- Partial: `(user_id) where review_status = 'approved' and deleted_at is null` — the discovery working set

**RLS:** `shared` via `app.can_view_profile()`

> **`sect_code` is nullable and that is load-bearing.** Null means "not stated", and per A2 a null must never be filtered out by someone else's sect preference unless they explicitly opt in. The guard is `partner_preferences.exclude_unstated_sect`, defaulting to **false**.

#### `profile_sensitive` — the privacy boundary

| Column           | Type               | Notes |
| ---------------- | ------------------ | ----- |
| `user_id`        | uuid PK FK → users |       |
| `phone_e164`     | text               |       |
| `email`          | text               |       |
| `employer_name`  | text               |       |
| `workplace_city` | text               |       |

**RLS:** `restricted` — **zero policies.**

> This table exists so that "hide my workplace" is _structurally_ true rather than a flag someone forgets to check. No discovery query can reach it, because no client can reach it at all. Revealing any field is an explicit API action against an explicit grant.

#### `profile_field_visibility`

| Column       | Type            | Notes                                                |
| ------------ | --------------- | ---------------------------------------------------- |
| `user_id`    | uuid FK → users | Composite PK with `field_key`                        |
| `field_key`  | text            | e.g. `profession`, `institution`, `city`             |
| `visibility` | text NOT NULL   | `public` · `matched_only` · `on_request` · `private` |

**Indexes:** `primary key (user_id, field_key)` · **RLS:** `owner`
**Applied by the API**, not by RLS — see §2.3.

---

## 5. Reference data — 2

#### `reference_items` — 19 tables collapsed into one (D8)

| Column       | Type              | Notes                                                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | uuid PK           |                                                                                                                                                                                                                                                                                                                                 |
| `type`       | text NOT NULL     | `country` · `language` · `education_level` · `profession` · `industry` · `employment_status` · `marital_status` · `religious_practice` · `sect` · `prayer_frequency` · `quran_level` · `marriage_timeline` · `relocation_option` · `hobby` · `lifestyle_attribute` · `personality_trait` · `field_of_study` · `region` · `city` |
| `code`       | text NOT NULL     | Stable. `edu_bachelors`, never `"Bachelor's Degree"`                                                                                                                                                                                                                                                                            |
| `parent_id`  | uuid FK → self    | Country → region → city                                                                                                                                                                                                                                                                                                         |
| `sort_order` | int               |                                                                                                                                                                                                                                                                                                                                 |
| `metadata`   | jsonb             | ISO codes, dial codes, gender applicability                                                                                                                                                                                                                                                                                     |
| `active`     | bool default true | Retire without deleting                                                                                                                                                                                                                                                                                                         |

**Indexes:** `unique(type, code)` · `unique(id, type)` — **this is what makes composite FKs possible**, so `profiles.education_level_code` cannot point at a country · `(type, sort_order) where active`
**RLS:** `public` select

#### `reference_translations`

| Column              | Type                      | Notes |
| ------------------- | ------------------------- | ----- |
| `reference_item_id` | uuid FK → reference_items |       |
| `locale`            | text NOT NULL             |       |
| `label`             | text NOT NULL             |       |
| `description`       | text                      |       |

**Indexes:** `unique(reference_item_id, locale)` · **RLS:** `public` select

> **Adding a language is inserting rows, never a release.** That is the whole point of the split.

---

## 6. Location — 2

#### `user_locations` — what discovery reads

| Column              | Type                      | Notes                                                                    |
| ------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `user_id`           | uuid PK FK → users        |                                                                          |
| `country_code`      | char(2) NOT NULL          |                                                                          |
| `region_code`       | text                      |                                                                          |
| `city_name`         | text                      |                                                                          |
| `city_ref_id`       | uuid FK → reference_items | Null for cities not in the reference set                                 |
| `display_precision` | text                      | `city` · `region` · `country` — the user's choice of how exact to appear |

**Indexes:** `(country_code, region_code)` · **RLS:** `shared`

#### `user_geo` — never leaves the server

| Column       | Type                             | Notes   |
| ------------ | -------------------------------- | ------- |
| `user_id`    | uuid PK FK → users               |         |
| `point`      | `geography(Point,4326)` NOT NULL | PostGIS |
| `accuracy_m` | int                              |         |

**Indexes:** GIST on `point` · **RLS:** `restricted` — zero policies

> Distance is computed server-side and returned as a **banded** value ("within 25 km"), never as coordinates and never as an exact figure. An exact distance from a known point is a trilateration attack waiting to happen: three exact readings locate a home address.

---

## 7. Media — 6

#### `photos`

| Column              | Type                              | Notes                                                                |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `user_id`           | uuid FK → users                   |                                                                      |
| `storage_path`      | text NOT NULL                     | Private bucket. **Never a public URL**                               |
| `visibility`        | text NOT NULL default `'private'` | **A1** — `public` · `blurred` · `on_request` · `private`             |
| `position`          | int                               | Display order                                                        |
| `is_primary`        | bool                              |                                                                      |
| `moderation_status` | text NOT NULL default `'pending'` | `pending` · `approved` · `rejected` — **not visible until approved** |
| `width` / `height`  | int                               |                                                                      |

**Indexes:** `(user_id, position) where deleted_at is null` · `(moderation_status) where moderation_status = 'pending'` — the moderation queue
**RLS:** `shared`

#### `photo_variants`

| Column         | Type             | Notes                        |
| -------------- | ---------------- | ---------------------------- |
| `photo_id`     | uuid FK → photos |                              |
| `variant`      | text NOT NULL    | `thumb` · `blurred` · `full` |
| `storage_path` | text NOT NULL    |                              |

**Indexes:** `unique(photo_id, variant)` · **RLS:** `shared`, follows parent

> **The `blurred` variant is a separate stored file, generated server-side at upload.** A client-side blur means the real image already reached the device — the privacy control would be decorative.

#### `photo_grants`

| Column                      | Type             | Notes                                        |
| --------------------------- | ---------------- | -------------------------------------------- |
| `photo_id`                  | uuid FK → photos | Null means "all my private photos"           |
| `owner_user_id`             | uuid FK → users  | Denormalised so grants are revocable in bulk |
| `grantee_user_id`           | uuid FK → users  |                                              |
| `granted_at` / `revoked_at` | timestamptz      |                                              |

**Indexes:** `unique(photo_id, grantee_user_id)` · `(owner_user_id, grantee_user_id)` · **RLS:** `shared`

#### `photo_requests`

| Column                                | Type            | Notes                                             |
| ------------------------------------- | --------------- | ------------------------------------------------- |
| `requester_user_id` / `owner_user_id` | uuid FK → users |                                                   |
| `status`                              | text            | `pending` · `approved` · `declined` · `withdrawn` |
| `message`                             | text            |                                                   |
| `responded_at`                        | timestamptz     |                                                   |

**Indexes:** `unique(requester_user_id, owner_user_id) where status = 'pending'` — one open request at a time, which is also the anti-nagging control
**RLS:** `owner` on both sides

#### `photo_views` _(M2)_

`photo_id` · `viewer_user_id` · `viewed_at` · **Indexes:** `(photo_id, viewed_at desc)` · `(viewer_user_id)` · **RLS:** `system`

#### `media_moderation_results`

`photo_id` · `provider` · `verdict` · `labels jsonb` · `reviewed_by_admin_id` · `reviewed_at` · **RLS:** `restricted`

---

## 8. Preferences — 2

#### `partner_preferences`

| Group                   | Columns                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Age / physical**      | `age_min int` · `age_max int` · `height_min_cm int` · `height_max_cm int`                                                  |
| **Location**            | `country_codes text[]` · `max_distance_km int`                                                                             |
| **Language**            | `language_codes text[]`                                                                                                    |
| **Education / career**  | `education_level_codes text[]` · `profession_codes text[]`                                                                 |
| **Religious**           | `religious_practice_codes text[]` · `sect_codes text[]` · **`exclude_unstated_sect bool NOT NULL default false`**          |
| **Marriage**            | `marital_status_codes text[]` · `accepts_children bool` · `wants_children_codes text[]` · `marriage_timeline_codes text[]` |
| **Relocation / family** | `relocation_required bool` · `living_with_family_codes text[]`                                                             |

**Indexes:** `user_id` PK · GIN on the filter arrays used by the reverse-match (reciprocity) query
**RLS:** `owner`

> **`exclude_unstated_sect` defaulting to `false` is the A2 guard, in the schema.** Someone who states a sect preference still sees profiles that left it blank, unless they deliberately opt out. Silence does not cost you visibility.

#### `preference_rules`

| Column      | Type            | Notes                                  |
| ----------- | --------------- | -------------------------------------- |
| `user_id`   | uuid FK → users |                                        |
| `criterion` | text NOT NULL   | Matches a key in `partner_preferences` |
| `is_hard`   | bool NOT NULL   | **Hard filters out. Soft only ranks.** |
| `weight`    | numeric         | Soft-preference weight, 0–1            |

**Indexes:** `unique(user_id, criterion)` · **RLS:** `owner`

---

## 9. Discovery & matching — 6

#### `compatibility_scores`

| Column                                 | Type             | Notes                                                                            |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `viewer_user_id` / `candidate_user_id` | uuid FK → users  | Directional — A's score for B differs from B's for A, because preferences differ |
| `overall`                              | numeric NOT NULL | 0–100                                                                            |
| `engine_version`                       | text NOT NULL    | **Which scoring version produced this**                                          |
| `computed_at`                          | timestamptz      |                                                                                  |

**Indexes:** `unique(viewer_user_id, candidate_user_id)` · `(viewer_user_id, overall desc)` — the ranking read
**RLS:** `system`

> **Scores are directional, and `engine_version` is not optional.** When the weights change, you need to know which rows were produced by which version — otherwise a user asking "why did my matches change?" has no answer, and you cannot compare engine versions against real accept rates.

#### `compatibility_factors` — what makes D6 work

| Column            | Type                           | Notes                                                                                                                                                |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `score_id`        | uuid FK → compatibility_scores |                                                                                                                                                      |
| `dimension`       | text NOT NULL                  | `religious` · `timeline` · `relocation` · `children` · `family` · `language` · `location` · `education` · `profession` · `lifestyle` · `reciprocity` |
| `sub_score`       | numeric NOT NULL               |                                                                                                                                                      |
| `facts`           | jsonb NOT NULL                 | **The actual values compared**                                                                                                                       |
| `explanation_key` | text                           | i18n key for the rendered reason                                                                                                                     |

**Indexes:** `(score_id)` · **RLS:** `system`

> This table is why explanations are truthful rather than plausible. `facts` stores what was compared — both timelines, both relocation answers, the language overlap — so the reason shown is regenerated from the comparison rather than narrated after it. It is also the only way to investigate a complaint months later.

#### `match_candidates` — nightly precompute

`user_id` · `candidate_user_id` · `section_key` · `rank int` · `batch_id uuid` · **Indexes:** `(user_id, section_key, rank)` · `(batch_id)` for atomic swap · **RLS:** `system`

#### `profile_views`

`viewer_user_id` · `viewed_user_id` · `viewed_at` · `source text` · **Indexes:** `(viewed_user_id, viewed_at desc)` · `(viewer_user_id, viewed_at desc)` · **RLS:** `system`
Incognito viewers are recorded but suppressed from "who viewed you" — recording is for abuse investigation, and suppression is an API concern.

#### `shortlists`

`user_id` · `target_user_id` · **Indexes:** `unique(user_id, target_user_id)` · **RLS:** `owner`

#### `dismissed_profiles`

`user_id` · `target_user_id` · **Indexes:** `unique(user_id, target_user_id)` · **RLS:** `owner`
Excluded from discovery permanently. Never surfaced to the dismissed party.

---

## 10. Interest & match — 4

#### `interests`

| Column                                 | Type                 | Notes                                                             |
| -------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| `sender_user_id` / `recipient_user_id` | uuid FK → users      |                                                                   |
| **`acted_by_user_id`**                 | uuid NULL FK → users | **A7** — null means the owner acted; set means a delegate did     |
| `status`                               | text NOT NULL        | `pending` · `accepted` · `declined` · `maybe_later` · `withdrawn` |
| `note`                                 | text                 | Optional message with the interest                                |
| `responded_at`                         | timestamptz          |                                                                   |

**Indexes:** `unique(sender_user_id, recipient_user_id) where status <> 'withdrawn'` · `(recipient_user_id, status, created_at desc)` — the inbox read
**RLS:** `shared`

> **`acted_by_user_id` must be returned by the API, not merely stored.** The A7 decision allows a Manager delegate to send and reply, and the entire honesty case for that rests on the recipient seeing _who actually acted_. A column that never reaches the UI would make delegation covert, which is exactly the failure the wali design is built to avoid.

#### `interest_events`

`interest_id` · `event text` · `actor_user_id` · `acted_by_user_id` · **Indexes:** `(interest_id, created_at)` · **RLS:** `system`

#### `matches`

| Column                                         | Type                | Notes                                  |
| ---------------------------------------------- | ------------------- | -------------------------------------- |
| `user_a_id` / `user_b_id`                      | uuid FK → users     | **Ordered so `user_a_id < user_b_id`** |
| `interest_id`                                  | uuid FK → interests | What created it                        |
| `ended_at` / `ended_by_user_id` / `end_reason` |                     |                                        |

**Indexes:** `unique(user_a_id, user_b_id)` · `(user_a_id) where ended_at is null` · `(user_b_id) where ended_at is null`
**RLS:** `shared`

> **The ordering constraint is what makes the unique index work.** Without it, (A,B) and (B,A) are different rows and duplicate matches become possible. Enforced by a check constraint, not by convention.

#### `match_events`

`match_id` · `event` · `actor_user_id` · **RLS:** `system`

---

## 11. Conversation — 6

#### `conversations`

`match_id uuid FK unique` · `last_message_at timestamptz` · `status text` (`active`/`archived`/`ended`)
**Indexes:** `unique(match_id)` · `(last_message_at desc)` · **RLS:** `shared`

#### `conversation_participants`

| Column                  | Type                       | Notes                                                                  |
| ----------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `conversation_id`       | uuid FK → conversations    |                                                                        |
| `user_id`               | uuid FK → users            |                                                                        |
| `role`                  | text NOT NULL              | `principal` · `wali` — wali rows arrive in 1.1, the shape is ready now |
| `can_write`             | bool NOT NULL default true | A wali Observer would be false                                         |
| `joined_at` / `left_at` | timestamptz                |                                                                        |

**Indexes:** `unique(conversation_id, user_id)` · `(user_id) where left_at is null` — **the membership check every message policy runs**
**RLS:** `shared`

#### `conversation_stages`

`conversation_id uuid PK FK` · `current_stage int NOT NULL default 1` (1–5) · **RLS:** `shared`

#### `stage_transitions`

`conversation_id` · `from_stage` / `to_stage int` · `proposed_by_user_id` · `status text` (`pending`/`accepted`/`declined`) · `responded_by_user_id` · **Indexes:** `(conversation_id, created_at desc)` · **RLS:** `system`
Stage advancement is mutual: a proposal row that the counterpart must accept.

#### `messages`

| Column                     | Type                    | Notes                                                    |
| -------------------------- | ----------------------- | -------------------------------------------------------- |
| `conversation_id`          | uuid FK → conversations |                                                          |
| `sender_user_id`           | uuid FK → users         |                                                          |
| **`acted_by_user_id`**     | uuid NULL FK → users    | **A7** — same rule as `interests`                        |
| `body`                     | text                    |                                                          |
| `moderation_status`        | text default `'clean'`  | `clean` · `flagged` · `blocked`                          |
| `edited_at` / `deleted_at` | timestamptz             | Soft delete — **`report_evidence` snapshots survive it** |

**Indexes:** `(conversation_id, created_at desc)` — the only read pattern that matters · `(moderation_status) where moderation_status = 'flagged'`
**RLS:** `shared` — membership in `conversation_participants`, plus moderator access via `role_assignments`

> **This is the policy that crosses the M1/M2 boundary** and the reason this ERD covers all 71 entities rather than M1's 47. `messages` ships in M1; the moderator branch of its policy depends on `role_assignments`, which ships in M2. Designing it once is cheaper than designing it twice.

#### `message_reads`

`conversation_id` · `user_id` · `last_read_message_id` · `last_read_at` · **Indexes:** `unique(conversation_id, user_id)` · **RLS:** `shared`
Honours `user_settings.send_read_receipts` — suppression is applied by the API, since the row must exist regardless for unread counts.

---

_Domains 12–17, the RLS test matrix, performance notes and open items continue below._

---

## 12. Family / Wali — 4 _(M2, Observer tier only)_

#### `family_relationships`

| Column              | Type            | Notes                                                                       |
| ------------------- | --------------- | --------------------------------------------------------------------------- |
| `owner_user_id`     | uuid FK → users | Whose profile this is about                                                 |
| `delegate_user_id`  | uuid FK → users | The family member                                                           |
| `relationship_code` | text            | `father` · `mother` · `brother` · `sister` · `guardian` · `other`           |
| `tier`              | text NOT NULL   | `observer` · `participant` · `manager` — **v1 only ever writes `observer`** |
| `status`            | text NOT NULL   | `active` · `revoked`                                                        |
| `revoked_at`        | timestamptz     |                                                                             |

**Indexes:** `unique(owner_user_id, delegate_user_id)` · `(delegate_user_id) where status = 'active'` — supports A6 naturally, since one delegate can hold many rows
**RLS:** `shared`

> **A check constraint pins `tier = 'observer'` in v1** and is relaxed in 1.1. This is deliberate: the column exists so 1.1 extends rather than migrates, but the constraint means a bug cannot accidentally grant Manager rights to a tier whose authorization logic has not been written yet.

#### `family_invitations`

| Column                       | Type                 | Notes                                                         |
| ---------------------------- | -------------------- | ------------------------------------------------------------- |
| `owner_user_id`              | uuid FK → users      |                                                               |
| `invitee_contact`            | text NOT NULL        | Email or E.164 phone                                          |
| `invitee_user_id`            | uuid NULL FK → users | Set once they accept                                          |
| `relationship_code` / `tier` | text                 | What is being offered                                         |
| `token_hash`                 | text NOT NULL        | **Hashed, never stored raw**                                  |
| `status`                     | text                 | `pending` · `accepted` · `declined` · `expired` · `cancelled` |
| `expires_at`                 | timestamptz NOT NULL |                                                               |

**Indexes:** `(token_hash)` · `(owner_user_id, status)` · **RLS:** `owner`

#### `family_permissions`

`relationship_id uuid FK` · `permission text` · `granted bool`
**Indexes:** `unique(relationship_id, permission)` · **RLS:** `shared`
v1 seeds only `view_profile` and `view_matches`. The 1.1 set adds `view_conversation`, `participate`, `receive_proposals`, `manage_profile`.

#### `family_access_log`

`relationship_id` · `delegate_user_id` · `owner_user_id` · `action` · `resource_type` · `resource_id`
**Indexes:** `(owner_user_id, created_at desc)` · **RLS:** `system` — **the owner can read their own.** Every delegate action is visible to the person it concerns. That is the anti-coercion control, and it only works if it is surfaced in the app, not merely recorded.

---

## 13. Verification — 3

#### `verification_status`

`user_id uuid PK FK` · `email_verified_at` · `phone_verified_at` · `selfie_verified_at` _(1.1)_ · `id_verified_at` _(later)_ · `profile_reviewed_at`
**RLS:** `shared` — only the **timestamps' presence** is exposed, never the underlying artefacts.

#### `verification_requests`

`user_id` · `kind text` · `status text` · `provider` · `provider_ref` · `resolved_at` · `failure_reason`
**Indexes:** `(user_id, kind, created_at desc)` · **RLS:** `owner`

#### `verification_badges` _(M2)_

`user_id` · `badge_key` · `label_key` · `earned_at` · `revoked_at` · **RLS:** `shared`

> **`label_key` is an i18n key, not a label**, and each badge names exactly what was checked — "Phone verified", not a generic "Verified ✓". A badge implying more than was actually confirmed is the fastest way to lose trust in this category, and it is a schema-level commitment here rather than a UI convention.

---

## 14. Safety & moderation — 9

#### `blocks`

`blocker_user_id` · `blocked_user_id` · `reason_code text`
**Indexes:** `unique(blocker_user_id, blocked_user_id)` · **`(blocked_user_id)`** — needed because `app.is_blocked()` checks **both** directions on every shared read
**RLS:** `owner` — the blocker only. The blocked party must never be able to detect the block, so they get no read path at all.

#### `reports`

| Column                                  | Type            | Notes                                                                                                        |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `reporter_user_id` / `reported_user_id` | uuid FK → users |                                                                                                              |
| `category`                              | text NOT NULL   | `scam` · `harassment` · `impersonation` · `fake_profile` · `inappropriate_content` · `misrepresented_status` |
| `description`                           | text            |                                                                                                              |
| `context_type` / `context_id`           | text / uuid     | Conversation, message, photo or profile                                                                      |
| `status`                                | text            | `open` · `triaged` · `actioned` · `dismissed`                                                                |
| `outcome`                               | text            |                                                                                                              |

**Indexes:** `(status, created_at)` — the queue · `(reported_user_id)` — pattern detection across reports
**RLS:** `owner` — the reporter sees their own and its outcome. The reported party sees nothing.

#### `report_evidence`

`report_id uuid FK` · `snapshot jsonb NOT NULL` · `captured_at`
**RLS:** `restricted`

> **Captured at report time, by value, not by reference.** If evidence were foreign keys into `messages`, a bad actor deleting their messages would destroy the case against them. The snapshot is immutable and survives the soft-delete of everything it describes — which is also why `account_deletion_requests.retention_hold_reason` exists (R4).

#### `moderation_cases` _(M2)_

`subject_user_id` · `status` · `severity` · `assigned_to_admin_id` · `opened_at` / `closed_at` · **Indexes:** `(status, severity, opened_at)` · **RLS:** `restricted`

#### `moderation_actions` _(M2)_

`case_id` · `action text` (`warn`/`restrict`/`suspend`/`ban`/`clear`) · `actor_admin_id` · `reason text NOT NULL` · `expires_at` · **RLS:** `restricted`
`reason` is NOT NULL deliberately — an unexplained ban is unappealable.

#### `moderation_queue` _(M2)_

`item_type` · `item_id` · `priority int` · `status` · `claimed_by_admin_id` · `claimed_at` · **Indexes:** `(status, priority desc, created_at) where status = 'pending'` · **RLS:** `restricted`

#### `risk_signals` _(M2)_

`user_id` · `signal_type` · `score numeric` · `details jsonb` · **Indexes:** `(user_id, created_at desc)` · `(signal_type, score desc)` · **RLS:** `restricted`

#### `device_fingerprints` _(M2)_

`user_id` · `fingerprint_hash` · `first_seen_at` / `last_seen_at`
**Indexes:** `(fingerprint_hash)` — **the duplicate-account query**: one fingerprint across many users · `(user_id)` · **RLS:** `restricted`

#### `abuse_rules` _(M2)_

`rule_key` · `config jsonb` · `enabled bool` · **RLS:** `restricted`
Tunable without a release — scam patterns change faster than app store review.

---

## 15. Notifications — 5

#### `notifications` — the inbox, and the source of truth

`user_id` · `type text` · `payload jsonb` · `read_at timestamptz`
**Indexes:** `(user_id, created_at desc)` · `(user_id) where read_at is null` — the badge count · **RLS:** `owner`

#### `notification_preferences`

`user_id` · `type text` · `push_enabled bool` · `inapp_enabled bool` · `quiet_hours_start time` · `quiet_hours_end time`
**Indexes:** `unique(user_id, type)` · **RLS:** `owner`
Quiet hours are evaluated against `user_settings.timezone`, not the server's.

#### `push_tokens`

`user_id` · `device_id` · `token text` · `platform` · `invalidated_at`
**Indexes:** `unique(user_id, device_id)` · **RLS:** `restricted` — a push token is a capability to reach a device, so no client reads them.

#### `notification_templates` _(M2)_

`type` · `locale` · `title_template` · `body_template` · **Indexes:** `unique(type, locale)` · **RLS:** `system`

#### `notification_deliveries` _(M2)_

`notification_id` · `channel` · `status` · `provider_ref` · `error` · **RLS:** `system`

---

## 16. Subscriptions & entitlements — 4

#### `user_entitlements`

`user_id` · `entitlement_key text` · `value jsonb` · `source text` (`plan`/`grant`/`promo`) · `expires_at`
**Indexes:** `unique(user_id, entitlement_key)` · **RLS:** `owner` select only; all writes service-role

#### `usage_counters`

`user_id` · `counter_key text` · `period_start date` · `count int NOT NULL default 0`
**Indexes:** `unique(user_id, counter_key, period_start)` · **RLS:** `owner` select only; writes service-role

> **`daily_interests` seeds at 5 per day on the free plan (A5).** Incrementing is an atomic `insert ... on conflict do update set count = count + 1` inside the same transaction as the interest itself — otherwise two concurrent requests both read 4 and both succeed, and the quota is advisory rather than real.

#### `plans` _(M2)_ / `plan_entitlements` _(M2)_

`plan_key` · `active` · `sort_order` — and `plan_id` · `entitlement_key` · `value jsonb`
**RLS:** `public`

---

## 17. Admin, audit & ops — 8

#### `system_flags`

`key text unique` · `value jsonb` · `client_visible bool NOT NULL default false`
**RLS:** `public` select **through a view filtered to `client_visible = true`**; the base table is `restricted`. Force-update and maintenance mode need to reach an unauthenticated client; nothing else does.

#### `admin_users` _(M2)_

`user_id uuid NULL FK → users` · `email` · `mfa_enabled bool NOT NULL` · `status` · `last_login_at`
**RLS:** `restricted` — separate surface, mandatory 2FA (README §9.1).

#### `roles` / `permissions` / `role_assignments` _(M2)_

`role_key` · `description` — `permission_key` · `description` — `admin_user_id` · `role_id` · `granted_by` · `granted_at` · `expires_at`
**Indexes:** `unique(admin_user_id, role_id)` · **`(admin_user_id)`** — read by the moderator branch of every `shared` policy, so it must be fast
**RLS:** `restricted`

#### `admin_action_audit` _(M2)_

`admin_user_id` · `action` · `target_type` · `target_id` · `reason` · `metadata jsonb`
**Indexes:** `(admin_user_id, created_at desc)` · `(target_type, target_id)` · **RLS:** `system`, append-only

#### `pii_access_log` _(M2)_

`admin_user_id` · `subject_user_id` · `fields text[]` · `justification text` · `accessed_at`
**Indexes:** `(subject_user_id, accessed_at desc)` · `(admin_user_id, accessed_at desc)` · **RLS:** `system`

> Moderators are a genuine insider-risk surface. This table is what makes "who looked at this member's phone number, and why" answerable — and reviewable.

#### `data_retention_jobs` _(M2)_

`data_class` · `policy jsonb` · `last_run_at` · `rows_affected` · **RLS:** `system`

---

## 18. RLS test matrix

Mandatory in CI. Every `shared` table is tested against every viewer relationship, **positive and negative**.

| Viewer relationship            | profiles            | photos             | messages      | interests   | matches      | family_*    |
| ------------------------------ | ------------------- | ------------------ | ------------- | ----------- | ------------ | ----------- |
| self                           | ✅ full             | ✅ full            | ✅ own convos | ✅ own      | ✅ own       | ✅ own      |
| stranger, approved profile     | ✅ visible fields   | ⛔ unless `public` | ⛔            | ⛔          | ⛔           | ⛔          |
| stranger, profile not approved | ⛔                  | ⛔                 | ⛔            | ⛔          | ⛔           | ⛔          |
| interest pending               | ✅ visible fields   | ⛔ unless granted  | ⛔            | ✅ that one | ⛔           | ⛔          |
| mutual match                   | ✅ + `matched_only` | ✅ + granted       | ✅ that convo | ✅          | ✅           | ⛔          |
| **blocked (either direction)** | ⛔                  | ⛔                 | ⛔            | ⛔          | ⛔           | ⛔          |
| own wali (observer)            | ✅ per grant        | ⛔                 | ⛔            | ⛔          | ✅ per grant | ✅ own      |
| counterpart's wali             | ⛔                  | ⛔                 | ⛔            | ⛔          | ⛔           | ⛔          |
| moderator                      | ✅ via role         | ✅ via role        | ✅ via role   | ✅ via role | ✅ via role  | ✅ via role |
| deactivated / banned subject   | ⛔                  | ⛔                 | ⛔            | ⛔          | ⛔           | ⛔          |

**The row that catches the most bugs is `blocked (either direction)`.** Every one of those cells must be tested in _both_ directions — A blocks B, and B blocks A — because the asymmetric case is the one that slips through.

---

## 19. Performance notes

| Concern                     | Approach                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discovery read**          | Served from precomputed `match_candidates`, never a live scan. The nightly job does the work; the request does a ranked lookup.                                        |
| **`app.current_user_id()`** | `stable` + unique index on `user_auth_links.auth_user_id`. Evaluated once per statement, not per row.                                                                  |
| **Array filters**           | GIN indexes on every `text[]` used in matching. `&&` (overlap) for "any shared language", `@>` for "has all of".                                                       |
| **Geo**                     | GIST on `user_geo.point`. Distance computed server-side, returned **banded**.                                                                                          |
| **Connection limits**       | Supavisor in transaction mode. One Node instance means a small, predictable pool (R10).                                                                                |
| **Message paging**          | Keyset pagination on `(conversation_id, created_at desc)`. Never `offset` — it degrades linearly on the longest conversations, which belong to the most engaged users. |
| **Counter contention**      | `usage_counters` updated via atomic upsert inside the caller's transaction.                                                                                            |

---

## 20. E1–E6 — ✅ RESOLVED

### E1 — Retention policy per data class

**Governing principle: erasure anonymises, it does not destroy a counterpart's data.** A conversation belongs to two people. When A deletes their account, A's messages are reattributed to a tombstone and A's identifiers are removed — but B keeps their conversation. That is defensible under GDPR because what remains is B's personal data, not A's.

| Data class                               | Retention                           | Basis                                                                      |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `report_evidence`                        | **5 years** from case closure       | Abuse-pattern evidence and legal claims                                    |
| `moderation_cases`, `moderation_actions` | 5 years from closure                | Same                                                                       |
| `admin_action_audit`                     | 7 years                             | Corporate accountability                                                   |
| `pii_access_log`                         | **24 months**                       | Insider abuse surfaces late — longer than security events on purpose       |
| `security_events`                        | 12 months                           | Security investigation window, then minimise                               |
| `device_fingerprints`                    | 24 months from last seen            | Duplicate-account detection needs history                                  |
| `profile_views`, `photo_views`           | 12 months                           | Product utility plus abuse investigation                                   |
| `notifications`                          | 12 months                           |                                                                            |
| Soft-deleted `messages`                  | **90 days**, then hard purge        | Unless under retention hold                                                |
| Soft-deleted `profiles`                  | 30 days, then anonymise             | Doubles as the account-recovery window                                     |
| `user_geo`                               | **Current value only — no history** | The single most sensitive record here. Location history is never retained. |
| `verification_documents` _(1.1)_         | **30 days** after the decision      | You need the artefact to decide, not to keep                               |
| `ai_runs` _(1.2)_                        | 90 days                             | Cost and debugging window                                                  |
| Deactivated accounts                     | Indefinite while deactivated        | The user chose to pause, not leave                                         |
| Deletion request → execution             | **30-day grace**, then anonymise    | Reversible until executed                                                  |

**Retention holds.** An open moderation case or a legal hold blocks erasure execution and is recorded in `account_deletion_requests.retention_hold_reason`. The user is told their deletion is delayed and why, in general terms.

**What "anonymise" means concretely:** direct identifiers removed (`display_name`, `date_of_birth`, `profile_sensitive`, photos hard-deleted from storage, `user_geo` dropped); pseudonymised records retained only where a lawful basis exists (abuse prevention, legal claims). A tombstone `users` row survives so foreign keys stay valid — this is why every user FK is `on delete restrict`.

> ⚠️ **These are defensible defaults, not legal advice.** They need review by counsel before EU launch (R1), and the review may change them. They are written down now so `data_retention_jobs` has concrete values and the privacy policy has something true to describe.

### E2 — Composite FK scope

**Criterion: a reference code gets a database-level FK if a bad value would silently corrupt matching.** Everything else is validated by the shared Zod schema at the API and nowhere else.

**Composite FK on `(code, type)` — 10 columns.** These are the codes that can appear in a _hard_ filter, where an unresolvable value makes a deal-breaker behave unpredictably:
`marital_status_code` · `religious_practice_code` · `sect_code` · `education_level_code` · `profession_code` · `marriage_timeline_code` · `relocation_willingness_code` · `wants_children_code` · `living_with_family_expectation_code` · `nationality_code`

**Check constraint via `app.validate_ref_array(codes, type)` — 1 column.** `profiles.languages`, because language overlap is hard-filterable and arrays cannot carry a normal FK.

**Zod-only — everything else.** `field_of_study_code` · `industry_code` · `employment_status_code` · `prayer_frequency_code` · `quran_level_code` · `dress_practice_code` · `diet_code` · `smoking_code` · `family_religiosity_code` · `hobbies[]` · `lifestyle_attributes[]` · `personality_traits[]` · `relocation_target_countries[]`

These feed scoring, which treats an unknown code as _no signal_ and renormalises. A bad value degrades a recommendation; it does not corrupt a filter.

### E3 — Distance banding

Distance is **never returned as a number.** The response carries a band code plus an i18n key:

`same_city` · `under_25km` · `km_25_50` · `km_50_100` · `km_100_250` · `km_250_500` · `over_500km` · `same_country` · `different_country`

**Rules:**

1. **Filtering uses exact distance server-side** (`max_distance_km`); only the _response_ is banded. The two are deliberately separate.
2. `under_25km` is the finest band. Narrower bands near the viewer would make repeated queries from different points a trilateration attack — three precise readings locate a home.
3. A user with `display_precision = 'country'` yields `same_country` / `different_country` only, regardless of actual distance.
4. Bands are computed server-side. Coordinates never leave `user_geo`.

### E4 — Scoring weights, engine v1

`engine_version = "v1.0"`. Weights live in config, not in code, and are tunable without a migration.

| Dimension               | Weight  | Why                                                                                                                                        |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Reciprocity**         | **20**  | Does _their_ stated preference match _me_? Highest because showing someone a profile that would never accept them is the core failure mode |
| **Religious alignment** | **18**  | The defining compatibility axis for this product                                                                                           |
| Marriage timeline       | 12      | Concrete, high-signal, easy to state honestly                                                                                              |
| Location & relocation   | 12      | Distance combined with mutual relocation willingness                                                                                       |
| Children (has / wants)  | 10      | Frequently a hard deal-breaker; scored when not hard-filtered                                                                              |
| Family expectations     | 9       | Living-with-family and family religiosity                                                                                                  |
| Language overlap        | 8       | A practical precondition for conversation                                                                                                  |
| Education               | 5       |                                                                                                                                            |
| Lifestyle               | 3       |                                                                                                                                            |
| Profession              | 2       |                                                                                                                                            |
| Personality             | 1       | Weakest signal in self-report; present for completeness                                                                                    |
| **Total**               | **100** |                                                                                                                                            |

> **Missing data contributes zero and the remaining weights renormalise.** Without this, a user who left optional fields blank scores worse than one who filled them in — penalising privacy, which is the opposite of what this product promises.

### E5 — Stage gates

| Stage | Name                  | Unlocks in v1                                                                                                                         |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Introduction          | Text messaging, capped at 30 messages/day per conversation to keep it deliberate                                                      |
| **2** | Getting to Know       | Message cap lifted · photo requests permitted · expanded question suggestions                                                         |
| **3** | Marriage Expectations | Side-by-side expectation comparison — both parties' timeline, relocation and children answers, shown only once both are at this stage |
| **4** | Family Discussion     | **A wali with the `view_matches` grant can see this match.** Below stage 4 they cannot.                                               |
| **5** | Serious Proposal      | **A mutual signal only in v1.** Becomes the proposal gate in 1.1.                                                                     |

> **Stage 5 is honestly thin in v1** — it records that both people consider this serious, and unlocks nothing mechanically until proposals arrive in 1.1. I considered attaching contact-detail exchange to it, but that would be new v1 scope, so it is not proposed here. Flagging it as the obvious candidate if stage 5 feels empty in the closed beta.

### E6 — `profile_field_visibility` key set

Three tiers, not one.

**Always visible when the profile is visible — 9 fields, not controllable.** Matching depends on them, and hiding them would mean appearing in results for criteria nobody can verify:
age · gender · country · marital status · religious practice · marriage timeline · relocation willingness · has children · languages

**Controllable — 14 keys.** Each takes `public` / `matched_only` / `on_request` / `private`:

| Key                                              | Key                                            |
| ------------------------------------------------ | ---------------------------------------------- |
| `profession`                                     | `height`                                       |
| `industry`                                       | `nationality`                                  |
| `employment_status`                              | `family_background`                            |
| `institution`                                    | `sect`                                         |
| `education_level`                                | `children_details`                             |
| `field_of_study`                                 | `hobbies_and_lifestyle` _(grouped)_            |
| `location_precision` _(city / region / country)_ | `about_me` _(`public` or `matched_only` only)_ |

**Never client-visible without an explicit grant — 4 fields** in `profile_sensitive`: phone · email · employer name · workplace city.

> `hobbies_and_lifestyle` groups hobbies, lifestyle attributes and personality traits under one toggle. Fourteen switches is already a dense privacy screen; three separate toggles for cosmetic fields is over-granular and would bury the ones that matter.

---

## Next step

On approval of this design:

1. `docs/openapi.yaml` — the formal API contract for the ~131 member endpoints, built on these entities
2. `docs/adr/` — architecture decision records for D1–D8
3. Settle E1–E6

**Then, and only on your explicit go-ahead, Phase 1 begins.** No migration is written before that point.
