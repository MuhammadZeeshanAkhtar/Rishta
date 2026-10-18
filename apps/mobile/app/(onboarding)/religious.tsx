import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ReferenceSelect } from '../../src/components/ReferenceSelect';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { nextRoute } from '../../src/onboarding/steps';
import { validateSelectedOne, type ValidationKey } from '../../src/lib/validation';

/**
 * Step 2 — faith.
 *
 * Only `religiousPractice` is required, and it is required because review
 * needs it and because it is the single most load-bearing field in matching.
 *
 * **Sect is optional and stays optional.** Leaving it blank means "not
 * stated", and a blank must never hide someone from another member's search —
 * the guard is `partner_preferences.exclude_unstated_sect`, which defaults to
 * false in the schema, the API and the preferences screen (A2). The hint says
 * so, because someone deciding whether to answer deserves to know it costs
 * them nothing.
 */
export default function ReligiousScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { profile, saving, error, save } = useOnboardingDraft();

  const [practice, setPractice] = useState<string | null>(null);
  const [sect, setSect] = useState<string | null>(null);
  const [prayer, setPrayer] = useState<string | null>(null);
  const [quran, setQuran] = useState<string | null>(null);
  const [dress, setDress] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});

  useEffect(() => {
    if (!profile) return;
    setPractice(profile.religiousPracticeCode);
    setSect(profile.sectCode);
    setPrayer(profile.prayerFrequencyCode);
    setQuran(profile.quranLevelCode);
    setDress(profile.dressPracticeCode);
  }, [profile]);

  const onNext = async () => {
    const next = { religiousPracticeCode: validateSelectedOne(practice) };
    setErrors(next);
    if (next.religiousPracticeCode) return;

    const ok = await save({
      religiousPracticeCode: practice,
      sectCode: sect,
      prayerFrequencyCode: prayer,
      quranLevelCode: quran,
      dressPracticeCode: dress,
    });
    if (!ok) return;

    const route = nextRoute('religious');
    if (route) router.push(route);
  };

  return (
    <OnboardingStep
      stepKey="religious"
      subtitle={t('onboarding.religiousSubtitle')}
      onNext={() => void onNext()}
      onBack={() => router.back()}
      saving={saving}
      error={error}
    >
      <ReferenceSelect
        label={t('profile.religiousPractice')}
        type="religious_practice"
        value={practice}
        onChange={(next) => setPractice(next)}
        error={errors.religiousPracticeCode ? t(errors.religiousPracticeCode) : undefined}
        testID="religious-practice"
      />

      <ReferenceSelect
        label={t('profile.sect')}
        type="sect"
        value={sect}
        onChange={(next) => setSect(next)}
        hint={t('profile.sectHint')}
        placeholder={t('common.notStated')}
        testID="religious-sect"
      />

      <ReferenceSelect
        label={t('profile.prayerFrequency')}
        type="prayer_frequency"
        value={prayer}
        onChange={(next) => setPrayer(next)}
        placeholder={t('common.optional')}
        testID="religious-prayer"
      />

      <ReferenceSelect
        label={t('profile.quranLevel')}
        type="quran_level"
        value={quran}
        onChange={(next) => setQuran(next)}
        placeholder={t('common.optional')}
        testID="religious-quran"
      />

      <ReferenceSelect
        label={t('profile.dressPractice')}
        type="dress_practice"
        value={dress}
        onChange={(next) => setDress(next)}
        placeholder={t('common.optional')}
        testID="religious-dress"
      />
    </OnboardingStep>
  );
}
