import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { ReferenceSelect } from '../../src/components/ReferenceSelect';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { nextRoute } from '../../src/onboarding/steps';
import { MIN_ABOUT_ME_LENGTH } from '@nikahmate/domain';
import { validateSelectedOne, type ValidationKey } from '../../src/lib/validation';

/**
 * Step 4 — marriage and lifestyle.
 *
 * `maritalStatus` and `aboutMe` are required because review requires them, and
 * the database enforces both through `profiles_complete_for_review`. Asking
 * for them here, with the minimum length stated up front, means the refusal
 * happens next to the field rather than at submission.
 *
 * Children questions appear only once someone says they have children — a
 * contradictory answer is rejected by a CHECK constraint, so the form should
 * not invite one.
 */
export default function LifestyleScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { profile, saving, error, fieldErrors, save } = useOnboardingDraft();

  const [maritalStatus, setMaritalStatus] = useState<string | null>(null);
  const [hasChildren, setHasChildren] = useState<string | null>(null);
  const [childrenCount, setChildrenCount] = useState('');
  const [marriageTimeline, setMarriageTimeline] = useState<string | null>(null);
  const [relocation, setRelocation] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [hobbies, setHobbies] = useState<string[]>([]);
  const [diet, setDiet] = useState<string | null>(null);
  const [smoking, setSmoking] = useState<string | null>(null);
  const [aboutMe, setAboutMe] = useState('');
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});

  useEffect(() => {
    if (!profile) return;
    setMaritalStatus(profile.maritalStatusCode);
    setHasChildren(profile.hasChildren === null ? null : profile.hasChildren ? 'yes' : 'no');
    setChildrenCount(profile.childrenCount === null ? '' : String(profile.childrenCount));
    setMarriageTimeline(profile.marriageTimelineCode);
    setRelocation(profile.relocationWillingnessCode);
    setLanguages(profile.languages);
    setHobbies(profile.hobbies);
    setDiet(profile.dietCode);
    setSmoking(profile.smokingCode);
    setAboutMe(profile.aboutMe ?? '');
  }, [profile]);

  const aboutMeTooShort = aboutMe.trim().length > 0 && aboutMe.trim().length < MIN_ABOUT_ME_LENGTH;

  const onNext = async () => {
    const next: Record<string, ValidationKey> = {
      maritalStatusCode: validateSelectedOne(maritalStatus),
      aboutMe:
        aboutMe.trim().length === 0
          ? 'validation.required'
          : aboutMeTooShort
            ? 'validation.required'
            : undefined,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    const childrenYes = hasChildren === 'yes';
    const ok = await save({
      maritalStatusCode: maritalStatus,
      hasChildren: hasChildren === null ? null : childrenYes,
      // Never sent alongside "no": the CHECK constraint refuses that pair, and
      // the form should not produce something the schema rejects.
      childrenCount: childrenYes && childrenCount ? Number(childrenCount) : null,
      marriageTimelineCode: marriageTimeline,
      relocationWillingnessCode: relocation,
      languages,
      hobbies,
      dietCode: diet,
      smokingCode: smoking,
      aboutMe: aboutMe.trim(),
    });
    if (!ok) return;

    const route = nextRoute('lifestyle');
    if (route) router.push(route);
  };

  return (
    <OnboardingStep
      stepKey="lifestyle"
      subtitle={t('onboarding.lifestyleSubtitle')}
      onNext={() => void onNext()}
      onBack={() => router.back()}
      saving={saving}
      error={error}
    >
      <ReferenceSelect
        label={t('profile.maritalStatus')}
        type="marital_status"
        value={maritalStatus}
        onChange={(next) => setMaritalStatus(next)}
        error={errors.maritalStatusCode ? t(errors.maritalStatusCode) : undefined}
        testID="lifestyle-marital"
      />

      <ChoiceGroup
        label={t('profile.hasChildren')}
        choices={[
          { value: 'no', label: t('common.no') },
          { value: 'yes', label: t('common.yes') },
        ]}
        value={hasChildren}
        onChange={setHasChildren}
        testID="lifestyle-has-children"
      />

      {hasChildren === 'yes' ? (
        <TextField
          label={t('profile.childrenCount')}
          value={childrenCount}
          onChangeText={setChildrenCount}
          keyboardType="number-pad"
          maxLength={2}
          testID="lifestyle-children-count"
        />
      ) : null}

      <ReferenceSelect
        label={t('profile.marriageTimeline')}
        type="marriage_timeline"
        value={marriageTimeline}
        onChange={(next) => setMarriageTimeline(next)}
        placeholder={t('common.optional')}
        testID="lifestyle-timeline"
      />

      <ReferenceSelect
        label={t('profile.relocation')}
        type="relocation_option"
        value={relocation}
        onChange={(next) => setRelocation(next)}
        placeholder={t('common.optional')}
        testID="lifestyle-relocation"
      />

      <ReferenceSelect
        label={t('profile.languages')}
        type="language"
        value={languages}
        onChange={(next) => setLanguages(next)}
        multiple
        placeholder={t('common.optional')}
        testID="lifestyle-languages"
      />

      <ReferenceSelect
        label={t('profile.hobbies')}
        type="hobby"
        value={hobbies}
        onChange={(next) => setHobbies(next)}
        multiple
        placeholder={t('common.optional')}
        testID="lifestyle-hobbies"
      />

      <ReferenceSelect
        label={t('profile.diet')}
        type="diet"
        value={diet}
        onChange={(next) => setDiet(next)}
        placeholder={t('common.optional')}
        testID="lifestyle-diet"
      />

      <ReferenceSelect
        label={t('profile.smoking')}
        type="smoking"
        value={smoking}
        onChange={(next) => setSmoking(next)}
        placeholder={t('common.optional')}
        testID="lifestyle-smoking"
      />

      <TextField
        label={t('profile.aboutMe')}
        value={aboutMe}
        onChangeText={setAboutMe}
        hint={
          aboutMeTooShort
            ? `${aboutMe.trim().length}/${MIN_ABOUT_ME_LENGTH}`
            : t('profile.aboutMeHint')
        }
        error={errors.aboutMe ? t(errors.aboutMe) : fieldErrors?.aboutMe}
        multiline
        maxLength={2000}
        autoCapitalize="sentences"
        testID="lifestyle-about"
      />
    </OnboardingStep>
  );
}
