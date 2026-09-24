# 0010 — Launch locales: English and Urdu only

**Status:** Accepted · **Date:** 2026-09-24 · **Supersedes the language scope referenced in** [0001](0001-deterministic-compatibility-scoring.md) and [0004](0004-five-tab-navigation.md)

## Context

The approved launch set was English, Urdu and Arabic (README §15 B2), and
Phase 1 shipped all three: catalogs, locale metadata, RTL handling and tests.

The product owner has since narrowed v1 to **English and Urdu**. This is a
scope decision, not a correction of an error — the earlier ADRs were accurate
when written, which is why they are left intact rather than edited.

## Options

| Option                                    | For                                                                                                                                    | Against                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **English + Urdu only**                   | Two locales to translate, review and moderate instead of three. Urdu alone proves the whole RTL path, so nothing architectural is lost | Arabic-speaking markets wait                                                                                                    |
| Keep Arabic as a hidden or partial locale | Nothing to remove                                                                                                                      | A half-supported locale is worse than none: it resolves, reports a direction, and renders untranslated strings to a real person |
| Keep all three                            | Widest reach at launch                                                                                                                 | Translation and moderation cost in a language the team cannot review, for markets not being targeted first                      |

## Decision

**v1 ships English (primary, LTR) and Urdu (RTL).** Arabic is removed
completely — catalog, locale constant, metadata, selector entry, resolution
and tests. It is not retained in any partial form.

**RTL coverage is unaffected.** Urdu exercises every right-to-left path:
document direction, mirrored navigation, text alignment and the tab-label
metrics that differ from Latin. The Urdu-only clipping bug found during Phase 1
verification would have been caught identically without Arabic.

**Re-adding a locale stays three steps and no restructuring:**

1. Add the code to `LOCALES` in `@nikahmate/domain`.
2. Add a catalog beside the others in `@nikahmate/i18n`.
3. Add its entry to `LOCALE_META`.

Direction, resolution, persistence, the language selector and the catalog
parity test all read from that list. Nothing is special-cased per locale, which
is what made removing Arabic a deletion rather than a refactor — and is the
same property that will make adding it back cheap.

## Consequences

**Positive.** One fewer language to have natively reviewed before launch, and
one fewer to staff moderation for (risk R13). The i18n architecture is now
demonstrably extensible in both directions, having been exercised at three
locales and then at two.

**Negative.** Arabic-speaking markets are not addressable at launch. Given the
translations were never natively reviewed, shipping them would have been a
claim the product could not stand behind anyway.

**Neutral.** A test asserts Arabic does **not** resolve and does **not** report
a direction, so it cannot survive as a hidden locale by accident.
