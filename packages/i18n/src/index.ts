import { DEFAULT_LOCALE, LOCALES, isRtl, type Locale } from '@nikahmate/domain';
import en from './locales/en.json' with { type: 'json' };
import ur from './locales/ur.json' with { type: 'json' };
import ar from './locales/ar.json' with { type: 'json' };

/**
 * Translation catalogs and locale metadata.
 *
 * Shared by the mobile app now, and by the admin panel and website later —
 * a string translated once is translated for every client.
 *
 * ⚠️ These translations have NOT been reviewed by native speakers. For a product
 * where language is core to trust, they must be before launch. Treat them as
 * scaffolding that proves the plumbing, not as shippable copy.
 */

export type TranslationCatalog = typeof en;

export const catalogs: Record<Locale, TranslationCatalog> = {
  en,
  ur: ur as TranslationCatalog,
  ar: ar as TranslationCatalog,
};

export interface LocaleMeta {
  code: Locale;
  /** Name in the language itself — a language picker should never be in English only. */
  nativeName: string;
  englishName: string;
  direction: 'ltr' | 'rtl';
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { code: 'en', nativeName: 'English', englishName: 'English', direction: 'ltr' },
  ur: { code: 'ur', nativeName: 'اردو', englishName: 'Urdu', direction: 'rtl' },
  ar: { code: 'ar', nativeName: 'العربية', englishName: 'Arabic', direction: 'rtl' },
};

export const SUPPORTED_LOCALES = LOCALES;
export { DEFAULT_LOCALE, isRtl };
export type { Locale };

/**
 * Picks the best supported locale for a device.
 *
 * Falls back by language before falling back to English: a device set to
 * `ar-EG` should get Arabic, not English.
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

export function directionFor(locale: Locale): 'ltr' | 'rtl' {
  return LOCALE_META[locale].direction;
}

/**
 * Resolves a dotted key such as `tabs.discover`.
 *
 * Falls back to English rather than rendering the raw key: a missing Urdu
 * string should show English, not `tabs.discover`, to someone mid-signup.
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
 * must fit a 320dp screen, and Urdu and Arabic run longer than English. This is
 * the constraint made testable rather than left as a note.
 */
export const MAX_TAB_LABEL_CHARS = 12;
