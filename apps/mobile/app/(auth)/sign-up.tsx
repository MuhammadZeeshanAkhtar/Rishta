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
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { Checkbox } from '../../src/components/Checkbox';
import { Logo } from '../../src/components/Logo';
import { TextField } from '../../src/components/TextField';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { describeError } from '../../src/lib/errors';
import {
  validateEmail,
  validatePassword,
  validatePasswordConfirmation,
  type ValidationKey,
} from '../../src/lib/validation';
import { layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * Create account.
 *
 * Email and password only. The profile is a separate, longer conversation —
 * asking for a date of birth and a sect before someone has an account is how a
 * matrimonial app feels like an interrogation on first contact.
 *
 * Two consents, both required and both explicit:
 *
 *   - Terms and privacy, the ordinary one.
 *   - **Religious data**, which is GDPR Article 9 special-category data and the
 *     core of this product (README §9.8, risk R1). It needs its own
 *     affirmative, unbundled consent at the point of collection — a single
 *     combined checkbox would not be a lawful basis.
 */
export default function SignUpScreen() {
  const { t } = useLocale();
  const { signUp } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedReligious, setAcceptedReligious] = useState(false);
  const [errors, setErrors] = useState<Record<string, ValidationKey>>({});
  const [consentError, setConsentError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const next = {
      email: validateEmail(email),
      password: validatePassword(password),
      confirmation: validatePasswordConfirmation(password, confirmation),
    };
    const consentsMissing = !acceptedTerms || !acceptedReligious;

    setErrors(next);
    setConsentError(consentsMissing);
    setFormError(consentsMissing ? t('auth.consentRequired') : null);
    if (next.email || next.password || next.confirmation || consentsMissing) return;

    setSubmitting(true);
    try {
      await signUp(email, password);
      // Always to verification, even when Supabase returned a session: the
      // gate is "is this email confirmed", and assuming otherwise would let an
      // unverified account into onboarding.
      router.replace('/(auth)/verify-email');
    } catch (error) {
      setFormError(describeError(error, t).message);
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

          <Text style={[styles.title, { color: theme.colors.text }]}>{t('auth.signUpTitle')}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {t('auth.signUpSubtitle')}
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
              testID="sign-up-email"
            />

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
              testID="sign-up-password"
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
              testID="sign-up-confirm"
            />
          </View>

          <View
            style={[
              styles.consent,
              {
                backgroundColor: theme.colors.surfaceSunken,
                borderColor: consentError ? theme.colors.danger : theme.colors.border,
              },
            ]}
          >
            <Text style={[styles.consentTitle, { color: theme.colors.text }]}>
              {t('auth.consentTitle')}
            </Text>

            <Checkbox
              label={t('auth.consentTerms')}
              checked={acceptedTerms}
              onChange={setAcceptedTerms}
              error={consentError && !acceptedTerms}
              testID="sign-up-consent-terms"
            />
            <Checkbox
              label={t('auth.consentReligious')}
              checked={acceptedReligious}
              onChange={setAcceptedReligious}
              error={consentError && !acceptedReligious}
              testID="sign-up-consent-religious"
            />
          </View>

          <Button
            label={t('auth.signUp')}
            onPress={() => void submit()}
            loading={submitting}
            testID="sign-up-submit"
          />

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.colors.textMuted }]}>
              {t('auth.haveAccount')}
            </Text>
            <Pressable
              onPress={() => router.replace('/(auth)/sign-in')}
              accessibilityRole="link"
              hitSlop={spacing.sm}
            >
              <Text style={[styles.footerLink, { color: theme.colors.brand }]}>
                {t('auth.signIn')}
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
  consent: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  consentTitle: { ...typography.overline, marginBottom: spacing.xs },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    flexWrap: 'wrap',
  },
  footerText: { ...typography.caption },
  footerLink: { ...typography.caption, fontWeight: '700' },
});
