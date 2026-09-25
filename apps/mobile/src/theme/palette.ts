/**
 * NikahMate brand palette — raw colour values.
 *
 * Nothing outside `theme.ts` should import from here. Components ask the theme
 * for a *role* ("surface", "textMuted"), never for a hex value, which is what
 * makes a dark theme a new mapping rather than a rewrite.
 *
 * Two brand hues and one neutral ramp. Emerald is the brand; gold is an accent
 * used at moments that deserve weight, never as a surface and never as body
 * text. A wider palette would mostly create opportunities to be inconsistent.
 */

/**
 * Emerald — the brand.
 *
 * 600 is the primary action colour and 800 the deep tone that carries dark
 * surfaces. Green reads positively across the markets this product serves, and
 * these steps hold white text at AA from 600 down.
 */
export const emerald = {
  50: '#ECFDF5',
  100: '#D1FAE5',
  200: '#A7F3D0',
  300: '#6EE7B7',
  400: '#10B981',
  500: '#059669',
  600: '#047857', // primary
  700: '#065F46',
  800: '#064E3B', // deep — dark surfaces, app icon ground
  900: '#03291F',
} as const;

/**
 * Gold — the accent.
 *
 * Reserved for the keystone in the mark, premium moments and earned states.
 * 500 is the brand gold; 300 is the softer tone that survives on dark grounds
 * where full gold would glare.
 */
export const gold = {
  50: '#FBF7EA',
  100: '#F6EDCF',
  200: '#EEDDA4',
  300: '#E5C76B', // soft gold
  400: '#DCBB4E',
  500: '#D4AF37', // brand gold
  600: '#B4902A',
  700: '#8A6D1F',
} as const;

/**
 * Neutrals. Warm at the light end so surfaces sit with the brand rather than
 * against it, resolving to a near-black charcoal for text.
 */
export const neutral = {
  0: '#FFFFFF',
  25: '#FAFAF7', // warm white — the app background
  50: '#F3F4F1',
  100: '#E6E7E2',
  200: '#D2D4CE',
  300: '#AEB1A9',
  400: '#7C8079',
  500: '#565B54',
  600: '#3A3F3A',
  700: '#272B28',
  800: '#1A1E1C',
  900: '#111827', // charcoal
} as const;

/** Status colours. Muted — this product should not shout. */
export const status = {
  danger: '#B3261E',
  dangerSurface: '#FCEEED',
  success: emerald[600],
  successSurface: emerald[50],
  warning: gold[600],
  warningSurface: gold[50],
} as const;

/**
 * Brand gradients. Two stops, emerald only.
 *
 * Gold never gradients: a gold gradient is the fastest route to looking cheap,
 * and the accent works because it appears as flat, deliberate colour.
 */
export const gradients = {
  /** Primary actions. */
  brand: [emerald[600], emerald[500]] as const,
  /**
   * Large brand areas — the auth hero.
   *
   * Deeper than `brand` on purpose: the mark contains an emerald ribbon, and on
   * a mid-emerald ground that ribbon loses contrast and the heart half
   * disappears. Dropping the ground two steps keeps the symbol legible.
   */
  brandDeep: [emerald[900], emerald[700]] as const,
  /** A whisper of warmth behind light content. */
  warm: [neutral[25], emerald[50]] as const,
} as const;
