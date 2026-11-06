import { describe, expect, it } from 'vitest';
import type { PublicProfile } from '@nikahmate/domain';
import { publicProfileView, type LabelOf } from './publicProfileView';

/**
 * Review L4: another member's profile shows exactly what the API returned —
 * nothing withheld is rendered, nothing is invented.
 */

const labels: Record<string, string> = {
  pk: 'Pakistan',
  ms_never_married: 'Never married',
  rel_practising: 'Practising',
  mt_within_year: 'Within a year',
  ro_open: 'Open to relocating',
  ur: 'Urdu',
  en: 'English',
};
const labelOf: LabelOf = (_type, code) => labels[code] ?? code;
const text = { hasChildren: 'Has children', noChildren: 'No children' };

const base: PublicProfile = {
  userId: '11111111-1111-4111-8111-111111111111',
  marriageTimelineCode: null,
  relocationWillingnessCode: null,
  languages: [],
  distanceBand: null,
  verification: { badges: [] },
  photos: [],
  viewerRelationship: 'stranger',
  hiddenFieldCount: 0,
};

describe('publicProfileView', () => {
  it('renders every present field with its label, in a fixed order', () => {
    const view = publicProfileView(
      {
        ...base,
        displayName: 'Aisha',
        age: 27,
        countryCode: 'pk',
        maritalStatusCode: 'ms_never_married',
        religiousPracticeCode: 'rel_practising',
        marriageTimelineCode: 'mt_within_year',
        relocationWillingnessCode: 'ro_open',
        hasChildren: false,
        languages: ['ur', 'en'],
        aboutMe: 'About me text',
      },
      labelOf,
      text,
    );
    expect(view.facts).toEqual([
      { key: 'age', value: '27' },
      { key: 'country', value: 'Pakistan' },
      { key: 'maritalStatus', value: 'Never married' },
      { key: 'religiousPractice', value: 'Practising' },
      { key: 'marriageTimeline', value: 'Within a year' },
      { key: 'relocation', value: 'Open to relocating' },
      { key: 'children', value: 'No children' },
      { key: 'languages', value: 'Urdu, English' },
    ]);
    expect(view.aboutMe).toBe('About me text');
    expect(view.displayName).toBe('Aisha');
  });

  it('renders nothing for withheld (absent) fields and invents no fallback', () => {
    const view = publicProfileView({ ...base, hiddenFieldCount: 4 }, labelOf, text);
    expect(view.facts).toEqual([]);
    expect(view.aboutMe).toBeNull();
    expect(view.displayName).toBeNull();
    expect(view.hiddenFieldCount).toBe(4);
  });

  it('drops present-but-unanswered values (null children, null timeline)', () => {
    const view = publicProfileView({ ...base, hasChildren: null, age: 30 }, labelOf, text);
    expect(view.facts).toEqual([{ key: 'age', value: '30' }]);
  });

  it('shows an unknown code rather than hiding it (a data problem worth seeing)', () => {
    const view = publicProfileView({ ...base, countryCode: 'zz' }, labelOf, text);
    expect(view.facts).toEqual([{ key: 'country', value: 'zz' }]);
  });

  it('carries the relationship the server computed', () => {
    expect(
      publicProfileView({ ...base, viewerRelationship: 'match' }, labelOf, text).relationship,
    ).toBe('match');
  });
});
