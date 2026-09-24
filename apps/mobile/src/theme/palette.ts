/**
 * NikahMate brand palette — raw colour values.
 *
 * Nothing outside `theme.ts` should import from here. Components ask the theme
 * for a *role* ("surface", "textMuted"), never for a hex value, which is what
 * makes a dark theme a new mapping rather than a rewrite.
 *
 * The palette is deliberately narrow. Two brand hues and one neutral ramp is
 * enough for a product that should read as calm and trustworthy; a wider
 * palette would mostly create opportunities to be inconsistent.
 */

/**
 * Emerald–teal. The anchor.
 *
 * Green carries positive associations across the markets this product serves,
 * and the teal lean keeps it from reading as either clinical or festive. Deep
 * enough to hold white text at AA contrast at every step from 600 up.
 */
export const emerald = {
  50: '#EDF7F4',
  100: '#D3ECE5',
  200: '#A7D9CC',
  300: '#71C1AE',
  400: '#3DA48D',
  500: '#1C8A72',
  600: '#0E6B5C', // primary
  700: '#0A5449',
  800: '#083F37',
  900: '#052A25',
} as const;

/**
 * Warm gold. Accent only — never a surface, never body text.
 *
 * Used sparingly for moments that deserve weight: the mark, a verified badge,
 * a highlighted state. Gold everywhere would read as a luxury brand, which
 * this is not.
 */
export const gold = {
  50: '#FBF6EA',
  100: '#F4E8CC',
  200: '#E8D09A',
  300: '#DBB765',
  400: '#CFA23F',
  500: '#B98A28', // accent
  600: '#966D1D',
  700: '#6F5015',
} as const;

/**
 * Neutrals, warmed very slightly toward green so they sit with the brand
 * rather than against it.
 */
export const neutral = {
  0: '#FFFFFF',
  25: '#FAFBFA',
  50: '#F4F7F6',
  100: '#E9EEEC',
  200: '#D7DEDB',
  300: '#B6C1BD',
  400: '#8A9995',
  500: '#68766F',
  600: '#4C5954',
  700: '#36413D',
  800: '#222B28',
  900: '#0F1613',
} as const;

/** Status colours. Deliberately muted — this product should not shout. */
export const status = {
  danger: '#B3261E',
  dangerSurface: '#FCEEED',
  success: emerald[600],
  successSurface: emerald[50],
  warning: gold[500],
  warningSurface: gold[50],
} as const;

/** Brand gradients. Two stops only; more reads as decoration. */
export const gradients = {
  /** Primary surfaces — auth hero, primary buttons. */
  brand: [emerald[600], emerald[500]] as const,
  /** Deeper variant for large areas where the brand needs to recede. */
  brandDeep: [emerald[700], emerald[600]] as const,
  /** A whisper of warmth behind light content. */
  warm: [neutral[0], emerald[50]] as const,
} as const;
