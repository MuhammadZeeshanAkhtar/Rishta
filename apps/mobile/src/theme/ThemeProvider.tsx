import React, { createContext, useContext, useMemo } from 'react';
import { lightTheme, type Theme } from './theme';

/**
 * Theme access.
 *
 * v1 ships one theme. The provider exists anyway so that adding a dark theme
 * later is a change here and in `theme.ts` — not a sweep through every screen
 * hunting for hardcoded colours. Components already call `useTheme()`, so the
 * wiring is done.
 */

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({
  children,
  theme = lightTheme,
}: {
  children: React.ReactNode;
  theme?: Theme;
}) {
  const value = useMemo(() => theme, [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
