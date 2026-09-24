# 0009 — Consolidated entity design: 90 entities

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D8, docs/ENTITIES.md

## Context

The first inventory was 110 entities across 17 domains. Every table needs RLS
policies, and every policy needs tests. **Policy count, not table count, is the
real workload** — and it is the dominant input to R6, the top technical risk.

## Options

| Option             | Entities | For                                                                         | Against                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Consolidated**   | 90       | ~20 fewer policy sets; discovery loses three joins on its hottest read path | Wider tables; some integrity moves from FK to composite key             |
| Full normalisation | 110      | Per-type constraints; cleanest on paper                                     | More policies, migrations and admin screens to build and maintain alone |

## Decision

**90 entities: 71 in v1, 47 in the closed beta.**

Two consolidations:

1. **Reference data, 19 tables to 2.** A generic `reference_items` keyed by
   `(type, code)` plus `reference_translations`. This also matches the API contract
   already written — a single `GET /reference/:type`, not nineteen endpoints.
   Integrity is preserved by a unique key on `(id, type)` supporting composite FKs.
2. **Profile, 6 tables to 3.** Religious, family and lifestyle attributes fold into
   `profiles`.

**Not consolidated:** `profile_sensitive` stays separate. It is the privacy
boundary, and it is `restricted` — zero policies, unreachable from any client.

A gap surfaced during review: consolidating profile left languages, hobbies and
lifestyle attributes, all many-to-many, without a home. Resolved as `text[]`
columns of reference codes with GIN indexes rather than three join tables.

## Consequences

**Positive.** Roughly 20 fewer policy sets to write and test. One admin CRUD screen
for reference data instead of nineteen. Adding a language stays a data change.

**Negative.** `profiles` is wide with some sparse columns. Array-element integrity
is enforced by shared Zod schemas rather than by Postgres, except `languages`,
which carries a check constraint because it is hard-filterable (ERD E2).

**Neutral.** Access-class distribution across the 71 v1 entities — `owner` 20,
`shared` 17, `restricted` 19, `system` 12, `public` 3 — is a better predictor of
effort than the count. The 17 `shared` entities carry the permission-resolved
policies and need the most test coverage.
