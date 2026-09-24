# 0004 — Five main tabs, including a dedicated Family tab

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D3, §6.2

## Context

Family involvement is a headline differentiator from dating apps. Navigation
placement signals what a product considers important.

## Options

| Option                                                | For                                                                           | Against                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **5 tabs: Discover, Interests, Messages, Family, Me** | Family is visibly core; invitations, permissions and the access log have room | Tight on a 320dp screen, especially with longer Urdu and Arabic labels |
| 4 tabs, Family under Me                               | Cleaner bar; better on small screens                                          | Buries the feature that distinguishes the product                      |

## Decision

Five tabs. The family access log in particular is an anti-coercion control, and it
only works if people can find it.

## Consequences

**Positive.** Family involvement reads as core rather than as a setting.

**Negative.** Label length becomes a translation constraint, recorded in
`packages/i18n`. Tested at 320dp in Urdu and Arabic, not only English.

**Neutral.** In v1 the Family tab carries the Observer tier only (ADR 0005); it
gains depth in 1.1 rather than changing shape.
