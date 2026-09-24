import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager, Platform } from 'react-native';
import * as Localization from 'expo-localization';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  SUPPORTED_LOCALES,
  directionFor,
  resolveLocale,
  translate,
  type Locale,
} from '@nikahmate/i18n';
import { getItem, setItem } from '../storage';

const STORAGE_KEY = 'locale';

interface LocaleContextValue {
  locale: Locale;
  direction: 'ltr' | 'rtl';
  isRtl: boolean;
  /** Translate a dotted key, e.g. `tabs.discover`. */
  t: (key: string) => string;
  setLocale: (locale: Locale) => void;
  available: typeof SUPPORTED_LOCALES;
  /**
   * True when the chosen direction differs from the one the native layout
   * engine is currently using. Native RTL needs an app restart to take full
   * effect; the UI says so rather than looking broken.
   */
  needsRestartForRtl: boolean;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(Localization.getLocales().map((l) => l.languageTag)),
  );
  const [restored, setRestored] = useState(false);

  // A stored choice beats the device language: someone whose phone is in
  // English may still want the app in Urdu.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getItem(STORAGE_KEY);
      if (!cancelled && stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
        setLocaleState(stored as Locale);
      }
      if (!cancelled) setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const direction = directionFor(locale);
  const rtl = direction === 'rtl';

  useEffect(() => {
    if (Platform.OS === 'web') {
      // On web the document direction does the work, and it applies
      // immediately — no restart, which is why web is where the RTL shell can
      // be verified quickly.
      if (typeof document !== 'undefined') {
        document.documentElement.dir = direction;
        document.documentElement.lang = locale;
      }
      return;
    }
    // Native: allow RTL so the layout engine will mirror, but do not force a
    // reload out from under someone mid-task.
    I18nManager.allowRTL(true);
  }, [direction, locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    void setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      direction,
      isRtl: rtl,
      t: (key: string) => translate(locale, key),
      setLocale,
      available: SUPPORTED_LOCALES,
      needsRestartForRtl: Platform.OS !== 'web' && I18nManager.isRTL !== rtl,
    }),
    [locale, direction, rtl, setLocale],
  );

  // Holding the first frame until the stored locale is known avoids a visible
  // flip from English to Urdu, which on an RTL locale is a whole-layout flash.
  if (!restored) return null;

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
