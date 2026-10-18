import { DEFAULT_LOCALE, LOCALES, type Locale } from '@nikahmate/domain';
import en from './locales/en.json';

/**
 * Translation catalogs and locale metadata.
 *
 * Shared by the mobile app now, and by the admin panel and website later —
 * a string translated once is translated for every client.
 *
 * The product ships in English only. The indirection stays because it is what
 * keeps user-facing copy out of component files; a second locale is a catalog
 * beside this one plus its code in `LOCALES`.
 */

export type TranslationCatalog = typeof en;

export const catalogs: Record<Locale, TranslationCatalog> = {
  en,
};

export interface LocaleMeta {
  code: Locale;
  /** Name in the language itself — a language picker should never be in English only. */
  nativeName: string;
  englishName: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { code: 'en', nativeName: 'English', englishName: 'English' },
};

export const SUPPORTED_LOCALES = LOCALES;
export { DEFAULT_LOCALE };
export type { Locale };

/**
 * Picks the best supported locale for a device.
 *
 * Falls back by language before falling back to the default, so a device set
 * to `en-GB` resolves to `en` rather than skipping straight past it. With one
 * supported locale every input resolves to English; the matching is kept so
 * adding a locale needs no new code here.
 */
export function resolveLocale(preferred: readonly string[] | string | undefined): Locale {
  const candidates = typeof preferred === 'string' ? [preferred] : (preferred ?? []);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const exact = LOCALES.find((l) => l === lower);
    if (exact) return exact;
    const base = lower.split('-')[0];
    const byLanguage = LOCALES.find((l) => l === base);
    if (byLanguage) return byLanguage;
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolves a dotted key such as `tabs.discover`.
 *
 * Falls back to English rather than rendering the raw key: a missing string
 * should show something readable, not `tabs.discover`, to someone mid-signup.
 */
export function translate(locale: Locale, key: string): string {
  return lookup(catalogs[locale], key) ?? lookup(catalogs[DEFAULT_LOCALE], key) ?? key;
}

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Every dotted key present in a catalog. Used by the parity test. */
export function flattenKeys(catalog: unknown, prefix = ''): string[] {
  if (typeof catalog !== 'object' || catalog === null) return [];
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flattenKeys(value, path) : [path];
  });
}

/**
 * Maximum rendered length of a bottom-tab label.
 *
 * ADR 0004 chose five tabs, and recorded label length as the cost: five labels
 * must fit a 320dp screen. This is the constraint made testable rather than
 * left as a note.
 */
export const MAX_TAB_LABEL_CHARS = 12;
