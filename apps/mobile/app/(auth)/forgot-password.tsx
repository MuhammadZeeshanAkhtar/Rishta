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
import { validateEmail, type ValidationKey } from '../../src/lib/validation';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Password reset request.
 *
 * The success message is deliberately the same whether or not the address has
 * an account: "if that address has an account, a link is on its way". Telling
 * the difference would turn this screen into an account-existence oracle, and
 * on a matrimonial platform knowing that someone is registered is itself
 * sensitive.
 */
export default function ForgotPasswordScreen() {
  const { t } = useLocale();
  const { requestPasswordReset } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [error, setError] = useState<ValidationKey>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const next = validateEmail(email);
    setError(next);
    setFormError(null);
    if (next) return;

    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      // Only genuine problems reach here — the client swallows "no such
      // account" precisely so this screen cannot leak it.
      setFormError(describeError(err, t).message);
    } finally {
      setSubmitting(false);
    }
  };

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

          <Text style={[styles.title, { color: theme.colors.text }]}>{t('auth.resetTitle')}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {t('auth.resetSubtitle')}
          </Text>

          {formError ? <Banner tone="error" message={formError} /> : null}
          {sent ? <Banner tone="success" message={t('auth.resetSent')} /> : null}

          {!sent ? (
            <View style={styles.form}>
              <TextField
                label={t('auth.email')}
                value={email}
                onChangeText={setEmail}
                placeholder={t('auth.emailPlaceholder')}
                error={error ? t(error) : undefined}
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={() => void submit()}
                testID="reset-email"
              />
              <Button
                label={t('auth.sendResetLink')}
                onPress={() => void submit()}
                loading={submitting}
                testID="reset-submit"
              />
            </View>
          ) : null}

          <Button
            label={t('auth.backToSignIn')}
            variant="ghost"
            onPress={() => router.replace('/(auth)/sign-in')}
            testID="reset-back"
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
