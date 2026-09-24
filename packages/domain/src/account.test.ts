import { describe, expect, it } from 'vitest';
import {
  MINIMUM_AGE_YEARS,
  ageFromDateOfBirth,
  bootstrapRequestSchema,
  identitySchema,
  meetsMinimumAge,
  userSettingsUpdateSchema,
} from './account.js';
import { isRtl, LOCALES, REFERENCE_TYPES, FREE_PLAN_ENTITLEMENTS } from './constants.js';
import { phoneE164Schema, referenceCodeSchema, timezoneSchema } from './common.js';

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

  it('rejects a lowercase country code', () => {
    expect(identitySchema.safeParse({ ...valid, countryCode: 'pk' }).success).toBe(false);
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
      bootstrapRequestSchema.safeParse({ locale: 'ur', timezone: 'Asia/Karachi' }).success,
    ).toBe(true);
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

  it('rejects a non-IANA value', () => {
    expect(timezoneSchema.safeParse('PKT').success).toBe(false);
  });
});

describe('locale constants', () => {
  it('ships English, Urdu and Arabic in v1', () => {
    expect([...LOCALES]).toEqual(['en', 'ur', 'ar']);
  });

  it('marks Urdu and Arabic as RTL', () => {
    expect(isRtl('ur')).toBe(true);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
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
