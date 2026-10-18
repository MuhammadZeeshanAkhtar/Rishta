# 0012 — English only; right-to-left support removed

**Status:** Accepted · **Date:** 2026-10-01 · **Supersedes** [0010](0010-launch-locales-english-and-urdu.md)

## Context

[0010](0010-launch-locales-english-and-urdu.md) narrowed the launch set from
three locales to **English and Urdu**, and kept Urdu specifically because it
exercised every right-to-left path: document direction, mirrored navigation,
text alignment and the tab-label metrics that differ from Latin script.

The product owner has since narrowed v1 again, to **English only**. As with
0010 this is a scope decision rather than a correction — 0010 was accurate when
written, which is why it is superseded rather than edited.

The consequence is larger than dropping a catalog. Urdu was the only
right-to-left locale, so removing it leaves the entire RTL apparatus with
nothing exercising it.

## Options

| Option                                     | For                                                                                                                                 | Against                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove Urdu and all RTL handling**       | One language to translate, review and moderate. No `direction` threading through 25 components, no `I18nManager`, no restart prompt | RTL must be rebuilt if a right-to-left locale returns                                                                                                                       |
| Remove Urdu, keep the RTL plumbing         | RTL "ready" if a locale returns                                                                                                     | Nothing would exercise it. Untested RTL is not readiness — it is code that will be wrong in ways no one can see, and it would have to be re-verified before trusting anyway |
| Keep Urdu as a hidden or incomplete locale | Nothing to remove                                                                                                                   | 0010 already rejected this for Arabic, for the same reason: a half-supported locale resolves, reports a direction, and shows untranslated strings to a real person          |

## Decision

**v1 ships English only, left-to-right.** Urdu is removed completely — catalog,
locale constant, metadata, selector entry, reference translations and tests.

**All right-to-left handling is removed with it**: `RTL_LOCALES`, `isRtl`,
`directionFor`, the `direction` field on locale metadata, every
`writingDirection` style, the `I18nManager` calls, the tab-bar mirroring and
the "restart to apply right-to-left layout" notice.

This is the deliberate reversal of the position in README §11 ("RTL from the
first screen… this is not retrofittable"). That reasoning held while a
right-to-left locale was in scope. With none, the cost moves to the other side:
RTL code that nothing renders is a liability, because it cannot be trusted
without re-verification and so provides no real head start.

**The language selector is removed** from the welcome and Me screens. A picker
with one option is not a choice.

**The i18n indirection stays.** `t()` is what keeps user-facing copy out of
component files, and the catalog-parity test keeps its value the moment a
second locale is added. Adding a locale remains: add the code to `LOCALES`, add
a catalog beside `en.json`, add its entry to `LOCALE_META`. A _right-to-left_
locale additionally means building direction handling again, which is the
honest cost of this decision rather than a hidden one.

## Consequences

**Positive.** One language to have natively reviewed before launch, and one to
staff moderation for (risk R13). Roughly 120 RTL-specific expressions leave the
mobile codebase, and every screen's style objects get shorter.

**Negative.** A right-to-left locale is no longer a three-step addition. For a
Muslim matrimonial product this is the decision most likely to be revisited,
and it should be revisited as a real piece of work rather than assumed cheap.

**Neutral.** The database keeps the shape of a multi-locale catalog —
`reference_translations` is still keyed by `(item, locale)`. Migration 0009
removes the Urdu rows and adds a `locale = 'en'` constraint to both locale
columns, so a locale returns as a deliberate migration rather than a stray
INSERT no client has a catalog for. Migration 0005 still seeds the Urdu labels
and is left untouched, so they are recoverable.

**Neutral.** Tests assert Urdu does **not** resolve, is **not** stored, and
that no Arabic-script character appears in the English catalog, so neither
removed locale can survive by accident.
