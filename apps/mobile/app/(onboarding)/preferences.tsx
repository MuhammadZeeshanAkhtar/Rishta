import { useRouter } from 'expo-router';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { nextRoute } from '../../src/onboarding/steps';
import { usePreferencesForm } from '../../src/profile/PreferencesForm';

/**
 * Step 5 — what you are looking for.
 *
 * Everything is optional, and the subtitle says so: these are preferences, not
 * a filter on people. An empty field means "open to any", which is the right
 * default for someone who has not thought about it yet.
 *
 * The fields come from `usePreferencesForm`, shared with the edit screen, so
 * the two cannot drift — a duplicated `excludeUnstatedSect` default would be
 * an A2 violation nobody notices until people start disappearing from search.
 */
export default function PreferencesScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { preferences, saving, error, savePreferences } = useOnboardingDraft();
  const { fields, collect } = usePreferencesForm(preferences);

  const onNext = async () => {
    const patch = collect();
    if (!patch) return;
    if (!(await savePreferences(patch))) return;

    const route = nextRoute('preferences');
    if (route) router.push(route);
  };

  return (
    <OnboardingStep
      stepKey="preferences"
      subtitle={t('onboarding.preferencesSubtitle')}
      onNext={() => void onNext()}
      onBack={() => router.back()}
      saving={saving}
      error={error}
    >
      {fields}
    </OnboardingStep>
  );
}
