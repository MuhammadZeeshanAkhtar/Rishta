import { afterEach, describe, expect, it } from 'vitest';
import {
  MINIMUM_AGE_YEARS,
  ageFromDateOfBirth,
  bootstrapRequestSchema,
  identitySchema,
  meetsMinimumAge,
  userSettingsUpdateSchema,
} from './account';
import { DEFAULT_LOCALE, LOCALES, REFERENCE_TYPES, FREE_PLAN_ENTITLEMENTS } from './constants';
import { phoneE164Schema, referenceCodeSchema, timezoneSchema } from './common';

describe('ageFromDateOfBirth', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('computes whole years', () => {
    expect(ageFromDateOfBirth('2000-09-24', now)).toBe(26);
    expect(ageFromDateOfBirth('1990-01-01', now)).toBe(36);
  });

  it('does not credit a birthday that has not happened yet this year', () => {
    expect(ageFromDateOfBirth('2000-09-25', now)).toBe(25);
    expect(ageFromDateOfBirth('2000-12-31', now)).toBe(25);
  });

  it('credits the birthday on the day itself', () => {
    expect(ageFromDateOfBirth('2008-09-24', now)).toBe(18);
  });

  it('handles a 29 February birth date in a non-leap year', () => {
    // Born 2004-02-29; on 2026-02-28 they are still 21, on 03-01 they are 22.
    expect(ageFromDateOfBirth('2004-02-29', new Date('2026-02-28T00:00:00Z'))).toBe(21);
    expect(ageFromDateOfBirth('2004-02-29', new Date('2026-03-01T00:00:00Z'))).toBe(22);
  });
});

describe('meetsMinimumAge', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('accepts someone who is exactly the minimum age today', () => {
    expect(meetsMinimumAge('2008-09-24', now)).toBe(true);
  });

  it('rejects someone one day short', () => {
    expect(meetsMinimumAge('2008-09-25', now)).toBe(false);
  });

  it('is 18', () => {
    expect(MINIMUM_AGE_YEARS).toBe(18);
  });
});

describe('identitySchema', () => {
  const valid = {
    displayName: 'Aisha',
    gender: 'female' as const,
    dateOfBirth: '1998-04-12',
    countryCode: 'PK',
  };

  it('accepts a well-formed identity', () => {
    expect(identitySchema.safeParse(valid).success).toBe(true);
  });

  it('canonicalises a country code to lower case', () => {
    // Lower case is what the database requires: country codes live in
    // `reference_items`, whose code shape forbids upper case, and
    // `users.country_code` carries a composite FK to it. Accepting 'PK' and
    // storing 'pk' keeps the ISO-canonical form working for clients while the
    // one form the schema can actually store reaches Postgres.
    //
    // This reverses an earlier expectation that upper case was required. That
    // expectation could never have been satisfied by a real insert.
    expect(identitySchema.parse({ ...valid, countryCode: 'PK' }).countryCode).toBe('pk');
    expect(identitySchema.parse({ ...valid, countryCode: 'pk' }).countryCode).toBe('pk');
  });

  it('still rejects a country code that is not two letters', () => {
    for (const bad of ['p', 'pak', '1k', 'p k', '']) {
      expect(identitySchema.safeParse({ ...valid, countryCode: bad }).success).toBe(false);
    }
  });

  it('rejects a country code that is not two letters', () => {
    expect(identitySchema.safeParse({ ...valid, countryCode: 'PAK' }).success).toBe(false);
  });

  it('rejects a gender outside the closed set', () => {
    expect(identitySchema.safeParse({ ...valid, gender: 'other' }).success).toBe(false);
  });

  it('rejects an empty display name', () => {
    expect(identitySchema.safeParse({ ...valid, displayName: '' }).success).toBe(false);
  });
});

describe('bootstrapRequestSchema', () => {
  it('accepts locale and timezone alone', () => {
    expect(
      bootstrapRequestSchema.safeParse({ locale: 'en', timezone: 'Asia/Karachi' }).success,
    ).toBe(true);
  });

  it('rejects a locale the product no longer ships', () => {
    // Urdu was a launch locale. A client still sending it must be refused
    // rather than storing a value nothing has a catalog for.
    expect(
      bootstrapRequestSchema.safeParse({ locale: 'ur', timezone: 'Asia/Karachi' }).success,
    ).toBe(false);
  });

  it('rejects a bogus timezone', () => {
    expect(
      bootstrapRequestSchema.safeParse({ locale: 'en', timezone: 'Mars/Olympus_Mons' }).success,
    ).toBe(false);
  });

  it('ignores an injected auth id rather than trusting it', () => {
    // The Supabase auth id is read from the verified JWT, never from the body.
    // Zod strips unknown keys, so a caller cannot smuggle one in.
    const parsed = bootstrapRequestSchema.parse({
      locale: 'en',
      timezone: 'UTC',
      authUserId: '00000000-0000-0000-0000-000000000000',
    });
    expect(parsed).not.toHaveProperty('authUserId');
  });
});

describe('userSettingsUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(userSettingsUpdateSchema.safeParse({ incognito: true }).success).toBe(true);
  });

  it('does not accept gender — it is immutable once the profile is complete', () => {
    const parsed = userSettingsUpdateSchema.parse({ locale: 'en', gender: 'male' });
    expect(parsed).not.toHaveProperty('gender');
  });

  it('does not accept dateOfBirth', () => {
    const parsed = userSettingsUpdateSchema.parse({ dateOfBirth: '1990-01-01' });
    expect(parsed).not.toHaveProperty('dateOfBirth');
  });
});

describe('phoneE164Schema', () => {
  it.each(['+923001234567', '+447700900123', '+12025550143'])('accepts %s', (n) => {
    expect(phoneE164Schema.safeParse(n).success).toBe(true);
  });

  it.each(['03001234567', '+0300123456', '923001234567', '+1 202 555 0143', ''])(
    'rejects %s',
    (n) => {
      expect(phoneE164Schema.safeParse(n).success).toBe(false);
    },
  );
});

describe('referenceCodeSchema', () => {
  it('accepts lower_snake_case codes', () => {
    expect(referenceCodeSchema.safeParse('edu_bachelors').success).toBe(true);
  });

  it('rejects display strings', () => {
    // Storing "Bachelor's Degree" would make the field untranslatable and break
    // filtering across languages (README §8 rule 2).
    expect(referenceCodeSchema.safeParse("Bachelor's Degree").success).toBe(false);
  });
});

describe('timezoneSchema', () => {
  it.each(['UTC', 'Asia/Karachi', 'Europe/London', 'America/Toronto'])('accepts %s', (tz) => {
    expect(timezoneSchema.safeParse(tz).success).toBe(true);
  });

  it.each([
    ['an abbreviation', 'PKT'],
    ['a plain country name', 'Pakistan'],
    ['an invented zone', 'Not/AZone'],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('rejects %s', (_label, tz) => {
    const result = timezoneSchema.safeParse(tz);
    expect(result.success).toBe(false);
  });

  it('reports a rejection as a validation issue, not an exception', () => {
    // The caller's contract: a bad identifier is ordinary input validation and
    // comes back in `error`, so the API answers 400 rather than 500.
    const result = timezoneSchema.safeParse('PKT');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('IANA timezone');
  });

  /**
   * The regression this schema was changed for.
   *
   * `Intl.DateTimeFormat` throws a RangeError for an unrecognised identifier,
   * and nothing else. Every other exception describes the RUNTIME — a build
   * without full ICU, an allocation failure under load — and reporting it as
   * invalid input tells the caller to fix something that was never wrong while
   * leaving the operator with no signal at all.
   *
   * Stubbing the constructor is the only way to exercise this: a real
   * environment failure cannot be provoked on demand, which is precisely why
   * the old behaviour went unnoticed.
   */
  describe('when Intl itself fails', () => {
    const original = Intl.DateTimeFormat;

    afterEach(() => {
      Intl.DateTimeFormat = original;
    });

    function stubIntl(error: unknown): void {
      Intl.DateTimeFormat = function stub() {
        throw error;
      } as unknown as typeof Intl.DateTimeFormat;
    }

    it('propagates a non-RangeError instead of calling the input invalid', () => {
      stubIntl(new TypeError('ICU data unavailable'));
      // Propagates rather than returning { success: false }: zod does not
      // swallow a throw from inside a refinement, so this reaches the API's
      // error handler and becomes a logged 500.
      expect(() => timezoneSchema.safeParse('Asia/Karachi')).toThrow('ICU data unavailable');
    });

    it('propagates a thrown non-Error value too', () => {
      // Nothing guarantees a throw is an Error. The check must not treat an
      // arbitrary value as "this identifier is invalid".
      stubIntl('something went wrong');
      expect(() => timezoneSchema.safeParse('Asia/Karachi')).toThrow();
    });

    it('still rejects, without throwing, when the error IS a RangeError', () => {
      // The other half of the same decision: the spec's signal for a bad
      // identifier must stay ordinary validation.
      stubIntl(new RangeError('Invalid time zone specified: PKT'));
      const result = timezoneSchema.safeParse('PKT');
      expect(result.success).toBe(false);
    });
  });
});

describe('locale constants', () => {
  it('ships English only', () => {
    expect([...LOCALES]).toEqual(['en']);
  });

  it('defaults to English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect([...LOCALES]).toContain(DEFAULT_LOCALE);
  });

  it('does not treat a removed locale as supported', () => {
    // Urdu and Arabic were both in scope earlier and were removed. Neither may
    // linger as a half-supported locale that resolves to a missing catalog.
    expect([...LOCALES]).not.toContain('ur');
    expect([...LOCALES]).not.toContain('ar');
  });
});

describe('reference types', () => {
  it('covers the 22 types in the OpenAPI contract', () => {
    expect(REFERENCE_TYPES).toHaveLength(22);
  });

  it('has no duplicates', () => {
    expect(new Set(REFERENCE_TYPES).size).toBe(REFERENCE_TYPES.length);
  });
});

describe('free plan entitlements', () => {
  it('allows 5 interests a day', () => {
    expect(FREE_PLAN_ENTITLEMENTS.daily_interests).toBe(5);
  });

  it('gates the premium capabilities off', () => {
    expect(FREE_PLAN_ENTITLEMENTS.advanced_filters).toBe(false);
    expect(FREE_PLAN_ENTITLEMENTS.who_viewed_me).toBe(false);
    expect(FREE_PLAN_ENTITLEMENTS.incognito).toBe(false);
  });
});
