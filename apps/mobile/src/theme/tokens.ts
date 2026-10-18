/**
 * Non-colour design tokens: spacing, radius, type, layout.
 *
 * Colours live in `theme.ts` because they change with the theme. These do not.
 *
 * Everything here is sized against the smallest device we support — 320dp —
 * not a flagship.
 */

/** 4pt base scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/**
 * Type scale.
 *
 * `lineHeight` is generous relative to `fontSize` — roughly 1.4–1.5 — because
 * tight leading clips descenders inside height-constrained containers. That
 * renders fine at one string length and badly at another, which is how it
 * ships unnoticed. It has already happened once, in the tab bar.
 */
export const typography = {
  display: { fontSize: 30, lineHeight: 40, fontWeight: '700', letterSpacing: -0.4 },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '700', letterSpacing: -0.2 },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 23, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
  /** Small caps-ish label for section eyebrows. */
  overline: { fontSize: 11, lineHeight: 16, fontWeight: '700', letterSpacing: 0.8 },
  /** Five tab labels must fit 320dp (ADR 0004). */
  tabLabel: { fontSize: 11, lineHeight: 16, fontWeight: '600' },
} as const;

/** The narrowest screen the app must remain usable on. */
export const MIN_SUPPORTED_WIDTH = 320;

/** Minimum touch target. Below this, people with less steady hands miss. */
export const MIN_TOUCH_TARGET = 48;

export const layout = {
  /** Side gutter. 20 leaves 280dp of content at 320dp, which reads comfortably. */
  gutter: 20,
  maxContentWidth: 560,
  /**
   * Tab bar height, excluding the safe-area inset the navigator adds.
   * Sized for the tallest script we ship, not the shortest.
   */
  tabBarHeight: 62,
} as const;

/**
 * Micro-interaction timings.
 *
 * Short and consistent. A press should feel immediate; anything over ~150ms
 * reads as lag rather than polish, especially on the low-end devices this
 * product targets.
 */
export const motion = {
  pressIn: 90,
  pressOut: 140,
  pressScale: 0.97,
  /** Fade-and-rise for a card arriving on screen. */
  entrance: 300,
  /** Delay per position down a list, so a page assembles rather than blinks. */
  stagger: 55,
  /**
   * Positions after which the stagger stops growing.
   *
   * Uncapped, the twentieth card waits over a second while the reader is
   * already looking at it — the animation stops being an entrance and becomes
   * a delay.
   */
  staggerCap: 6,
} as const;

/**
 * Icon sizes.
 *
 * Named because the alternative is what this file used to allow: twelve
 * different literals — 13, 14, 15, 17, 18, 19, 20, 24, 26, 30 — chosen
 * per-component with no relationship between them. Nobody can name the
 * difference between a 17 and a 19, but the eye reads the inconsistency as
 * carelessness.
 *
 * `md` is 24, which is the platform default and the size at which a standalone
 * icon control remains legible.
 */
export const iconSize = {
  /** Inside a chip or beside caption text. */
  xs: 14,
  /** Inline with body text — list rows, section marks. */
  sm: 18,
  /** Standalone controls, tab bar, navigation. */
  md: 24,
  /** A control that is the focus of its own row. */
  lg: 28,
} as const;
