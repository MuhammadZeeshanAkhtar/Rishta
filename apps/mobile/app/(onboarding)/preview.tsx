import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Banner } from '../../src/components/Banner';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useOnboardingDraft } from '../../src/onboarding/OnboardingDraft';
import { OnboardingStep } from '../../src/onboarding/OnboardingStep';
import { ONBOARDING_STEPS } from '../../src/onboarding/steps';
import { ProfileSummary } from '../../src/profile/ProfileSummary';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { radius, spacing, typography } from '../../src/theme/tokens';

/**
 * Step 6 — review and submit.
 *
 * Shows exactly what a profile says, using the same component the profile
 * screen uses, so a preview cannot quietly differ from the real thing.
 *
 * Nothing from `profile_sensitive` appears here. A preview that showed a phone
 * number would teach someone their contact details are part of their profile,
 * which is the opposite of true.
 *
 * Submission can still be refused by the server — the completeness rule lives
 * in a CHECK constraint, not in this screen — so a refusal is turned back into
 * a list of steps to revisit rather than a dead end.
 */
export default function PreviewScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { profile, loading, error, reload } = useOnboardingDraft();
  const { refresh } = useSession();

  const [submitting, setSubmitting] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    void getClient()
      .getProfileCompletion()
      .then((c) => setMissing(c.missingRequired))
      .catch(() => setMissing([]));
  }, [profile]);

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await getClient().submitProfile();
      // The session gate decides where to go: it re-reads the account and
      // sends a completed profile on to the app.
      await refresh();
      router.replace('/');
    } catch (err) {
      const described = describeError(err, t);
      setSubmitError(described.message);
      // Named fields become steps to revisit.
      setMissing(Object.keys(described.fields ?? {}));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !profile) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  return (
    <OnboardingStep
      stepKey="preview"
      subtitle={t('onboarding.previewSubtitle')}
      onNext={() => void submit()}
      onBack={() => router.back()}
      nextLabel={t('onboarding.finish')}
      saving={submitting}
      error={submitError ?? error}
      nextDisabled={missing.length > 0}
    >
      {missing.length > 0 ? (
        <View style={styles.missing}>
          <Banner tone="info" message={t('onboarding.incomplete')} />
          {/* Each missing item is a way back to the step that owns it. */}
          <View style={styles.links}>
            {ONBOARDING_STEPS.filter((s) => s.key !== 'preview').map((step) => (
              <Pressable
                key={step.key}
                onPress={() => router.push(step.route)}
                accessibilityRole="link"
                style={[styles.link, { borderColor: theme.colors.border }]}
              >
                <Text style={[styles.linkText, { color: theme.colors.brand }]}>
                  {t(step.titleKey)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <ProfileSummary profile={profile} />

      <Pressable onPress={() => void reload()} accessibilityRole="button" style={styles.refresh}>
        <Text style={[styles.linkText, { color: theme.colors.textMuted }]}>
          {t('common.retry')}
        </Text>
      </Pressable>
    </OnboardingStep>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missing: { gap: spacing.md },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  link: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  linkText: { ...typography.caption, fontWeight: '600' },
  refresh: { alignSelf: 'center', padding: spacing.md },
});
