import { describe, expect, it } from 'vitest';
import {
  photoReorderSchema,
  preferencesUpdateSchema,
  profileUpdateSchema,
  updatePermissionsSchema,
} from './index';

/**
 * GHSA-mrhx-c7xc-m3w5: below Zod 4.6.6 an oversized array is parsed element by
 * element even when the schema declares `.max()`, and every failing element
 * adds an issue. A 1 MiB request body produced 524,278 issues and about 170 MB
 * of heap per request.
 *
 * From 4.6.6 a declared bound is checked BEFORE the elements. An array with NO
 * bound is still walked in full, so this protection exists only where a request
 * schema declares `.max()` — which is what these tests also pin. A new array in
 * a request schema needs a bound and a line here.
 */

const OVERSIZED = 100_000;
const oversized = (): number[] => Array.from({ length: OVERSIZED }, () => 1);

describe('an oversized array is refused without parsing its elements', () => {
  it.each([
    ['languages', profileUpdateSchema, 'languages'],
    ['relocation countries', profileUpdateSchema, 'relocationTargetCountries'],
    ['hobbies', profileUpdateSchema, 'hobbies'],
    ['lifestyle attributes', profileUpdateSchema, 'lifestyleAttributes'],
    ['personality traits', profileUpdateSchema, 'personalityTraits'],
    ['preferred countries', preferencesUpdateSchema, 'countryCodes'],
    ['preferred languages', preferencesUpdateSchema, 'languageCodes'],
    ['preferred education', preferencesUpdateSchema, 'educationLevelCodes'],
    ['preferred professions', preferencesUpdateSchema, 'professionCodes'],
    ['preferred practice', preferencesUpdateSchema, 'religiousPracticeCodes'],
    ['preferred sects', preferencesUpdateSchema, 'sectCodes'],
    ['preferred marital status', preferencesUpdateSchema, 'maritalStatusCodes'],
    ['preferred timelines', preferencesUpdateSchema, 'marriageTimelineCodes'],
    ['photo order', photoReorderSchema, 'photoIds'],
    ['family permissions', updatePermissionsSchema, 'permissions'],
  ])('%s', (_label, schema, field) => {
    const result = schema.safeParse({ [field]: oversized() });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'too_big', path: [field] });
  });

  it('still reports each bad element in an array within its bound', () => {
    const result = profileUpdateSchema.safeParse({ languages: [1, 2, 3] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['languages', 0],
      ['languages', 1],
      ['languages', 2],
    ]);
  });

  it('still accepts a valid array at its bound', () => {
    const codes = Array.from({ length: 40 }, (_, i) => `code_${i}`);
    expect(profileUpdateSchema.safeParse({ languages: codes }).success).toBe(true);
  });
});
