/**
 * Design tokens.
 *
 * Values live here, never inline in a component, so the future website and
 * admin panel can share them (README §19: share tokens, not components).
 *
 * Sizing assumes the smallest device we support: 320dp wide. Every spacing and
 * type value below has been chosen against that, not against a flagship.
 */

export const colors = {
  /** Deep green — the product's anchor. */
  primary: '#1F6F5C',
  primaryDark: '#164F42',
  primaryLight: '#E6F2EE',

  accent: '#C9A227',

  background: '#FFFFFF',
  surface: '#F7F8F7',
  border: '#E2E6E3',

  text: '#14201C',
  textMuted: '#5B6B65',
  textInverse: '#FFFFFF',

  danger: '#B3261E',
  success: '#1F6F5C',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  /**
   * Tab labels. Small because five of them must fit 320dp, and Urdu and Arabic
   * labels run longer than English (ADR 0004).
   *
   * lineHeight is 16, not 14. Arabic and Urdu glyphs occupy more vertical space
   * than Latin at the same font size, and at 14 their descenders were clipped
   * by the tab bar — visible only when actually rendering in those languages,
   * which is the point of verifying in all three rather than in English.
   */
  tabLabel: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
} as const;

/** The narrowest screen the app must remain usable on. */
export const MIN_SUPPORTED_WIDTH = 320;

/** Minimum touch target. Below this, people with less steady hands miss. */
export const MIN_TOUCH_TARGET = 44;

export const layout = {
  /** Side gutter. 16 leaves 288dp of content at 320dp, which is workable. */
  gutter: spacing.md,
  maxContentWidth: 560,
  /**
   * Tab bar height, excluding the safe-area inset the navigator adds.
   *
   * Sized for the tallest script we ship, not the shortest. 48 fitted English
   * and clipped Arabic.
   */
  tabBarHeight: 60,
} as const;
