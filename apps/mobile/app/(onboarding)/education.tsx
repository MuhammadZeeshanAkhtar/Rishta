import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ReferenceSelect } from '../../src/components/ReferenceSelect';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { nextRoute } from '../../src/onboarding/steps';

/**
 * Step 3 — education and work.
 *
 * Nothing here is required. Someone between jobs, or who would rather not name
 * their employer, must still be able to finish onboarding — and the employer
 * name is not collected at all on this screen: it lives in `profile_sensitive`
 * and is revealed only by an explicit grant.
 */
export default function EducationScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { profile, saving, error, save } = useOnboardingDraft();

  const [educationLevel, setEducationLevel] = useState<string | null>(null);
  const [fieldOfStudy, setFieldOfStudy] = useState<string | null>(null);
  const [institution, setInstitution] = useState('');
  const [profession, setProfession] = useState<string | null>(null);
  const [industry, setIndustry] = useState<string | null>(null);
  const [employment, setEmployment] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setEducationLevel(profile.educationLevelCode);
    setFieldOfStudy(profile.fieldOfStudyCode);
    setInstitution(profile.institution ?? '');
    setProfession(profile.professionCode);
    setIndustry(profile.industryCode);
    setEmployment(profile.employmentStatusCode);
  }, [profile]);

  const onNext = async () => {
    const ok = await save({
      educationLevelCode: educationLevel,
      fieldOfStudyCode: fieldOfStudy,
      institution: institution.trim() || null,
      professionCode: profession,
      industryCode: industry,
      employmentStatusCode: employment,
    });
    if (!ok) return;
    const route = nextRoute('education');
    if (route) router.push(route);
  };

  return (
    <OnboardingStep
      stepKey="education"
      subtitle={t('onboarding.educationSubtitle')}
      onNext={() => void onNext()}
      onBack={() => router.back()}
      saving={saving}
      error={error}
    >
      <ReferenceSelect
        label={t('profile.educationLevel')}
        type="education_level"
        value={educationLevel}
        onChange={(next) => setEducationLevel(next)}
        placeholder={t('common.optional')}
        testID="education-level"
      />

      <ReferenceSelect
        label={t('profile.fieldOfStudy')}
        type="field_of_study"
        value={fieldOfStudy}
        onChange={(next) => setFieldOfStudy(next)}
        placeholder={t('common.optional')}
        testID="education-field"
      />

      <TextField
        label={t('profile.institution')}
        value={institution}
        onChangeText={setInstitution}
        autoCapitalize="words"
        maxLength={160}
        testID="education-institution"
      />

      <ReferenceSelect
        label={t('profile.profession')}
        type="profession"
        value={profession}
        onChange={(next) => setProfession(next)}
        placeholder={t('common.optional')}
        testID="education-profession"
      />

      <ReferenceSelect
        label={t('profile.industry')}
        type="industry"
        value={industry}
        onChange={(next) => setIndustry(next)}
        placeholder={t('common.optional')}
        testID="education-industry"
      />

      <ReferenceSelect
        label={t('profile.employmentStatus')}
        type="employment_status"
        value={employment}
        onChange={(next) => setEmployment(next)}
        placeholder={t('common.optional')}
        testID="education-employment"
      />
    </OnboardingStep>
  );
}
