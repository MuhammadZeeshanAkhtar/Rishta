import { useState } from 'react';
import { useRouter } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isNikahMateError } from '@nikahmate/api-client';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { Logo } from '../../src/components/Logo';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { describeError } from '../../src/lib/errors';
import { validateEmail, validatePassword, type ValidationKey } from '../../src/lib/validation';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Sign in.
 *
 * Failure handling is most of this screen, because it is most of the real
 * experience: a wrong password, a flat connection, an unverified account and
 * an expired session all look identical to a naive implementation, and each
 * one needs a different next step from the person reading it.
 *
 * An unverified account is routed rather than scolded — the session gate sends
 * them to verification automatically, so signing in "successfully" with an
 * unconfirmed email lands somewhere useful instead of a dead end.
 */
export default function SignInScreen() {
  const { t } = useLocale();
  const { signIn } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const next = {
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setErrors(next);
    setFormError(null);
    if (next.email || next.password) return;

    setSubmitting(true);
    try {
      await signIn(email, password);
      // Navigation is the session gate's job, not this screen's: it knows
      // whether the account is verified and whether onboarding is finished.
      router.replace('/');
    } catch (error) {
      const described = describeError(error, t);
      setFormError(described.message);

      // An unverified account is not a failed sign-in, it is an unfinished
      // one. Send them where they can finish it.
      if (isNikahMateError(error) && error.kind === 'email_not_confirmed') {
        router.push('/(auth)/verify-email');
      }
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
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <Logo size={44} />

          <Text style={[styles.title, { color: theme.colors.text }]}>{t('auth.signInTitle')}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {t('auth.signInSubtitle')}
          </Text>

          {formError ? <Banner tone="error" message={formError} /> : null}

          <View style={styles.form}>
            <TextField
              label={t('auth.email')}
              value={email}
              onChangeText={setEmail}
              placeholder={t('auth.emailPlaceholder')}
              error={errors.email ? t(errors.email) : undefined}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              testID="sign-in-email"
            />

            <TextField
              label={t('auth.password')}
              value={password}
              onChangeText={setPassword}
              error={errors.password ? t(errors.password) : undefined}
              secureTextEntry
              revealable
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              testID="sign-in-password"
            />

            <Pressable
              onPress={() => router.push('/(auth)/forgot-password')}
              accessibilityRole="link"
              style={styles.forgot}
            >
              <Text style={[styles.forgotText, { color: theme.colors.brand }]}>
                {t('auth.forgotPassword')}
              </Text>
            </Pressable>

            <Button
              label={t('auth.signIn')}
              onPress={() => void submit()}
              loading={submitting}
              testID="sign-in-submit"
            />
          </View>

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.colors.textMuted }]}>
              {t('auth.noAccount')}
            </Text>
            <Pressable
              onPress={() => router.replace('/(auth)/sign-up')}
              accessibilityRole="link"
              hitSlop={spacing.sm}
            >
              <Text style={[styles.footerLink, { color: theme.colors.brand }]}>
                {t('auth.signUp')}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display, marginTop: spacing.xl },
  subtitle: { ...typography.body, marginBottom: spacing.sm },
  form: { gap: spacing.lg, marginTop: spacing.sm },
  forgot: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  forgotText: { ...typography.caption, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.xl,
    flexWrap: 'wrap',
  },
  footerText: { ...typography.caption },
  footerLink: { ...typography.caption, fontWeight: '700' },
});
