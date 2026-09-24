# 0005 — MVP scope: core loop, safety, and a wali Observer tier

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D4, §4, §12.5

## Context

The first feature list marked ~95 items for v1 — a complete v1.0, roughly 10–12
months for a small team and longer solo. The team is one person. Risk R14 was
already recorded against exactly this.

## Options

| Option                                    | Scope                                                                                                                                                                                                          | Time (solo)  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **A — core loop + safety + minimal wali** | Auth, profile, preferences, photo privacy tiers, discovery with explainable compatibility, interest to match, staged text chat, block/report/moderation, notifications, wali Observer, entitlement abstraction | ~9–11 months |
| B — full v1 as first marked               | Adds full wali tiers, proposals, voice notes, selfie verification                                                                                                                                              | ~15+ months  |
| C — minimum shippable                     | Drops photo tiers and wali entirely                                                                                                                                                                            | ~6 months    |

## Decision

**Option A.** The wali tier is reduced to **Observer only** — read-only on profile
and matches. That delivers the family-involvement positioning at roughly 15% of the
permission-matrix complexity, which is where R6 lives.

Deferred to v1.1+: full wali tiers, proposals, voice notes, selfie verification,
all Gemini features, payments, audio and video calling.

**v1 ships as two milestones** (README §12.5): closed beta at ~5–6 months
(invite-only, 47 tables), public launch at ~9–11.

## Consequences

**Positive.** The three real differentiators survive — explainable compatibility,
photo privacy, family involvement. Deferred items are the ones that improve with
real data: the proposal flow is better designed after watching real conversations,
and Gemini moderation needs real message volume to tune against.

**Negative.** Stage 5 of the conversation model is thin in v1 — a mutual signal
that unlocks nothing until proposals arrive (ERD E5). Known, flagged, accepted.

**Neutral.** `family_relationships.tier` carries a check constraint pinning it to
`observer`, relaxed in 1.1. The column exists so 1.1 extends rather than migrates.
