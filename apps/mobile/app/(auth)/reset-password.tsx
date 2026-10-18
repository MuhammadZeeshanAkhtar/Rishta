import { useState } from 'react';
import { useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { Logo } from '../../src/components/Logo';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { describeError } from '../../src/lib/errors';
import {
  validatePassword,
  validatePasswordConfirmation,
  type ValidationKey,
} from '../../src/lib/validation';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Sets a new password, after a recovery link has been completed.
 *
 * Reachable only with the recovery session that `callback.tsx` established —
 * there is no token in this screen and no "reset with this code" call. Supabase
 * turns the link into a session, and changing a password is then an ordinary
 * authenticated action. We never hold the old password, and never mint one.
 *
 * Signing out afterwards is deliberate. A recovery session is a narrow grant
 * for one job; continuing into the app on it would mean someone who forwarded
 * the email keeps access. Signing in again with the new password is the point.
 */
export default function ResetPasswordScreen() {
  const { t } = useLocale();
  const { updatePassword, signOut, session } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    const next = {
      password: validatePassword(password),
      confirmation: validatePasswordConfirmation(password, confirmation),
    };
    setErrors(next);
    setFormError(null);
    if (next.password || next.confirmation) return;

    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
      // Out of the recovery session, on purpose — see the note above.
      await signOut();
    } catch (error) {
      setFormError(describeError(error, t).message);
    } finally {
      setSubmitting(false);
    }
  };

  // No recovery session means the link was never completed, or has expired.
  // Saying so beats a password form that fails on submit.
  const missingSession = !session && !done;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <Logo size={44} />

          <Text style={[styles.title, { color: theme.colors.text }]}>
            {t('auth.newPasswordTitle')}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {t('auth.newPasswordSubtitle')}
          </Text>

          {done ? <Banner tone="success" message={t('auth.passwordUpdated')} /> : null}
          {formError ? <Banner tone="error" message={formError} /> : null}
          {missingSession ? <Banner tone="error" message={t('auth.resetLinkExpired')} /> : null}

          {!done && !missingSession ? (
            <View style={styles.form}>
              <TextField
                label={t('auth.password')}
                value={password}
                onChangeText={setPassword}
                hint={t('auth.passwordHint')}
                error={errors.password ? t(errors.password) : undefined}
                secureTextEntry
                revealable
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="next"
                testID="reset-new-password"
              />

              <TextField
                label={t('auth.confirmPassword')}
                value={confirmation}
                onChangeText={setConfirmation}
                error={errors.confirmation ? t(errors.confirmation) : undefined}
                secureTextEntry
                revealable
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                testID="reset-confirm-password"
              />

              <Button
                label={t('auth.updatePassword')}
                onPress={() => void submit()}
                loading={submitting}
                testID="reset-submit"
              />
            </View>
          ) : null}

          <Button
            label={t('auth.backToSignIn')}
            variant={done ? 'primary' : 'ghost'}
            onPress={() => router.replace('/(auth)/sign-in')}
            testID="reset-back-to-sign-in"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display, marginTop: spacing.lg },
  subtitle: { ...typography.body, marginBottom: spacing.sm },
  form: { gap: spacing.lg, marginTop: spacing.sm },
});
