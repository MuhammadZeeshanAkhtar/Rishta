> # ⚠️ SUPERSEDED
>
> This document has been **superseded by [README.md](README.md)**, which is now the main
> living product & architecture document for **NikahMate**.
>
> Its substance was carried forward and updated on 2026-09-24 for the confirmed product
> name, the Gemini AI direction, and the full API surface / screen / entity definitions.
>
> Kept only as a historical record. Say the word and I will delete it.

---

# PROJECT_PLAN.md

**Product working name:** Rista (worldwide Muslim matrimonial mobile app)
**Document status:** Draft v0.2 — _architecture proposal. Nothing is implemented. Four decisions locked (§1.1); everything else awaiting review._
**Last updated:** 2026-09-24

> This document is the single source of truth for what we are building and why.
> It is updated at the end of every phase. No code, schema, or dependency is added
> before the relevant section here is marked **APPROVED**.

---

## 1. What this document is

| Section | Purpose                                                |
| ------- | ------------------------------------------------------ |
| 2–4     | Shared understanding of the product                    |
| 5–19    | Proposed architecture, with alternatives and rationale |
| 20      | Development phases                                     |
| 21      | **Open decisions register** — needs your answers       |
| 22      | **Risk register** — what can hurt us                   |
| 23      | Working agreement                                      |

**Current state of the repository:** empty. No packages installed, no tables created, no screens built. That is intentional and correct for this stage.

### 1.1 Decisions locked

| Ref    | Decision                                                                                                                                                                                                                    | Status               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **C1** | **Mobile framework: React Native + Expo (TypeScript).** Android first, iOS from the same codebase.                                                                                                                          | ✅ Locked            |
| **A2** | **Both men and women may initiate an interest.** Symmetric state machine; either side may send, and either side may accept / decline / maybe-later.                                                                         | ✅ Locked            |
| **A1** | **The individual owns the account.** Management rights may be delegated to a family member _after_ signup, reusing the wali/family permission system rather than introducing a second identity model.                       | ✅ Locked            |
| **C2** | **Backend runtime deferred** until the API surface is reviewed. **Consequence: contract-first is now binding** — the OpenAPI contract is written and approved before any runtime is chosen, so the choice stays reversible. | ⏸ Deferred by design |

All other decisions remain open — see §21.

---

## 2. Product summary

A serious, worldwide Muslim matrimonial platform. **Not a dating app.** The product exists to help Muslims find a spouse with dignity, privacy, family involvement, and religious integrity.

**Core journey:**

```
Discover → Understand compatibility → Send interest → Mutual match
→ Respectful conversation → Family / wali involvement → Proposal → Marriage
```

**Target markets from day one (architecture, not necessarily launch):** Pakistan, India, Bangladesh, Middle East, UK, USA, Canada, Europe, Australia, Africa, Southeast Asia.

**First product:** mobile app, Android first, iOS soon after. No public website now.

**What makes this product different from a dating app, in concrete terms:**

| Dating app pattern              | What we do instead                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Infinite swiping, dopamine loop | Bounded, quality-first discovery; daily interest limits are a _feature_, not a paywall trick |
| Photo-first                     | Compatibility-first; photos are private by default and revealed deliberately                 |
| Anonymous, no accountability    | Layered verification with honest badges                                                      |
| Chat with no direction          | Staged conversation, marriage-relevant question prompts                                      |
| Individual-only                 | First-class wali/family participation with explicit, scoped permissions                      |
| Opaque "98% match"              | Explainable compatibility with the actual reasons shown                                      |

---

## 3. Non-negotiable principles

These constrain every later decision. They are cheap now and very expensive to retrofit.

1. **The mobile app is a client, not the product.** All business rules live server-side. The app renders and collects; it never decides.
2. **Deny by default.** Every row, every photo, every field is invisible until a rule explicitly permits it.
3. **No secret ever ships in the app.** No service-role key, no AI provider key, no third-party secret. The app holds only a user session token and a public anon key.
4. **Privacy is a data-model concern, not a UI toggle.** "Hidden" must mean the server never sent it — not that the app didn't draw it.
5. **Worldwide by construction.** No Pakistan-specific, English-specific, or LTR-specific assumptions anywhere in the schema or the layout system.
6. **AI assists, never decides or impersonates.** Every AI output is advisory, attributable, and explainable. AI never writes as the user without explicit review, and never invents a fact about a real person.
7. **Safety is a feature with a budget**, not a cleanup task. Report, block, and moderation exist before the feature that needs them ships.
8. **Explainability over accuracy theatre.** A defensible 7-reason explanation beats an unexplainable percentage.
9. **Everything is auditable.** Who saw what, who changed what, who was granted access, and when.
10. **Build for a $120 Android phone on a 3G connection**, not a flagship on fibre.

---

## 4. Scope

### In scope for v1 (proposed)

Auth · profile · preferences · privacy controls · photos with controlled reveal · discovery & search · deterministic explainable matching · interest & mutual match · staged text conversation · voice notes · report / block · verification (email, phone, selfie) · notifications · wali invitation & scoped visibility · admin panel (internal web) · English + Urdu + Arabic.

### Explicitly out of scope for v1 (proposed)

Public website · voice/video calls · payments & subscriptions _(designed but not enforced-with-money)_ · live translation · success stories · LLM-generated profile text · all remaining languages.

> These are **proposals**, not decisions. See §21.

---

## 5. Recommended technology stack

### 5.1 Mobile — **React Native + Expo (TypeScript)** ✅ **DECIDED**

| Option                     | For                                                                                                                                                                                                                                             | Against                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **React Native + Expo** ✅ | One codebase Android→iOS; first-class Supabase client; EAS Build/Update (ship fixes without store review); the _same TypeScript types, validation schemas and API client_ are reused by the future website and admin panel; largest hiring pool | Slightly heavier than native; some native modules need config plugins                                               |
| Flutter                    | Excellent rendering consistency & animation; strong RTL; great on low-end Android                                                                                                                                                               | Dart shares **zero** code with a future web frontend or Node backend; you would maintain types and validation twice |
| Native Kotlin → Swift      | Best possible performance and platform fidelity                                                                                                                                                                                                 | Two codebases, roughly double cost and time; iOS delayed significantly                                              |

**Why Expo specifically:** matrimonial apps live or die on trust, which means shipping safety fixes fast. EAS Update lets us push a JS-level fix in minutes instead of waiting days for store review. Expo also removes most of the Android/iOS build-toolchain work that would otherwise consume early phases.

### 5.2 Backend — **Supabase (data platform) + a trusted server layer** ⏸ **RUNTIME DEFERRED**

The _shape_ is settled: Supabase is the data platform, and a trusted server layer sits between the clients and the database (§7). What is deferred is **where that server layer runs** — a dedicated Node service or Supabase Edge Functions. That will be decided once the API surface is on the table.

| Option                                                   | For                                                                                                                                                                        | Against                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supabase + dedicated Node API (Fastify or NestJS)** ✅ | Real server for matching, AI orchestration, queues, caching, rate limits; clean OpenAPI contract that mobile, admin and the future website all consume; testable; portable | One more thing to deploy and pay for (~$10–25/mo at our size)                                                                                                                                                                    |
| Supabase Edge Functions only                             | Nothing extra to run; colocated with the DB                                                                                                                                | Deno runtime limits; cold starts; no background jobs or queues; weak observability; 60+ scattered functions become hard to reason about; painful to migrate later                                                                |
| App talks directly to Postgres via RLS for everything    | Fastest to build                                                                                                                                                           | Business logic ends up in the app — **directly violates the "future website must not rebuild logic" requirement**; entitlements and rate limits become unenforceable; the wali permission matrix is not expressible in RLS alone |

**Binding consequence of deferring C2:** the **OpenAPI contract is written and approved before any runtime is chosen.** The contract is the commitment; the runtime is an implementation detail behind it. Concretely this means:

- Every endpoint is defined as a resource + permission rule, independent of whether a Fastify route or a Deno function serves it.
- No Supabase-specific or Node-specific construct leaks into the contract or into `packages/api-client`.
- The mobile app is built against the generated client only, so moving the runtime later changes zero lines in `apps/mobile`.
- The decision point is a real one, not a formality: we choose after counting the endpoints that need background jobs, queues, or long-running work. If that count is low, Edge Functions win on cost; if it is high, the dedicated service wins.

### 5.3 Full stack summary

| Layer            | Choice                                                                                                                                                    | Notes                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Mobile           | React Native + Expo, TypeScript, expo-router                                                                                                              | Android first                                            |
| State/data       | TanStack Query + Zustand                                                                                                                                  | Server state vs UI state, kept separate                  |
| Forms/validation | React Hook Form + **Zod schemas shared with the backend**                                                                                                 | One definition of "valid", used on both sides            |
| Backend API      | Node + TypeScript (Fastify or NestJS), OpenAPI-first                                                                                                      | Deployed on Fly.io / Railway / Cloud Run                 |
| Database         | Supabase Postgres + RLS + PostGIS + pgvector (later)                                                                                                      |                                                          |
| Auth             | Supabase Auth (email, phone/OTP, Google, Apple)                                                                                                           |                                                          |
| Storage          | Supabase Storage, **private buckets only**                                                                                                                |                                                          |
| Realtime         | Supabase Realtime (channels + presence)                                                                                                                   | Sufficient for 1:1 matrimonial chat                      |
| Jobs/queue       | BullMQ + Redis (or Postgres-backed queue initially)                                                                                                       | Scoring, moderation, notification fan-out                |
| Push             | Expo Notifications → FCM / APNs                                                                                                                           |                                                          |
| AI               | Anthropic Claude via backend only (`claude-sonnet-5` for reasoning, `claude-haiku-4-5-20251001` for high-volume moderation) behind a provider abstraction | Never called from the app                                |
| Calls (later)    | LiveKit                                                                                                                                                   | Tokens minted by our API only when the call is permitted |
| Payments (later) | RevenueCat over App Store / Play IAP                                                                                                                      | Store IAP is mandatory for digital goods                 |
| Monitoring       | Sentry + structured logs + Postgres audit tables                                                                                                          |                                                          |
| Monorepo         | pnpm workspaces + Turborepo                                                                                                                               |                                                          |

### 5.4 Repository layout (proposed)

```
apps/
  mobile/          Expo app — UI only, zero business rules
  admin/           Next.js internal admin panel (Phase 6)
  web/             Next.js public site (future, not now)
services/
  api/             The trusted server: authorization, matching, AI, entitlements
packages/
  domain/          Types, Zod schemas, enums, constants — the shared vocabulary
  api-client/      Typed client generated from OpenAPI; used by mobile, admin, web
  i18n/            Translation catalogs, locale + RTL helpers
  ui-mobile/       Mobile design system
supabase/
  migrations/      Every schema change, versioned, reviewed
  policies/        RLS policies with tests
  functions/       Edge functions (webhooks only)
docs/              ADRs, ERD, API contract, runbooks
```

**The rule that makes the future website possible:** `apps/mobile` may not contain a single line that another client would need to re-implement. If logic would have to be copied into `apps/web`, it belongs in `services/api` or `packages/domain`.

---

## 6. High-level architecture

```
                    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
                    │  Mobile App  │   │ Admin Panel  │   │   Website    │
                    │ (Expo, v1)   │   │ (Phase 6)    │   │  (future)    │
                    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                           │                  │                  │
                           └────────┬─────────┴──────────────────┘
                                    │  HTTPS + user JWT
                    ┌───────────────▼────────────────────────────┐
                    │        API SERVICE (trusted layer)         │
                    │  authz · matching · entitlements · quotas  │
                    │  AI orchestration · moderation · audit     │
                    └───────┬───────────────────────┬────────────┘
                            │                       │
              ┌─────────────▼──────────┐   ┌────────▼─────────────────────┐
              │  SUPABASE              │   │  EXTERNAL SERVICES           │
              │  Postgres + RLS        │   │  Claude (AI) · Push (FCM/    │
              │  Auth · Storage        │   │  APNs) · Translation · KYC · │
              │  Realtime              │   │  LiveKit · RevenueCat        │
              └────────────────────────┘   └──────────────────────────────┘
                            ▲
                            │ direct, RLS-guarded reads only
                            └────────── Mobile App (narrow path, see §7)
```

Three clients, one API, one database, one set of rules. The admin panel — a **web** app built in Phase 6 — is deliberate: it proves the API is client-agnostic long before the public website exists.

---

## 7. How Supabase fits — the two access paths

This is the most important architectural decision in the document.

### Path A — direct from the app, guarded by RLS

Only for data that is naturally scoped to the signed-in user and carries no business rules:

- Read/write **own** profile draft, preferences, settings
- Subscribe to Realtime updates for conversations the user is already in
- Read reference data (countries, languages, education levels — public)

### Path B — through the API service (everything else)

Anything privileged, cross-user, quota-bearing, or rule-heavy:

| Operation                        | Why it cannot be Path A                                    |
| -------------------------------- | ---------------------------------------------------------- |
| Discovery / search results       | Must apply blocks, privacy tiers, entitlements, ranking    |
| Compatibility scoring            | Proprietary logic; must not ship to the client             |
| Send / accept interest           | Daily quota, entitlement check, block check, notification  |
| Viewing another profile          | Field-level privacy filtering + "who viewed you" recording |
| Photo access                     | Signed-URL issuance after an authorization decision        |
| Wali invite & scoped access      | Permission matrix not expressible in RLS alone             |
| Proposals, verification, reports | Workflow + audit + moderation                              |
| Subscription & entitlement state | Source of truth must be server-side                        |
| Any AI call                      | Provider keys, cost control, PII governance                |

### The key implementation rule

The API service holds **two** database clients:

- `dbAsUser(jwt)` — forwards the caller's token so **RLS still applies**. This is the default for almost everything. Defence in depth: a bug in the API does not become a data breach.
- `dbAsService()` — service role. Used only in a small, explicitly listed, code-reviewed set of operations (moderation, admin, cross-user grants). Every use writes an audit record.

RLS is therefore never the _only_ protection, and never the _only_ place a rule is written — but it is always the last line of defence.

---

## 8. Data architecture principles

_No tables are being created now. These are the rules the schema must obey when we design it in Phase 0._

1. **Stable internal identity.** Our own `users.id` (UUID) is the identity everything references. Supabase Auth's user id is stored as a link, not as the primary key everywhere. This keeps auth replaceable.
2. **Reference data is coded, never free text.** Education levels, professions, religious practice levels, marital statuses, sects — each is a row with a stable `code` plus a separate translations table. Never store `"Bachelor's Degree"` on a profile; store `edu_bachelors`. Without this rule, the app cannot be translated and filters cannot work across languages.
3. **International standards for everything standardisable.** Countries ISO 3166-1 alpha-2, languages ISO 639, currencies ISO 4217, timezones IANA, phone numbers E.164.
4. **Separate the sensitive from the ordinary.** Exact coordinates, phone, email, workplace, ID documents, and verification artefacts live in restricted tables with their own policies — never in the row that discovery reads.
5. **Coarse location is a separate, denormalised field.** Discovery reads city/region/country; exact geography is privileged and used only for distance computation server-side.
6. **Privacy is a per-field visibility state**, stored as data (`public` / `matched_only` / `on_request` / `private`), not inferred by the UI.
7. **Everything soft-deletes first.** Abuse investigation requires history. Hard deletion is a separate, deliberate, legally-driven process (§22, risk R4).
8. **Append-only audit for sensitive access**: profile views, photo grants, wali access, admin actions, moderation decisions.
9. **Scores are stored with their inputs.** A compatibility score row keeps the sub-scores and the facts behind them, so an explanation can always be regenerated and a complaint can always be investigated.
10. **Multi-tenant-safe by habit** — every query filters on the acting user, even when RLS would.

Conceptual domains to be modelled (from your list, grouped for schema design):
identity & auth · profile & attributes · reference data & translations · media & photo permissions · preferences (hard/soft) · location · discovery & scoring · interests & matches · conversations, messages & media · wali relationships & grants · proposals · verification · reports, blocks & moderation · notifications · entitlements, subscriptions & payments · AI runs & explanations · audit & security · success stories · admin & RBAC.

---

## 9. Authentication & identity

- **Supabase Auth** with email+password, phone OTP, Google, and Apple (Apple is mandatory once we ship iOS with any other social login).
- The same auth works unchanged for the future website — Supabase issues standard JWTs; web uses cookie-based SSR sessions, mobile uses secure device storage (`expo-secure-store`), never AsyncStorage.
- **Onboarding gate:** an authenticated account is not a usable profile. Account → verification → profile completion → discovery access. Incomplete profiles are not discoverable.
- **Session & device management:** users can see and revoke their active devices. Security-relevant events (new device, password change, email change) trigger notifications.
- **Admin authentication is separate** — different surface, mandatory 2FA, role-based, never the same login flow as members.
- **Age gate:** 18+ minimum, enforced at signup and re-checked at verification.

---

## 10. Storage & photo privacy

Photos are the highest-risk data in this product. The design:

1. **Private buckets only.** No user image ever has a public URL. Ever.
2. **Access is an authorization decision**, made by the API: is the viewer blocked? is there a mutual match? is there an explicit photo grant? what is this photo's visibility tier? Only then is a short-lived signed URL issued.
3. **Blurred and thumbnail variants are generated server-side at upload time.** Client-side blur is theatre — it means the real photo was already delivered to the device.
4. **Every photo view is logged** (viewer, photo, timestamp) for abuse investigation and for "who viewed you".
5. **Watermarking** of revealed private photos with an invisible viewer identifier — the strongest practical deterrent against redistribution.
6. **Screenshot reality check:** Android `FLAG_SECURE` can block screenshots; **iOS cannot prevent them, only detect them after the fact.** We will not claim screenshot-proof photos. We will detect, log, and notify.
7. **Upload moderation before visibility**: automated check (nudity, faces, screenshots of other apps, group photos) then human review for flagged items.

---

## 11. Matching & AI architecture

### 11.1 The four-stage pipeline

```
1. FILTER      SQL over hard preferences (deal-breakers) → candidate set
2. SCORE       Deterministic weighted scoring across dimensions → sub-scores
3. EXPLAIN     Human-readable reasons generated from the sub-scores
4. RANK        Diversity, freshness, activity, reciprocity → final ordering
```

### 11.2 Why deterministic scoring, not "ask an LLM"

| Concern        | Deterministic engine                                             | LLM-scores-every-pair                                                   |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Explainability | Explanation is a by-product of the computation — always truthful | Post-hoc rationalisation; can contradict the score                      |
| Consistency    | Same inputs → same output, always                                | Varies run to run                                                       |
| Cost           | Effectively free per candidate                                   | Prohibitive at candidate-set scale                                      |
| Latency        | Milliseconds                                                     | Seconds                                                                 |
| Privacy        | Profile data never leaves our infrastructure                     | Sends real people's religion, location, family details to a third party |
| Auditability   | A complaint can be investigated line by line                     | Cannot be reconstructed                                                 |
| Hallucination  | Impossible                                                       | Can invent facts about a real person                                    |

**Dimensions to score:** religious practice & values · marriage timeline · relocation willingness · children (has/wants) · family expectations · language overlap · location & distance · education · profession · lifestyle · personality indicators · preference reciprocity (does _their_ stated preference match _me_?).

**Reciprocity matters enormously** and is the thing most products get wrong: showing someone a profile that would never accept them is worse than showing nothing.

### 11.3 Explanations

Explanations are generated from the sub-scores using **translated templates**, not free-form LLM text. This gives correct Urdu/Arabic output, zero hallucination risk, zero per-explanation cost, and instant rendering:

> **Why this profile may be compatible**
> • Both want to marry within 12 months
> • Both open to relocating
> • Shared languages: Urdu, English
> • Similar expectations about living with family
> • Both describe their practice as regularly practising

We may later use an LLM to _polish_ phrasing — but the facts always come from the engine.

### 11.4 Where AI genuinely earns its place

| Use                                         | Why AI is the right tool                                        | Phase |
| ------------------------------------------- | --------------------------------------------------------------- | ----- |
| Moderation triage of text & voice           | Nuance, sarcasm, multilingual, evolving scam scripts            | 6     |
| Scam & grooming detection                   | Pattern recognition across conversation history                 | 6     |
| Profile improvement suggestions             | Writing help — _suggestions the user edits_, never auto-written | 10    |
| Marriage-question suggestions               | Contextual, stage-aware prompts                                 | 10    |
| Translation                                 | Cross-language conversation                                     | 10    |
| Report triage summaries for moderators      | Speeds human review without replacing it                        | 6     |
| Free-text similarity (embeddings, pgvector) | Values/about-me similarity beyond structured fields             | 10    |

**Hard AI rules:** backend-only calls · provider abstraction so Claude is replaceable · every AI run logged with inputs, outputs, model, and cost · user-visible AI features are opt-out · AI never sends a message as the user · AI never populates a profile field the user did not confirm.

---

## 12. Conversation, calls & notifications

**Staged conversation** (Introduction → Getting to know → Marriage expectations → Family discussion → Serious proposal). Stages are mutual and explicit — both people agree to advance. Stage gates what is unlocked: e.g. voice notes at stage 2, wali visibility at stage 4, proposal at stage 5. This is the structural difference from a dating chat.

**Transport:** Supabase Realtime. Matrimonial messaging is low-volume 1:1 — a third-party chat SDK (Stream, Sendbird) is unnecessary cost and an unnecessary copy of our users' most sensitive data in someone else's system.

**Voice notes:** audio in private storage + duration metadata, same permission model as photos, transcribed for moderation.

**Calls (later, Phase 9+):** LiveKit. We never build WebRTC signalling ourselves. Tokens are minted by our API only after checking mutual match, stage, entitlement, block status, and wali policy. Numbers are never exchanged — the platform mediates.

**Notifications:** the `notifications` table is the source of truth (the in-app inbox); push is one delivery channel. Every notification respects per-type preferences, the recipient's language, and their timezone quiet hours — a proposal notification at 3am is a product failure.

---

## 13. Privacy, wali & the permission model

Every request for another user's data resolves to one question: **who is asking, and in what relationship?**

```
Viewer relationship:  self | stranger | interest-pending | mutual match
                    | own wali | counterpart's wali | moderator | admin | blocked
                              ×
Field visibility:     public | matched_only | on_request | private
                              ×
Entitlement & stage
                              ↓
                    → allowed fields + allowed media
```

This resolution happens **once, server-side, in one authorization service**. It is never re-implemented per endpoint and never implemented in the app.

**Wali / family:** invitation-based, scoped, revocable, and always visible to the user. A wali sees exactly what was granted — nothing more — and every wali access is logged and shown to the user. Granular permissions: view profile · view matches · view conversation (read-only or participating) · receive proposals · be notified. A wali who joins a conversation must be visible to both sides — covert observation would be a serious trust violation.

### 13.1 Delegation — the decided model (A1)

**The individual always owns the account.** Signup is always performed by the person themselves; there is no "create a profile for someone else" path. After signup, the user may delegate rights to a family member. This gives us the South Asian family-involvement behaviour **without a second identity model** — delegation is simply the top tier of the wali permission system we were already building.

| Tier            | The delegate can                                                                                             | Typical use                              |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **Observer**    | View what was granted (profile, matches, conversation)                                                       | A parent kept informed                   |
| **Participant** | The above, plus speak in conversation and receive proposals — always visibly attributed                      | A wali taking part in discussions        |
| **Manager**     | The above, plus edit profile content, manage preferences, and send/respond to interests on the user's behalf | A sibling running the profile day to day |

**Guardrails, which are not negotiable:**

- **Consent never delegates.** Only the account owner can change verification, privacy settings, delegation itself, or delete the account. A manager can run the profile; they cannot redefine who may see it.
- **Delegation is always visible and instantly revocable** by the owner, from a screen that also shows every action the delegate has taken.
- **Every delegated action is attributed and audited** — internally always, and to the counterpart where honesty requires it. A message written by a delegate must not appear to come from the account owner personally.
- **The owner retains a private channel.** There must be a way for the account owner to contact support or report coercion without the delegate seeing it. A delegation feature in this product category can be abused as a control mechanism, and the design has to anticipate that.
- **One owner, many delegates.** Delegates are never accounts-within-accounts; they are grants on a relationship.

Open sub-question for schema design: can a delegate hold grants on several people's profiles (a parent managing two children)? See §21, A9.

**Member privacy controls:** private profile · private photos with request/approve · hide exact location · hide contact details · hide workplace · incognito browsing · online-status control · read-receipt control. Each is enforced at the API, not the UI.

---

## 14. Trust, safety & verification

**Verification levels, with honest badges.** A badge must state exactly what was verified and nothing more:

| Level            | Meaning                                         | Method                                        |
| ---------------- | ----------------------------------------------- | --------------------------------------------- |
| Email verified   | This email is reachable                         | Link                                          |
| Phone verified   | This number is reachable                        | OTP                                           |
| Photo verified   | The photos are of the person holding the device | Liveness selfie vs profile photos             |
| ID verified      | Legal identity confirmed                        | Third-party KYC (Onfido/Sumsub/Persona class) |
| Profile reviewed | A human checked for plausibility                | Moderator                                     |

We will never show a generic "Verified ✓" that implies more than we checked. Misleading badges are how matrimonial platforms lose trust permanently.

**Abuse defences:** block (bidirectional, invisible to the blocked party) · report with categories (scam, harassment, impersonation, fake profile, inappropriate content, married-under-false-pretences) · device fingerprinting & duplicate-account detection · velocity limits · payment-request keyword detection · AI triage → human moderation queue · safety centre with market-specific guidance · security notifications.

**Moderation must be staffed in the languages we launch in.** An Urdu-only report queue reviewed by English-only moderators does not work.

---

## 15. Internationalization

- **i18next + ICU message format**, translation catalogs in `packages/i18n`, shared with the future website.
- **RTL from day one.** Arabic and Urdu are RTL; retrofitting RTL into a built app is a rewrite of the layout layer. Every layout uses start/end, never left/right. This is a Phase 1 decision, not a Phase 11 one.
- **Locale is not language.** Store language, country, and timezone separately. Date, number, name-order and address formats follow locale.
- **Phone numbers:** E.164 storage, libphonenumber validation, country-aware input.
- **Calendars:** Hijri date display alongside Gregorian where culturally expected.
- **Launch languages (proposed):** English, Urdu, Arabic. Then Bengali, Hindi, Turkish, Indonesian, Malay, French, Spanish.
- **Translation is data, not code.** Adding a language must never require a release.

---

## 16. Subscriptions & entitlements

Payments are **not** being implemented now. The entitlement system is designed now so features can be gated later without touching feature code.

```
plans → plan_entitlements → user_entitlements → usage_counters
                                    ↑
              subscriptions (RevenueCat / Store IAP webhooks)
```

- Feature code asks `can(user, 'ai_matches_extended')` and `consume(user, 'daily_interests')`. It never asks "is this user premium?"
- **Our database is the source of truth**; the store and RevenueCat are billing providers feeding it via webhooks.
- Enforcement is server-side only. A client-side paywall is a suggestion, not a control.
- **Apple and Google require IAP for digital goods** (15–30%). Pricing must be planned around this, and around purchasing-power differences across our markets.
- Candidate premium features: advanced filters, extended AI matches, unlimited interests, who-viewed-you, advanced privacy, incognito, boost, translation.

---

## 17. Admin panel

A separate internal **web** application (Next.js), Phase 6. Not the public website.

Dashboard · user management · verification queue · report & moderation queues · suspicious account review · content moderation · subscriptions & payments · reference data (countries, languages, professions…) · notification templates · support · analytics · AI monitoring & cost · audit log viewer.

**RBAC from the first commit:** support agent / moderator / verification officer / finance / admin / super-admin. Least privilege. Every privileged action is audited with actor, target, reason, and timestamp. Access to member PII is logged and reviewable — moderators are a real insider-risk surface in a product like this.

---

## 18. Security baseline

| Control          | Commitment                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Transport        | TLS everywhere; certificate pinning for the mobile API (Phase 6+)                                       |
| Secrets          | Server-side only; a managed secret store; rotation runbook; **never in the app bundle or the repo**     |
| Authorization    | Single authorization service + RLS as backstop; service-role usage explicitly enumerated                |
| Input validation | Shared Zod schemas validated again server-side; every input distrusted                                  |
| Rate limiting    | Per user, per IP, per device, per endpoint class; stricter on auth, interest, messaging, report         |
| Abuse prevention | Velocity limits, duplicate detection, anomaly alerts                                                    |
| Audit            | Append-only logs for auth events, admin actions, PII access, photo grants, wali access                  |
| Data at rest     | Postgres encryption; restricted tables for ID documents and verification artefacts with short retention |
| Backups          | Automated, tested restores — an untested backup is not a backup                                         |
| Dependencies     | Lockfiles, automated vulnerability scanning, minimal dependency count                                   |
| Review           | Security review is part of every phase's definition of done                                             |
| Testing          | RLS policy tests are mandatory and run in CI                                                            |

---

## 19. The future website (not now — but never blocked)

The website is out of scope. These decisions keep it cheap when it comes:

1. **It reuses everything:** same API, same auth, same database, same AI services, same matching logic, same entitlements. Its job is presentation only.
2. **Shared packages:** `domain` (types, schemas, enums), `api-client`, `i18n`. Copy-paste between mobile and web is a defect.
3. **Not shared:** components. React Native and DOM components are different mediums; `react-native-web` for a full public site is a trap. Share **design tokens**, not components.
4. **Auth is already solved:** Supabase Auth issues standard JWTs; the web app uses cookie-based SSR sessions against the same user records.
5. **The test we apply today:** for every piece of logic, ask _"would the website have to re-implement this?"_ If yes, it is in the wrong place — move it to `services/api`.
6. **A deliberate warning:** a public, crawlable profile directory would be a serious privacy decision, not an SEO tactic. Public marketing pages and member data must stay strictly separated.
7. **The admin panel (Phase 6) is the proof.** If a web client can be built against our API without a single backend change, the architecture works.

---

## 20. Development phases

Nothing starts until §21 is answered and this document is approved.

| Phase  | Name                      | Delivers                                                                                                                        | Exit criteria                                                                                                  |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **0**  | Decisions & design        | This doc approved, ERD, OpenAPI contract skeleton, ADRs, legal baseline                                                         | Schema and contract reviewed                                                                                   |
| **1**  | Foundations               | Monorepo, CI, 3 Supabase environments, auth, users, i18n + RTL scaffolding, design system, audit logging, device management     | A user can sign up, verify email/phone, and see an empty app in 3 languages incl. RTL                          |
| **2**  | Profile & preferences     | Full schema + reference data with translations, profile builder, privacy controls, hard/soft preferences, private photo storage | A complete, privacy-controlled profile exists                                                                  |
| **3**  | Discovery & matching      | Search, filters, candidate generation, scoring engine v1, explanations, discovery sections                                      | Real profiles surfaced with truthful explanations                                                              |
| **4**  | Interest & match          | Interest send/accept/decline/maybe, quotas, blocks, notifications                                                               | Two users can reach mutual match                                                                               |
| **5**  | Conversation              | Staged chat, Realtime, voice notes, in-thread report/block, read receipts                                                       | Two matched users can converse safely                                                                          |
| **6**  | Trust & safety + Admin    | Verification levels, report pipeline, moderation queue, AI triage, **admin panel v1 (web)**                                     | A report reaches a human and results in an action                                                              |
| **7**  | Wali, family & delegation | Invitations, scoped permissions (Observer/Participant/Manager, §13.1), supervised conversation, access log, revocation          | A wali participates with exactly the granted access; a delegate can run a profile with every action attributed |
| **8**  | Proposal                  | Formal proposal flow, acceptance, success journey                                                                               | A match can become a proposal                                                                                  |
| **9**  | Monetization              | Entitlement enforcement, RevenueCat + IAP, premium features                                                                     | Free/premium behave differently, server-enforced                                                               |
| **10** | AI expansion              | LLM moderation, translation, suggestions, embeddings                                                                            | Measurable safety and match-quality improvement                                                                |
| **11** | iOS + scale + languages   | iOS launch, performance, more languages, load testing                                                                           | Store approval on both platforms                                                                               |
| **12** | _(Future)_ Website        | Public web frontend on the existing API                                                                                         | Zero backend changes required                                                                                  |

**Every phase's definition of done includes:** RLS tests passing · i18n coverage (no hardcoded strings) · RTL verified · security review · docs updated · tested on a low-end Android device.

---

## 21. Open decisions register — **I need your answers**

### Group A — Product policy _(blocks the schema; highest priority)_

| #      | Question                                                                                                                                                                                       | Why it matters now                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~A1~~ | ✅ **ANSWERED — individual owns the account; rights delegated to family after signup.** Modelled as the top tier of the wali permission system (§13.1).                                        | —                                                                                                                                                                                             |
| ~~A2~~ | ✅ **ANSWERED — both men and women may initiate.** Symmetric interest state machine.                                                                                                           | —                                                                                                                                                                                             |
| A3     | **Is wali involvement optional everywhere**, or required for some segments (e.g. women under a certain age, or specific countries)?                                                            | Determines whether wali is a feature or a gate.                                                                                                                                               |
| A4     | **Photos: hidden by default or visible by default?** Are photo-less profiles first-class?                                                                                                      | Sets the default privacy tier and the entire discovery UI.                                                                                                                                    |
| A5     | **Sect / madhhab:** do we collect it, is it filterable, is it public?                                                                                                                          | Sensitive and abusable. Needs a deliberate policy, including whether it can be used to exclude.                                                                                               |
| A6     | **Polygyny:** do we support men seeking an additional wife?                                                                                                                                    | Legally prohibited in several target markets and a likely app-store issue. Affects marital-status modelling and country gating. Needs an explicit decision — we should not assume either way. |
| A7     | **Divorced / widowed / with children** — any special handling, visibility, or filtering rules?                                                                                                 | Affects preference modelling and sensitivity.                                                                                                                                                 |
| A8     | **Interest quotas:** what are the free daily limits?                                                                                                                                           | Core to both product feel and monetization.                                                                                                                                                   |
| A9     | _(new, from A1)_ **Can one person hold delegate rights on several profiles** — e.g. a parent managing two children? And may a delegate also be an ordinary member seeking marriage themselves? | Decides whether delegation is a simple grant or needs its own multi-profile context switcher in the app.                                                                                      |
| A10    | _(new, from A1)_ **May a "Manager" delegate send and reply to interests**, or is initiating always reserved to the account owner?                                                              | The strongest form of delegation. Convenient and culturally normal, but it means the person a match is talking to may not be the person they matched with.                                    |

### Group B — Scope & priority

| #   | Question                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------ |
| B1  | Launch countries for v1 — all at once, or a focused first market? (Recommendation: focus, then expand) |
| B2  | Launch languages — is English + Urdu + Arabic right?                                                   |
| B3  | Is the v1 scope in §4 correct? Anything that must move in or out?                                      |
| B4  | Is messaging free at launch, or gated behind payment?                                                  |
| B5  | Voice/video calls — v1, or Phase 9 as proposed?                                                        |
| B6  | Target launch date, and is there a hard deadline?                                                      |

### Group C — Technical

| #      | Question                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~C1~~ | ✅ **ANSWERED — React Native + Expo (TypeScript).**                                                                                                        |
| ~~C2~~ | ⏸ **DEFERRED by decision — runtime chosen after the API surface is reviewed.** Contract-first is now binding (§5.2).                                       |
| C3     | Is sending profile data to a third-party AI provider acceptable, or must AI run on data that never leaves our infrastructure? (Affects the whole AI plan.) |
| C4     | Any **data residency** requirement (EU data in EU, etc.)?                                                                                                  |
| C5     | Monthly infrastructure budget ceiling for v1?                                                                                                              |
| C6     | Who is building this — solo, small team, or agency? What are their existing skills? (This legitimately changes the stack recommendation.)                  |

### Group D — Business & legal

| #   | Question                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Legal entity and country of incorporation — determines the data controller, privacy policy, and app-store account.                      |
| D2  | Who staffs moderation, in which languages, at what hours?                                                                               |
| D3  | Is there budget for a paid KYC/ID-verification provider?                                                                                |
| D4  | Brand name, domain, and app-store name — confirmed? ("Rista" is currently just the folder name.)                                        |
| D5  | Is a religious advisory review of the product's rules and terminology planned? (Strongly recommended for credibility in this category.) |

---

## 22. Risk register

| #   | Risk                                                                                                                                                   | Impact                                                       | Mitigation                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Religion is GDPR Article 9 "special category" data** — and it is the core of this product. Ethnicity, sect, and health-adjacent data may also apply. | Legal exposure in EU/UK; fines are turnover-based            | Explicit granular consent at collection; documented lawful basis; minimise; restrict access; log every access; legal review before EU launch               |
| R2  | **Romance-scam targeting.** Matrimonial platforms are among the most heavily targeted products that exist.                                             | Direct financial harm to users; destroys trust; press risk   | Verification tiers, velocity limits, device fingerprinting, AI triage, payment-keyword detection, staffed human moderation, visible safety centre          |
| R3  | **App-store rejection.** Apple 1.2 (UGC) and 4.3 (spam), Google's dating/UGC policies.                                                                 | Launch blocked for weeks                                     | Report/block/moderation shipped _before_ submission; published safety & content policy; correct age rating; 24-hour report-response commitment             |
| R4  | **Deletion vs retention conflict.** GDPR says erase; safety says keep evidence; the counterpart's conversation history is also _their_ data.           | Legal and product conflict                                   | Written retention policy per data class; soft-delete + anonymise; preserve abuse evidence under a documented lawful basis; decide in Phase 0               |
| R5  | **Photo leakage.** Signed URLs get shared; screenshots cannot be prevented on iOS.                                                                     | Severe personal harm; catastrophic reputational damage       | Short-lived signed URLs, server-side blur derivatives, viewer watermarking, access logging, honest UX about what we can and cannot prevent                 |
| R6  | **RLS + wali + privacy-tier complexity.** The permission matrix is genuinely hard.                                                                     | A single policy bug exposes private profiles                 | One central authorization service; RLS as backstop not sole control; mandatory automated policy tests; a written permission matrix reviewed before Phase 7 |
| R7  | **AI cost and latency explosion** if scoring or translation is done naively per candidate.                                                             | Unsustainable unit economics                                 | Deterministic scoring; batch precomputation; caching; premium gating; per-user cost ceilings; cost monitoring from day one                                 |
| R8  | **Supabase constraints:** connection limits, no long-running jobs, Realtime scaling, auth lock-in.                                                     | Scaling wall at growth                                       | Supavisor pooling; jobs in the API service; standard Postgres SQL; internal user id independent of Supabase Auth id                                        |
| R9  | **Low-end device & poor-network markets.**                                                                                                             | The app is unusable for a large share of the target audience | Image budgets, APK size discipline, optimistic UI, offline-tolerant caching, test on a real 2GB Android device every phase                                 |
| R10 | **Cultural and sectarian conflict** in product rules, terminology, or filters.                                                                         | Community backlash, reputational damage                      | Neutral terminology, optional sensitive fields, religious advisory review (D5), region-aware defaults                                                      |
| R11 | **Moderation cannot scale with the launch markets' languages.**                                                                                        | Reports go unanswered; users are harmed                      | Staff for launch languages only; expand languages only when moderation can follow                                                                          |
| R12 | **Scope overrun.** This is a genuinely large product — easily 12+ months of work for a small team.                                                     | Burnout, nothing shipped                                     | Strict phasing; no phase starts before the previous one's exit criteria are met; ruthless v1 scope                                                         |

---

## 23. Working agreement

1. **No implementation begins** until you explicitly say to start.
2. **Small, controlled phases.** One phase at a time, approved before it starts.
3. **Before any significant architectural decision:** I explain the decision, the alternatives, the reasoning, and my recommendation — then wait for your approval.
4. **Nothing existing is deleted or rewritten** without asking first.
5. **No unnecessary dependencies.** Every package added is justified in writing.
6. **This document is kept current.** Significant decisions are also recorded as ADRs in `docs/adr/`.
7. **Security shortcuts are never taken to move faster.**

---

## 24. Immediate next steps

Because C2 was deferred until the API surface is visible, the API surface is now the **next deliverable**, ahead of the schema.

| #   | Step                                                                                                                                                                                | Status                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | Lock C1, A1, A2 and defer C2                                                                                                                                                        | ✅ Done (§1.1)         |
| 2   | **Produce `docs/API_SURFACE.md`** — every resource, every endpoint, its permission rule, and whether it needs background/long-running work. No implementation, no framework chosen. | ⬅ **Next**             |
| 3   | **Decide C2** using step 2: count the endpoints needing queues or long-running work, then choose Edge Functions or a dedicated service                                              | Blocked on step 2      |
| 4   | **Produce `docs/ERD.md`** — full schema design as a reviewable document. Still no tables created.                                                                                   | Blocked on §21 Group A |
| 5   | You review steps 2 and 4                                                                                                                                                            | —                      |
| 6   | Phase 1 begins — **only on your explicit go-ahead**                                                                                                                                 | —                      |

**Answers that materially change step 2 (API surface):** B3 (v1 scope), B5 (calls in v1), A4 (photo defaults), A10 (can a delegate initiate interests).
**Answers that materially change step 4 (ERD):** A4–A10, B1, B2, C3, C4.

Step 2 can proceed under stated assumptions if you would rather see the surface before answering the rest — the assumptions will be listed at the top of the document and are cheap to revise.

---

_End of PROJECT_PLAN.md v0.2 — four decisions locked, awaiting review on the rest._
