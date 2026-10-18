import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GENDERS, MIN_ABOUT_ME_LENGTH, type OwnProfile } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { ReferenceSelect } from '../../src/components/ReferenceSelect';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { validateDisplayName, type ValidationKey } from '../../src/lib/validation';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Edit profile.
 *
 * What this screen deliberately does NOT offer:
 *
 *   - **Gender**, once the profile is complete. The control is shown but
 *     disabled, with the reason stated, because a field that silently
 *     disappears is more confusing than one that explains itself. A database
 *     trigger refuses the change regardless of what the client sends.
 *   - **Date of birth**, for the same reason in the other direction: it is
 *     identity, it gates the product, and changing it is a support matter
 *     rather than a form field.
 *   - **Review status and completion**, which are the server's.
 *
 * Ownership is never asserted by this screen. The PATCH goes to `/me/profile`,
 * which resolves the caller from the verified JWT; there is no user id in the
 * request for a client to tamper with.
 */
export default function EditProfileScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});

  const [displayName, setDisplayName] = useState('');
  const [aboutMe, setAboutMe] = useState('');
  const [practice, setPractice] = useState<string | null>(null);
  const [sect, setSect] = useState<string | null>(null);
  const [maritalStatus, setMaritalStatus] = useState<string | null>(null);
  const [education, setEducation] = useState<string | null>(null);
  const [profession, setProfession] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [hobbies, setHobbies] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const next = await getClient().getProfile();
        setProfile(next);
        setDisplayName(next.displayName ?? '');
        setAboutMe(next.aboutMe ?? '');
        setPractice(next.religiousPracticeCode);
        setSect(next.sectCode);
        setMaritalStatus(next.maritalStatusCode);
        setEducation(next.educationLevelCode);
        setProfession(next.professionCode);
        setLanguages(next.languages);
        setHobbies(next.hobbies);
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const genderLocked = Boolean(profile?.gender) && profile?.reviewStatus !== 'draft';

  const submit = async () => {
    const next: Record<string, ValidationKey> = {
      displayName: validateDisplayName(displayName),
      aboutMe:
        aboutMe.trim().length > 0 && aboutMe.trim().length < MIN_ABOUT_ME_LENGTH
          ? 'validation.required'
          : undefined,
    };
    setErrors(next);
    setSaved(false);
    if (Object.values(next).some(Boolean)) return;

    setSaving(true);
    setError(null);
    try {
      setProfile(
        await getClient().updateProfile({
          displayName: displayName.trim(),
          aboutMe: aboutMe.trim() || null,
          religiousPracticeCode: practice,
          sectCode: sect,
          maritalStatusCode: maritalStatus,
          educationLevelCode: education,
          professionCode: profession,
          languages,
          hobbies,
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {t('profile.editProfile')}
          </Text>

          {error ? <Banner tone="error" message={error} /> : null}
          {saved ? <Banner tone="success" message={t('onboarding.savedDraft')} /> : null}

          <TextField
            label={t('profile.displayName')}
            value={displayName}
            onChangeText={setDisplayName}
            error={errors.displayName ? t(errors.displayName) : undefined}
            autoCapitalize="words"
            maxLength={80}
            testID="edit-name"
          />

          <ChoiceGroup
            label={t('profile.gender')}
            hint={genderLocked ? t('profile.genderLocked') : t('profile.genderHint')}
            choices={GENDERS.map((value) => ({ value, label: t(`profile.${value}`) }))}
            value={profile?.gender ?? null}
            onChange={() => undefined}
            disabled={genderLocked}
            testID="edit-gender"
          />

          <TextField
            label={t('profile.aboutMe')}
            value={aboutMe}
            onChangeText={setAboutMe}
            hint={t('profile.aboutMeHint')}
            error={errors.aboutMe ? t(errors.aboutMe) : undefined}
            multiline
            maxLength={2000}
            autoCapitalize="sentences"
            testID="edit-about"
          />

          <ReferenceSelect
            label={t('profile.maritalStatus')}
            type="marital_status"
            value={maritalStatus}
            onChange={(next) => setMaritalStatus(next)}
            testID="edit-marital"
          />

          <ReferenceSelect
            label={t('profile.religiousPractice')}
            type="religious_practice"
            value={practice}
            onChange={(next) => setPractice(next)}
            testID="edit-practice"
          />

          <ReferenceSelect
            label={t('profile.sect')}
            type="sect"
            value={sect}
            onChange={(next) => setSect(next)}
            hint={t('profile.sectHint')}
            placeholder={t('common.notStated')}
            testID="edit-sect"
          />

          <ReferenceSelect
            label={t('profile.educationLevel')}
            type="education_level"
            value={education}
            onChange={(next) => setEducation(next)}
            placeholder={t('common.optional')}
            testID="edit-education"
          />

          <ReferenceSelect
            label={t('profile.profession')}
            type="profession"
            value={profession}
            onChange={(next) => setProfession(next)}
            placeholder={t('common.optional')}
            testID="edit-profession"
          />

          <ReferenceSelect
            label={t('profile.languages')}
            type="language"
            value={languages}
            onChange={(next) => setLanguages(next)}
            multiple
            placeholder={t('common.optional')}
            testID="edit-languages"
          />

          <ReferenceSelect
            label={t('profile.hobbies')}
            type="hobby"
            value={hobbies}
            onChange={(next) => setHobbies(next)}
            multiple
            placeholder={t('common.optional')}
            testID="edit-hobbies"
          />

          <Button
            label={t('common.save')}
            onPress={() => void submit()}
            loading={saving}
            testID="edit-save"
          />
          <Button label={t('common.back')} variant="ghost" onPress={() => router.back()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.lg },
  title: { ...typography.display },
});
