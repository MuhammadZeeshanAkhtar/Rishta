# 0006 — Gemini data governance principle; access tier deferred

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D5, §10.3

## Context

The Google AI Studio free tier may use submitted data to improve Google products.
The paid tier and Vertex AI do not. This product handles religion, marital history
and family detail — GDPR Article 9 special-category data about real people.

Under ADR 0005, Gemini features are v1.2. The tier choice is therefore not urgent.
The principle is, because it is the kind of thing violated by accident during
prototyping.

## Options

| Option                                 | For                                                                           | Against                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Lock the principle, defer the tier** | Nothing is blocked; the tier is chosen with the data-residency answer in hand | Two decisions instead of one                                                      |
| Commit to paid Gemini API now          | Simple; one key                                                               | Would need revisiting for an EU launch with residency requirements                |
| Commit to Vertex AI now                | Regional endpoints and enterprise governance from the start                   | Meaningful setup complexity for a solo build, for something not needed until v1.2 |

## Decision

**The principle is binding now:**

1. The free tier is for **synthetic data only**. It never points at real user data.
2. Paid access is required before any real user data reaches Gemini.
3. PII is minimised — reference codes over raw values. Exact coordinates, phone
   numbers, email addresses and identity documents are **never** sent.
4. AI processing is disclosed in the privacy policy, and members can opt out.
5. No Gemini key exists in this repository or in any app bundle.

**Deferred:** Gemini API versus Vertex AI, chosen at Phase 11 against the
data-residency answer.

## Consequences

**Positive.** The compliance failure mode is closed before any code exists.
No key is required to build v1.

**Negative.** Prototyping AI features needs synthetic fixtures.

**Neutral.** The `AiProvider` abstraction means the tier choice touches one adapter.
