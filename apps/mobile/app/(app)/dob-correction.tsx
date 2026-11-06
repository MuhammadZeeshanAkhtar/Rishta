import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_DOB_CORRECTION_REASON, type DobCorrection } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { SectionCard } from '../../src/components/SectionCard';
import { StatusBadge } from '../../src/components/StatusBadge';
import { TextField } from '../../src/components/TextField';
import {
  correctionState,
  validateCorrection,
  type CorrectionErrors,
} from '../../src/account/dobCorrection';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Date of birth — the member's correction request (review B6, decision 4).
 *
 * THE DATE CANNOT BE EDITED HERE. Once a profile is complete the date is
 * locked: the API answers a direct change with 409 and the database refuses
 * it for members (0029). The only route is a request support verifies (an ID
 * check, outside the app) and decides, with the decision audited. This screen
 * shows the current date read-only, files a request, and shows where it
 * stands — including support's reason when one was declined.
 *
 * Before the profile is complete the date is still the member's to edit in
 * the profile itself, and the API refuses a correction request (409); the
 * screen says so instead of offering a form that cannot succeed.
 */
export default function DobCorrectionScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { me } = useSession();

  const [currentDob, setCurrentDob] = useState<string | null>(null);
  const [items, setItems] = useState<DobCorrection[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestedDob, setRequestedDob] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<CorrectionErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, list] = await Promise.all([
        getClient().getProfile(),
        getClient().listDobCorrections(),
      ]);
      setCurrentDob(profile.dateOfBirth ?? null);
      setItems(list.items);
      setError(null);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const locked = me?.profileCompleted === true;
  const state = correctionState(items);

  const submit = async () => {
    const next = validateCorrection({ requestedDob, reason, currentDob });
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await getClient().requestDobCorrection({
        requestedDob: requestedDob.trim(),
        reason: reason.trim(),
      });
      setRequestedDob('');
      setReason('');
      setNotice(t('dobCorrection.submitted'));
      await load();
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.inner}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t('dobCorrection.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          {t('dobCorrection.subtitle')}
        </Text>

        {error ? <Banner tone="error" message={error} /> : null}
        {notice ? <Banner tone="success" message={notice} /> : null}

        {loading ? (
          <ActivityIndicator color={theme.colors.brand} />
        ) : (
          <>
            <SectionCard title={t('dobCorrection.currentTitle')} icon="lock-closed-outline">
              <Text style={[styles.value, { color: theme.colors.text }]} testID="dob-current">
                {currentDob ?? t('dobCorrection.notSet')}
              </Text>
              <Text style={[styles.caption, { color: theme.colors.textMuted }]}>
                {locked ? t('dobCorrection.lockedExplains') : t('dobCorrection.editInProfile')}
              </Text>
            </SectionCard>

            {state.lastDecided ? (
              <SectionCard
                title={t('dobCorrection.lastDecision')}
                icon="document-text-outline"
                trailing={
                  <StatusBadge
                    label={t(`dobCorrection.status.${state.lastDecided.status}`)}
                    tone={state.lastDecided.status === 'approved' ? 'success' : 'danger'}
                  />
                }
                testID="dob-last-decision"
              >
                <Text style={[styles.caption, { color: theme.colors.textMuted }]}>
                  {t('dobCorrection.requested').replace('{{date}}', state.lastDecided.requestedDob)}
                </Text>
                {state.lastDecided.status === 'rejected' && state.lastDecided.decisionNote ? (
                  <Text style={[styles.body, { color: theme.colors.text }]}>
                    {t('dobCorrection.reasonFromSupport').replace(
                      '{{reason}}',
                      state.lastDecided.decisionNote,
                    )}
                  </Text>
                ) : null}
              </SectionCard>
            ) : null}

            {state.open ? (
              <SectionCard
                title={t('dobCorrection.openTitle')}
                icon="time-outline"
                trailing={<StatusBadge label={t('dobCorrection.status.pending')} tone="warm" />}
                testID="dob-open-request"
              >
                <Text style={[styles.body, { color: theme.colors.text }]}>
                  {t('dobCorrection.requested').replace('{{date}}', state.open.requestedDob)}
                </Text>
                <Text style={[styles.caption, { color: theme.colors.textMuted }]}>
                  {t('dobCorrection.openExplains')}
                </Text>
              </SectionCard>
            ) : null}

            {locked && state.canRequest ? (
              <SectionCard
                title={t('dobCorrection.formTitle')}
                icon="create-outline"
                testID="dob-form"
              >
                <TextField
                  label={t('dobCorrection.requestedDob')}
                  hint={t('profile.dateOfBirthHint')}
                  value={requestedDob}
                  onChangeText={setRequestedDob}
                  placeholder="YYYY-MM-DD"
                  keyboardType="numbers-and-punctuation"
                  error={errors.requestedDob ? t(errors.requestedDob) : undefined}
                  testID="dob-requested"
                />
                <TextField
                  label={t('dobCorrection.reason')}
                  hint={t('dobCorrection.reasonHint')}
                  value={reason}
                  onChangeText={setReason}
                  multiline
                  maxLength={MAX_DOB_CORRECTION_REASON}
                  error={errors.reason ? t(errors.reason) : undefined}
                  testID="dob-reason"
                />
                <Button
                  label={t('dobCorrection.submit')}
                  onPress={() => void submit()}
                  loading={submitting}
                  testID="dob-submit"
                />
              </SectionCard>
            ) : null}

            {!locked ? (
              <Button
                label={t('profile.editProfile')}
                variant="secondary"
                onPress={() => router.push('/(onboarding)/basics')}
              />
            ) : null}
          </>
        )}

        <Button label={t('common.back')} variant="ghost" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display },
  subtitle: { ...typography.body },
  value: { ...typography.title },
  body: { ...typography.body },
  caption: { ...typography.caption },
});
