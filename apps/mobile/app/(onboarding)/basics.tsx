import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { GENDERS, type Gender } from '@nikahmate/domain';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { ReferenceSelect } from '../../src/components/ReferenceSelect';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { nextRoute } from '../../src/onboarding/steps';
import { useTheme } from '../../src/theme/ThemeProvider';
import {
  validateDateOfBirth,
  validateDisplayName,
  validateRequired,
  validateSelectedOne,
  type ValidationKey,
} from '../../src/lib/validation';

/**
 * Step 1 — who you are.
 *
 * Two fields carry rules that outlive this screen:
 *
 *   - **Gender is immutable** once the profile is complete. Discovery,
 *     matching and the whole preference model assume it cannot change, and a
 *     database trigger enforces it. The screen says so before the choice is
 *     made, and locks the control afterwards, rather than refusing the change
 *     six months later.
 *   - **Date of birth gates the product.** Under-18 is refused here, again at
 *     the API, and again by a trigger. This check is the courtesy; the trigger
 *     is the control.
 *
 * Only the age derived from the date is ever shown to another member.
 */
export default function BasicsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { profile, loading, saving, error, fieldErrors, save } = useOnboardingDraft();

  const [displayName, setDisplayName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [cityName, setCityName] = useState('');
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});

  // Seeded once the server responds, so reopening onboarding resumes rather
  // than asking the same questions again.
  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.displayName ?? '');
    setDateOfBirth(profile.dateOfBirth ?? '');
    setGender(profile.gender ?? null);
    setCountryCode(profile.location?.countryCode ?? null);
    setCityName(profile.location?.cityName ?? '');
  }, [profile]);

  // Immutable once the profile has left draft — matching what the database
  // will allow, so the UI never offers something the server would refuse.
  const genderLocked = Boolean(profile?.gender) && profile?.reviewStatus !== 'draft';

  const onNext = async () => {
    const next = {
      displayName: validateDisplayName(displayName),
      dateOfBirth: validateDateOfBirth(dateOfBirth),
      gender: validateSelectedOne(gender),
      countryCode: validateRequired(countryCode),
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    const ok = await save({
      displayName: displayName.trim(),
      dateOfBirth,
      gender: gender as Gender,
      location: {
        countryCode: countryCode as string,
        cityName: cityName.trim() || null,
      },
    });
    if (!ok) return;

    const route = nextRoute('basics');
    if (route) router.push(route);
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  return (
    <OnboardingStep
      stepKey="basics"
      subtitle={t('onboarding.basicsSubtitle')}
      onNext={() => void onNext()}
      onBack={undefined}
      saving={saving}
      error={error}
    >
      <TextField
        label={t('profile.displayName')}
        value={displayName}
        onChangeText={setDisplayName}
        hint={t('profile.displayNameHint')}
        error={errors.displayName ? t(errors.displayName) : fieldErrors?.displayName}
        autoCapitalize="words"
        autoComplete="name"
        maxLength={80}
        returnKeyType="next"
        testID="basics-name"
      />

      <TextField
        label={t('profile.dateOfBirth')}
        value={dateOfBirth}
        onChangeText={setDateOfBirth}
        hint={t('profile.dateOfBirthHint')}
        error={errors.dateOfBirth ? t(errors.dateOfBirth) : fieldErrors?.dateOfBirth}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        returnKeyType="next"
        testID="basics-dob"
      />

      <ChoiceGroup
        label={t('profile.gender')}
        hint={genderLocked ? t('profile.genderLocked') : t('profile.genderHint')}
        error={errors.gender ? t(errors.gender) : undefined}
        choices={GENDERS.map((value) => ({ value, label: t(`profile.${value}`) }))}
        value={gender}
        onChange={(next) => setGender(next as Gender)}
        disabled={genderLocked}
        testID="basics-gender"
      />

      <ReferenceSelect
        label={t('profile.country')}
        type="country"
        value={countryCode}
        onChange={(next) => setCountryCode(next)}
        error={errors.countryCode ? t(errors.countryCode) : undefined}
        testID="basics-country"
      />

      <TextField
        label={t('profile.city')}
        value={cityName}
        onChangeText={setCityName}
        autoCapitalize="words"
        maxLength={120}
        testID="basics-city"
      />
    </OnboardingStep>
  );
}
