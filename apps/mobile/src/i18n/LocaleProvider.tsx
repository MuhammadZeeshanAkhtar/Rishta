import React, { createContext, useContext, useMemo } from 'react';
import { DEFAULT_LOCALE, LOCALE_META, translate, type Locale } from '@nikahmate/i18n';

interface LocaleContextValue {
  locale: Locale;
  /** Translate a dotted key, e.g. `tabs.discover`. */
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Supplies translated copy to the tree.
 *
 * The app ships in English only, so there is no device detection, no stored
 * preference and no switcher: the locale is a constant. The provider stays
 * because `t()` is how user-facing copy is kept out of component files, and
 * because a second locale should be a change here rather than in every screen.
 *
 * Right-to-left support was removed with Urdu. There is no `direction`, no
 * `I18nManager` call and no restart prompt — English needs none of it, and
 * RTL code that nothing exercises is worse than no RTL code at all.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale: DEFAULT_LOCALE,
      t: (key: string) => translate(DEFAULT_LOCALE, key),
    }),
    [],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used inside LocaleProvider');
  }
  return context;
}

export { LOCALE_META, DEFAULT_LOCALE };
export type { Locale };
