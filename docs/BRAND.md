# NikahMate brand

**The official identity.** What ships on Google Play, the App Store, the future
website, the admin panel and every marketing surface.

---

## The mark

![NikahMate lockup](brand/lockup-dark.png)

A heart formed from two interlocking ribbons — one emerald, one gold — beneath a
crescent and star, with the **N** monogram held inside. Two strands, distinct
and complete on their own, becoming one form.

The artwork is supplied, not generated. The original lives at
[`brand/source/nikahmate-logo-source.webp`](brand/source/) and every asset in
the app is derived from it by one script, so the identity has a single source of
truth rather than a folder of hand-edited exports.

---

## Official versions

| Version                 | File                                                     | Use                                                     |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| **Symbol**              | [`brand/symbol.png`](brand/symbol.png)                   | Transparent. The mark alone                             |
| **Symbol on light**     | [`brand/symbol-on-light.png`](brand/symbol-on-light.png) | Warm-white ground                                       |
| **Wordmark**            | [`brand/wordmark.png`](brand/wordmark.png)               | Transparent, two-tone                                   |
| **Full lockup**         | [`brand/lockup-dark.png`](brand/lockup-dark.png)         | Emerald ground. Store listings, marketing               |
| **App icon**            | `../apps/mobile/assets/icon.png`                         | 1024, full bleed, symbol + wordmark                     |
| **Adaptive foreground** | `../apps/mobile/assets/adaptive-icon.png`                | Symbol only, transparent, in the Android mask safe zone |
| **Splash**              | `../apps/mobile/assets/splash-icon.png`                  | Symbol only, transparent                                |
| **Favicon**             | `../apps/mobile/assets/favicon.png`                      | 64, symbol on emerald                                   |

### Three production decisions worth knowing

**The icon is rebuilt, not cropped.** The source has rounded corners and a drop
shadow baked in. iOS and Android apply their own mask, and a pre-rounded icon
inside that mask gives double corners and a shadow fringe. The icon is therefore
recomposited onto a full-bleed ground the script controls.

**The adaptive foreground and splash use the symbol alone.** Android crops the
foreground to a circle or squircle; a wordmark does not survive that, and it
would not be legible at launcher size regardless. The full lockup stays for the
store listing, where it is seen large.

**The in-app wordmark is live text, not an image** — crisp at any size, takes
the theme, and the two-tone treatment lives in one component instead of an
export.

### Regenerating

```bash
python apps/mobile/scripts/build-brand-assets.py
```

Pillow is required. It is a developer tool, not an app dependency.

### In the app

```tsx
<Logo size={88} variant="stacked" tone="dark" />  // auth hero
<Logo size={44} />                                 // default: symbol, light
<Logo variant="horizontal" />                      // symbol + wordmark, inline
```

`variant`: `symbol` · `horizontal` · `stacked` — `tone`: `light` · `dark` · `mono`.

---

## Colour

Emerald is the brand. Gold is an accent for moments that deserve weight — the
monogram, a premium state, an earned badge. **Gold is never a surface and never
body text.**

| Role                    | Token          | Hex       |
| ----------------------- | -------------- | --------- |
| Deep emerald            | `emerald[800]` | `#064E3B` |
| **Emerald — primary**   | `emerald[600]` | `#047857` |
| **Gold — accent**       | `gold[500]`    | `#D4AF37` |
| Soft gold               | `gold[300]`    | `#E5C76B` |
| Charcoal — text         | `neutral[900]` | `#111827` |
| Warm white — background | `neutral[25]`  | `#FAFAF7` |

Full ramps: [`apps/mobile/src/theme/palette.ts`](../apps/mobile/src/theme/palette.ts).

**Components never use a hex value.** They ask the theme for a _role_ — `brand`,
`textMuted`, `surfaceSunken` — which is what makes a dark theme a new mapping
rather than a rewrite.

**The hero gradient runs deeper than the primary one on purpose.** The mark
contains an emerald ribbon; on a mid-emerald ground that ribbon loses contrast
and half the heart disappears. Dropping the ground two steps keeps the symbol
legible. Gold never gradients — flat gold is what keeps the accent from looking
cheap.

---

## Typography

The **system sans** — SF Pro on iOS, Roboto on Android. Modern, neutral,
international; no font file, no network fetch, no dependency, and both already
carry the Urdu coverage the secondary locale needs.

The wordmark is weight 700 at `-0.5` tracking, with **Nikah** in the neutral and
**Mate** in gold.

| Style      | Size / line height | Use              |
| ---------- | ------------------ | ---------------- |
| `display`  | 30 / 40            | Screen titles    |
| `title`    | 22 / 30            | Section titles   |
| `heading`  | 17 / 24            | Card headings    |
| `body`     | 15 / 23            | Body copy        |
| `caption`  | 13 / 19            | Secondary detail |
| `overline` | 11 / 16, tracked   | Eyebrows         |
| `tabLabel` | 11 / 16            | Tab bar          |

**Leading is generous — roughly 1.4–1.5 — on purpose.** Urdu glyphs occupy more
vertical space than Latin at the same size. Tight leading looks fine in English
and clips in Urdu, a bug that only shows in the language nobody on the team
reads. It has already happened once, in the tab bar.

---

## Where the identity appears

| Surface                                  | Mark                                  | Emerald                            | Gold             |
| ---------------------------------------- | ------------------------------------- | ---------------------------------- | ---------------- |
| App icon / splash                        | Symbol (+ wordmark on the store icon) | Ground                             | In the mark      |
| Auth hero                                | Stacked, dark tone                    | Deep gradient ground               | "Mate", monogram |
| Sign in                                  | —                                     | Method icons, back action          | —                |
| Tab bar                                  | —                                     | Active tab                         | —                |
| Discover / Interests / Messages / Family | —                                     | Headings, accents                  | —                |
| Me                                       | Symbol, light tone                    | Selected language, headings        | In the mark      |
| Buttons                                  | —                                     | Primary gradient, secondary border | —                |
| Cards, empty states, loading             | —                                     | Overlines, spinner                 | —                |

Emerald carries every action and active state. Gold is held back so that where
it appears, it means something.

---

## Before store submission

**Confirm you hold the rights to the source artwork.** The identity is built
entirely from the file you supplied and contains no third-party asset from
anywhere else — but only you can confirm its provenance, and both stores require
that you own or are licensed for what you publish.
