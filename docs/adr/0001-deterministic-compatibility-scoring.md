# 0001 — Deterministic compatibility scoring, Gemini layered on top

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D6

## Context

The product direction named Gemini for "AI matchmaking and compatibility analysis".
Compatibility is the core differentiator: the app promises to explain _why_ two
people may suit each other, in Urdu and Arabic as well as English, for a decision
as consequential as marriage.

## Options

| Option                                    | For                                                                                                                                                      | Against                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic engine, Gemini above it** | Explanation is a by-product of the computation, so it is always true; consistent; free per candidate; millisecond latency; auditable; cannot hallucinate | Weights must be tuned by hand; no emergent insight from free text                                                                                                                                                                   |
| Gemini scores each pair                   | Flexible on nuance; simpler first implementation                                                                                                         | Non-deterministic between runs; prohibitive at candidate-set scale; explanations are post-hoc and can contradict the score; sends special-category data on every comparison; cannot be reconstructed when a member disputes a match |

## Decision

Compatibility is scored by a **deterministic weighted engine** across 11 dimensions.
Explanations are rendered from `compatibility_factors` — the values actually
compared — using translated templates.

Gemini is used where it is genuinely strong and is **not** in the scoring path:
moderation triage, scam detection, translation, bio assistance, question
suggestions, embeddings. All of it is v1.2.

## Consequences

**Positive.** Explanations are truthful by construction. A complaint months later
can be investigated line by line. Urdu and Arabic output is correct because it is
translated template text, not generated prose. Per-candidate cost is effectively
zero, so scoring the whole base nightly is affordable.

**Negative.** Weights are hand-tuned and initially unvalidated (ERD E4). Free-text
similarity waits for embeddings in v1.2.

**Neutral.** `compatibility_scores.engine_version` exists so weight changes are
traceable and comparable against real accept rates.
