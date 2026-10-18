import { describe, expect, it } from 'vitest';
import {
  MAX_TAB_LABEL_CHARS,
  SUPPORTED_LOCALES,
  catalogs,
  flattenKeys,
  resolveLocale,
  translate,
} from './index';

describe('catalog parity', () => {
  const englishKeys = flattenKeys(catalogs.en).sort();

  it('ships English only', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en']);
  });

  it('carries no catalog for a removed locale', () => {
    // Urdu and Arabic were both supported earlier. Neither may survive as a
    // hidden or partially supported catalog.
    expect(Object.keys(catalogs)).toEqual(['en']);
  });

  it.each(SUPPORTED_LOCALES)('%s has exactly the English key set', (locale) => {
    // A missing key is a blank screen for a real person mid-signup. Cheap to
    // catch here, and the check keeps its value the moment a locale is added.
    expect(flattenKeys(catalogs[locale]).sort()).toEqual(englishKeys);
  });

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (locale) => {
    const empty = flattenKeys(catalogs[locale]).filter(
      (key) => translate(locale, key).trim().length === 0,
    );
    expect(empty).toEqual([]);
  });
});

describe('resolveLocale', () => {
  it('matches an exact locale', () => {
    expect(resolveLocale('en')).toBe('en');
  });

  it('falls back by language before falling back to the default', () => {
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('en-PK')).toBe('en');
  });

  it('walks the preference list in order', () => {
    expect(resolveLocale(['fr-FR', 'en-GB', 'ja'])).toBe('en');
  });

  it('falls back to English for an unsupported language', () => {
    expect(resolveLocale('ja')).toBe('en');
    // Including the ones that used to be supported.
    expect(resolveLocale('ur')).toBe('en');
    expect(resolveLocale('ur-PK')).toBe('en');
    expect(resolveLocale('ar')).toBe('en');
    expect(resolveLocale('ar-EG')).toBe('en');
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

  it('returns the key rather than blank when nothing matches', () => {
    expect(translate('en', 'nope.missing')).toBe('nope.missing');
    expect(translate('en', 'tabs.discover')).not.toContain('.');
  });
});

describe('catalog is free of right-to-left text', () => {
  /** Arabic, Arabic Supplement, Arabic Presentation Forms A and B. */
  const RTL_BLOCKS: ReadonlyArray<readonly [number, number]> = [
    [0x0600, 0x06ff],
    [0x0750, 0x077f],
    [0xfb50, 0xfdff],
    [0xfe70, 0xfeff],
  ];

  const hasRtlScript = (text: string): boolean =>
    [...text].some((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return RTL_BLOCKS.some(([lo, hi]) => cp >= lo && cp <= hi);
    });

  it('contains no Arabic-script characters', () => {
    // The Urdu catalog is gone. This proves none of it was pasted into the
    // English one, which would render as right-to-left text in an app that no
    // longer has any direction handling.
    const offenders = flattenKeys(catalogs.en).filter((key) => hasRtlScript(translate('en', key)));
    expect(offenders).toEqual([]);
  });

  it('detects right-to-left script when it is present', () => {
    // Guards the guard: a check that can never fire is not a check.
    expect(hasRtlScript('Pakistan')).toBe(false);
    expect(hasRtlScript(String.fromCodePoint(0x067e, 0x0627))).toBe(true);
  });
});

describe('tab labels fit a 320dp screen (ADR 0004)', () => {
  // Five tabs was chosen deliberately, and label length was the recorded cost.
  // This is that cost made testable: if a label grows past the budget, CI says
  // so rather than a cramped tab bar shipping.
  const tabKeys = ['discover', 'interests', 'messages', 'family', 'me'] as const;

  it.each(SUPPORTED_LOCALES)('%s labels stay within budget', (locale) => {
    const tooLong = tabKeys
      .map((k) => ({ key: k, label: translate(locale, `tabs.${k}`) }))
      .filter(({ label }) => label.length > MAX_TAB_LABEL_CHARS);
    expect(tooLong).toEqual([]);
  });
});
