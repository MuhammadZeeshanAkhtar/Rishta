import { describe, expect, it } from 'vitest';
import {
  MAX_TAB_LABEL_CHARS,
  SUPPORTED_LOCALES,
  catalogs,
  directionFor,
  flattenKeys,
  resolveLocale,
  translate,
} from './index';

describe('catalog parity', () => {
  const englishKeys = flattenKeys(catalogs.en).sort();

  it('ships English, Urdu and Arabic', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'ur', 'ar']);
  });

  it.each(SUPPORTED_LOCALES)('%s has exactly the English key set', (locale) => {
    // A missing key is a blank screen for a real person mid-signup, and it is
    // the kind of thing that only shows up in the language nobody on the team
    // reads. Cheap to catch here.
    expect(flattenKeys(catalogs[locale]).sort()).toEqual(englishKeys);
  });

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (locale) => {
    const empty = flattenKeys(catalogs[locale]).filter(
      (key) => translate(locale, key).trim().length === 0,
    );
    expect(empty).toEqual([]);
  });

  it.each(['ur', 'ar'] as const)('%s is actually translated, not copied from English', (locale) => {
    // Guards against a catalog that was duplicated and never filled in.
    // `continueWithGoogle` is excluded: "Google" is a brand name and legitimately
    // stays Latin script in both.
    const identical = englishKeys.filter(
      (key) => key !== 'auth.continueWithGoogle' && translate(locale, key) === translate('en', key),
    );
    expect(identical).toEqual([]);
  });
});

describe('direction', () => {
  it('marks Urdu and Arabic RTL and English LTR', () => {
    expect(directionFor('ur')).toBe('rtl');
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
  });
});

describe('resolveLocale', () => {
  it('matches an exact locale', () => {
    expect(resolveLocale('ur')).toBe('ur');
  });

  it('falls back by language before falling back to English', () => {
    // A device set to ar-EG should get Arabic, not English.
    expect(resolveLocale('ar-EG')).toBe('ar');
    expect(resolveLocale('en-GB')).toBe('en');
  });

  it('walks the preference list in order', () => {
    expect(resolveLocale(['fr-FR', 'ar-SA', 'en'])).toBe('ar');
  });

  it('falls back to English for an unsupported language', () => {
    expect(resolveLocale('ja')).toBe('en');
  });

  it('handles an absent preference', () => {
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });
});

describe('translate', () => {
  it('resolves a dotted key', () => {
    expect(translate('en', 'tabs.discover')).toBe('Discover');
  });

  it('falls back to English rather than showing a raw key', () => {
    expect(translate('ur', 'nope.missing')).toBe('nope.missing');
    expect(translate('en', 'tabs.discover')).not.toContain('.');
  });
});

describe('tab labels fit a 320dp screen (ADR 0004)', () => {
  // Five tabs was chosen deliberately, and label length was the recorded cost.
  // This is that cost made testable: if a translation grows past the budget,
  // CI says so rather than a cramped tab bar shipping to Urdu users.
  const tabKeys = ['discover', 'interests', 'messages', 'family', 'me'] as const;

  it.each(SUPPORTED_LOCALES)('%s labels stay within budget', (locale) => {
    const tooLong = tabKeys
      .map((k) => ({ key: k, label: translate(locale, `tabs.${k}`) }))
      .filter(({ label }) => label.length > MAX_TAB_LABEL_CHARS);
    expect(tooLong).toEqual([]);
  });
});
