import { emerald, gold, gradients, neutral, status } from './palette';

/**
 * Semantic theme.
 *
 * Components name a *role* — `surface`, `textMuted`, `borderStrong` — never a
 * hex value. A dark theme is then a second object satisfying the same
 * interface, not a sweep through every screen.
 *
 * Only the light theme ships in v1. `darkTheme` is intentionally absent rather
 * than half-built: an untested dark palette that renders somewhere is worse
 * than one that does not exist yet.
 */

export interface Theme {
  name: 'light' | 'dark';
  colors: {
    /** Page background. */
    background: string;
    /** Raised surfaces: cards, sheets. */
    surface: string;
    /** Recessed surfaces: inputs, wells. */
    surfaceSunken: string;

    border: string;
    borderStrong: string;

    text: string;
    textMuted: string;
    textSubtle: string;
    /** Text on a brand-coloured background. */
    textOnBrand: string;

    brand: string;
    brandHover: string;
    brandSurface: string;
    brandBorder: string;

    accent: string;
    accentSurface: string;

    danger: string;
    dangerSurface: string;
    success: string;
    successSurface: string;
  };
  gradients: {
    brand: readonly [string, string];
    brandDeep: readonly [string, string];
    warm: readonly [string, string];
  };
  /** Elevation. Kept shallow — heavy shadows read as dated and cost fill-rate on low-end devices. */
  shadow: {
    card: object;
    raised: object;
  };
}

export const lightTheme: Theme = {
  name: 'light',
  colors: {
    background: neutral[0],
    surface: neutral[0],
    surfaceSunken: neutral[50],

    border: neutral[100],
    borderStrong: neutral[200],

    text: neutral[900],
    textMuted: neutral[500],
    textSubtle: neutral[400],
    textOnBrand: neutral[0],

    brand: emerald[600],
    brandHover: emerald[700],
    brandSurface: emerald[50],
    brandBorder: emerald[200],

    accent: gold[500],
    accentSurface: gold[50],

    danger: status.danger,
    dangerSurface: status.dangerSurface,
    success: status.success,
    successSurface: status.successSurface,
  },
  gradients: {
    brand: gradients.brand,
    brandDeep: gradients.brandDeep,
    warm: gradients.warm,
  },
  shadow: {
    card: {
      shadowColor: neutral[900],
      shadowOpacity: 0.05,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    raised: {
      shadowColor: neutral[900],
      shadowOpacity: 0.09,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 5,
    },
  },
};

export const themes = { light: lightTheme } as const;
export type ThemeName = keyof typeof themes;
