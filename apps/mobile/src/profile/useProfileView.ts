import { ageFromDateOfBirth, type OwnProfile, type ReferenceType } from '@nikahmate/domain';
import type { Ionicons } from '@expo/vector-icons';
import { useLocale } from '../i18n/LocaleProvider';
import { useReference } from '../reference/useReference';
import type { Highlight } from './ProfileHighlights';

/**
 * Turns a profile record into something a person reads.
 *
 * THIS IS THE WHOLE REDESIGN, IN ONE PLACE. The old screen was a form because
 * it rendered the record's shape: a field became a label and a value, and
 * thirty-odd fields became thirty-odd rows. This hook decides instead what is
 * worth saying, in what order, and which four facts earn the top of the page —
 * so the screens below it compose sections rather than enumerate columns.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - **Nothing from `sensitive`.** Phone, email, employer and exact workplace
 *     live behind an explicit grant. A presentation layer that touched them
 *     would be the easiest place in the app to leak them, and it does not read
 *     them at all — not even for the owner's own screen, where it would be
 *     permitted, because the habit is what protects the other screens.
 *   - **Never the date of birth**, only the age derived from it.
 *   - **Never invents a value.** A missing fact yields `null` and the caller
 *     drops it. "Not added yet" repeated down a page is how a profile someone
 *     worked on comes to look abandoned.
 *
 * HOOK ORDER IS FIXED. Every `useReference` call below runs on every render,
 * unconditionally and in the same order, because that is what React requires.
 * They are cached per type for the session, so a screen asking for fourteen
 * lists costs fourteen cache reads and at most one round trip each.
 */

export interface ChipFact {
  key: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** `brand` for the one fact in a group that carries the most weight. */
  tone?: 'neutral' | 'brand' | 'accent';
}

export interface ProfileSectionView {
  key: 'faith' | 'marriage' | 'work' | 'lifestyle';
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  facts: ChipFact[];
  /** Free prose belonging to the section — family background, institution. */
  note: string | null;
}

export interface ProfileView {
  displayName: string | null;
  /** "27 · Pakistan", assembled here so the hero renders a string. */
  meta: string | null;
  /** One line under the name. Profession, else education, else nothing. */
  tagline: string | null;
  aboutTitle: string;
  aboutText: string | null;
  lookingFor: string | null;
  highlights: Highlight[];
  sections: ProfileSectionView[];
}

/** Resolves one code to its label. Returns null for a null code. */
function labelOf(
  items: ReadonlyArray<{ code: string; label: string }>,
  code: string | null,
): string | null {
  if (!code) return null;
  // Falls back to the raw code rather than to null: a code with no reference
  // row is a data problem worth seeing on screen, not worth hiding.
  return items.find((item) => item.code === code)?.label ?? code;
}

/** Resolves a list of codes, dropping nothing and keeping the stored order. */
function labelsOf(
  items: ReadonlyArray<{ code: string; label: string }>,
  codes: readonly string[],
): string[] {
  return codes.map((code) => items.find((item) => item.code === code)?.label ?? code);
}

/** `useReference` returns a changing object; only `items` is needed here. */
function useItems(type: ReferenceType): ReadonlyArray<{ code: string; label: string }> {
  return useReference(type).items;
}

export function useProfileView(profile: OwnProfile): ProfileView {
  const { t } = useLocale();

  const countries = useItems('country');
  const languages = useItems('language');
  const maritalStatuses = useItems('marital_status');
  const practices = useItems('religious_practice');
  const sects = useItems('sect');
  const prayers = useItems('prayer_frequency');
  const qurans = useItems('quran_level');
  const dress = useItems('dress_practice');
  const educations = useItems('education_level');
  const fields = useItems('field_of_study');
  const professions = useItems('profession');
  const industries = useItems('industry');
  const timelines = useItems('marriage_timeline');
  const relocations = useItems('relocation_option');
  const hobbies = useItems('hobby');
  const lifestyles = useItems('lifestyle_attribute');
  const traits = useItems('personality_trait');
  const diets = useItems('diet');
  const smokings = useItems('smoking');

  const age = profile.dateOfBirth ? ageFromDateOfBirth(profile.dateOfBirth) : null;
  const country = labelOf(countries, profile.location?.countryCode ?? null);
  const city = profile.location?.cityName ?? null;
  const profession = labelOf(professions, profile.professionCode);
  const education = labelOf(educations, profile.educationLevelCode);
  const sect = labelOf(sects, profile.sectCode);
  const practice = labelOf(practices, profile.religiousPracticeCode);

  // "27 · Lahore, Pakistan" — city only when the member chose city precision,
  // which `location.cityName` already encodes by being null otherwise.
  const place = [city, country].filter((part): part is string => Boolean(part)).join(', ');
  const meta =
    [age !== null ? String(age) : null, place || null]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || null;

  const highlights: Highlight[] = [
    {
      key: 'education',
      icon: 'school-outline',
      value: education,
      caption: t('profile.display.education'),
    },
    {
      key: 'profession',
      icon: 'briefcase-outline',
      value: profession,
      caption: t('profile.display.work'),
    },
    {
      key: 'place',
      icon: 'location-outline',
      value: place || null,
      caption: t('profile.display.livesIn'),
    },
    {
      key: 'faith',
      icon: 'moon-outline',
      // Sect is the more specific fact and the one people look for; practice
      // already appears as a chip in the Faith section below, so showing it
      // here as well would spend a tile on a repeat.
      value: sect ?? practice,
      caption: t('profile.display.faith'),
    },
  ];

  const faith: ChipFact[] = [];
  if (practice) faith.push({ key: 'practice', label: practice, icon: 'moon', tone: 'brand' });
  if (sect) faith.push({ key: 'sect', label: sect });
  if (profile.prayerFrequencyCode) {
    const prayer = labelOf(prayers, profile.prayerFrequencyCode);
    if (prayer) faith.push({ key: 'prayer', label: prayer, icon: 'time-outline' });
  }
  if (profile.quranLevelCode) {
    const quran = labelOf(qurans, profile.quranLevelCode);
    if (quran) faith.push({ key: 'quran', label: quran, icon: 'book-outline' });
  }
  if (profile.dressPracticeCode) {
    const value = labelOf(dress, profile.dressPracticeCode);
    if (value) faith.push({ key: 'dress', label: value, icon: 'shirt-outline' });
  }

  const marriage: ChipFact[] = [];
  const maritalStatus = labelOf(maritalStatuses, profile.maritalStatusCode);
  if (maritalStatus) {
    marriage.push({ key: 'marital', label: maritalStatus, icon: 'heart-outline', tone: 'brand' });
  }
  if (profile.hasChildren !== null) {
    // `childrenCount` says more than "Yes" when it is there, and "No children"
    // is a sentence rather than an answer to an unseen question.
    const children =
      profile.hasChildren && profile.childrenCount
        ? t('profile.display.childrenCount').replace('{{count}}', String(profile.childrenCount))
        : profile.hasChildren
          ? t('profile.display.hasChildren')
          : t('profile.display.noChildren');
    marriage.push({ key: 'children', label: children, icon: 'people-outline' });
  }
  if (profile.marriageTimelineCode) {
    const timeline = labelOf(timelines, profile.marriageTimelineCode);
    if (timeline) marriage.push({ key: 'timeline', label: timeline, icon: 'calendar-outline' });
  }
  if (profile.relocationWillingnessCode) {
    const relocation = labelOf(relocations, profile.relocationWillingnessCode);
    if (relocation)
      marriage.push({ key: 'relocation', label: relocation, icon: 'airplane-outline' });
  }

  const work: ChipFact[] = [];
  if (education) work.push({ key: 'education', label: education, icon: 'school', tone: 'brand' });
  if (profile.fieldOfStudyCode) {
    const field = labelOf(fields, profile.fieldOfStudyCode);
    if (field) work.push({ key: 'field', label: field, icon: 'library-outline' });
  }
  if (profession) work.push({ key: 'profession', label: profession, icon: 'briefcase' });
  if (profile.industryCode) {
    const industry = labelOf(industries, profile.industryCode);
    if (industry) work.push({ key: 'industry', label: industry, icon: 'business-outline' });
  }

  const lifestyle: ChipFact[] = [
    ...labelsOf(languages, profile.languages).map((label, i) => ({
      key: `language-${i}`,
      label,
      icon: 'chatbubble-ellipses-outline' as const,
    })),
    ...labelsOf(hobbies, profile.hobbies).map((label, i) => ({
      key: `hobby-${i}`,
      label,
    })),
    ...labelsOf(lifestyles, profile.lifestyleAttributes).map((label, i) => ({
      key: `lifestyle-${i}`,
      label,
    })),
    ...labelsOf(traits, profile.personalityTraits).map((label, i) => ({
      key: `trait-${i}`,
      label,
    })),
  ];
  if (profile.dietCode) {
    const diet = labelOf(diets, profile.dietCode);
    if (diet) lifestyle.push({ key: 'diet', label: diet, icon: 'restaurant-outline' });
  }
  if (profile.smokingCode) {
    const smoking = labelOf(smokings, profile.smokingCode);
    if (smoking) lifestyle.push({ key: 'smoking', label: smoking });
  }

  // Typed as the element rather than the array, so `key` and `icon` narrow to
  // their literal unions instead of widening to `string` inside the literal.
  const allSections: ProfileSectionView[] = [
    {
      key: 'faith',
      title: t('profile.display.faithTitle'),
      subtitle: t('profile.display.faithSubtitle'),
      icon: 'moon',
      facts: faith,
      note: profile.familyBackground,
    },
    {
      key: 'marriage',
      title: t('profile.display.marriageTitle'),
      subtitle: t('profile.display.marriageSubtitle'),
      icon: 'heart',
      facts: marriage,
      note: null,
    },
    {
      key: 'work',
      title: t('profile.display.workTitle'),
      subtitle: t('profile.display.workSubtitle'),
      icon: 'school',
      facts: work,
      note: profile.institution,
    },
    {
      key: 'lifestyle',
      title: t('profile.display.lifestyleTitle'),
      subtitle: t('profile.display.lifestyleSubtitle'),
      icon: 'sparkles',
      facts: lifestyle,
      note: null,
    },
  ];

  // An empty section says "this person told us nothing", which is both unkind
  // and useless. The owner is prompted to fill gaps by the completion card,
  // which is the right place for it.
  const sections = allSections.filter(
    (section) => section.facts.length > 0 || section.note !== null,
  );

  const firstName = (profile.displayName ?? '').trim().split(/\s+/)[0] ?? '';

  return {
    displayName: profile.displayName,
    meta,
    tagline: profession ?? education ?? null,
    aboutTitle: firstName
      ? t('profile.display.aboutName').replace('{{name}}', firstName)
      : t('profile.display.about'),
    aboutText: profile.aboutMe,
    lookingFor: profile.lookingFor,
    highlights,
    sections,
  };
}
