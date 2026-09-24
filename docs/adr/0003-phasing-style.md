# 0003 — Horizontal foundations, then vertical feature slices

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D2, §12.1

## Context

The product direction framed delivery as _planning → database → backend → mobile →
AI → testing → Play Store_. That is the right overall shape, but taken literally at
feature level it means building 90 tables, then ~163 endpoints, then ~72 screens.

## Options

| Option                                        | For                                                                                                         | Against                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Horizontal foundations, vertical features** | Working product at the end of every phase; schema mistakes surface while still cheap; demonstrable progress | Some foundational work is revisited as features land                                                           |
| Strictly horizontal                           | Clean separation; easy to plan                                                                              | Nothing is testable until very late; a schema mistake is found months later with everything built on top of it |

## Decision

**Phases 1–2 are horizontal** — environments, CI, auth, core schema, design system,
i18n and RTL. These genuinely serve everything.

**Phases 3–12 are vertical slices.** Each delivers schema + API + screens + tests
for one capability, end to end.

Testing is not a phase. It is in every phase's definition of done; Phase 13 is
_hardening and release testing_, not where testing begins.

## Consequences

**Positive.** Every phase ends with something demonstrable. Errors are caught near
where they were made — which matters most for a solo build with no reviewer.

**Negative.** Foundational code is occasionally revisited when a later slice needs
something the first one did not.

**Neutral.** Combined with ADR 0005, v1 ships as two milestones: a closed beta at
~5–6 months and public launch at ~9–11.
