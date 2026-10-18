import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { Logo } from '../../src/components/Logo';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { describeError } from '../../src/lib/errors';
import { layout, spacing, typography } from '../../src/theme/tokens';

/** Long enough to stop accidental double-taps and to respect the mail provider. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Email verification.
 *
 * The screen has to work for someone who opens the link on a laptop while the
 * phone sits idle, so it re-checks on two triggers rather than waiting to be
 * told: when the app returns to the foreground, and when the person says they
 * are done. Polling on a timer would drain a battery to save one tap.
 *
 * It never assumes verification succeeded. `refresh()` asks the server, and
 * the session gate decides where to go next.
 */
export default function VerifyEmailScreen() {
  const { t } = useLocale();
  const { pendingEmail, resendVerification, refresh, signOut, state } = useSession();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [banner, setBanner] = useState<{
    tone: 'error' | 'success' | 'info';
    message: string;
  } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Once the session gate says the email is confirmed, leave. Doing this in an
  // effect rather than inside the check handler means it also fires when
  // verification is noticed by the background auth listener.
  useEffect(() => {
    if (state === 'onboarding' || state === 'ready') router.replace('/');
  }, [state, router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const check = useCallback(
    async (silent: boolean) => {
      if (!silent) setChecking(true);
      try {
        await refresh();
        // If still here after refresh, the email is not confirmed yet. The
        // effect above handles the success case.
        if (mounted.current && !silent) {
          setBanner({ tone: 'info', message: t('verify.stillUnverified') });
        }
      } catch (error) {
        if (mounted.current && !silent) {
          setBanner({ tone: 'error', message: describeError(error, t).message });
        }
      } finally {
        if (mounted.current && !silent) setChecking(false);
      }
    },
    [refresh, t],
  );

  // Coming back from the mail app is the most common moment for this to have
  // just become true.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void check(true);
    });
    return () => subscription.remove();
  }, [check]);

  const resend = async () => {
    setResending(true);
    setBanner(null);
    try {
      await resendVerification();
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setBanner({ tone: 'success', message: t('verify.resent') });
    } catch (error) {
      const described = describeError(error, t);
      // Supabase enforces its own cooldown; mirror whatever it asks for so the
      // button does not invite another refused attempt.
      if (described.retryAfterSeconds) setCooldown(described.retryAfterSeconds);
      setBanner({ tone: 'error', message: described.message });
    } finally {
      setResending(false);
    }
  };

  const sentTo = t('verify.sentTo').replace('{{email}}', pendingEmail ?? '');

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl },
      ]}
    >
      <View style={styles.inner}>
        <Logo size={44} />

        <Text style={[styles.title, { color: theme.colors.text }]}>{t('verify.title')}</Text>

        <Text style={[styles.body, { color: theme.colors.textMuted }]}>{sentTo}</Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          {t('verify.instruction')}
        </Text>

        {banner ? <Banner tone={banner.tone} message={banner.message} /> : null}

        <View style={styles.actions}>
          <Button
            label={t('verify.checkAgain')}
            onPress={() => void check(false)}
            loading={checking}
            testID="verify-check"
          />
          <Button
            label={
              cooldown > 0
                ? t('verify.resendIn').replace('{{seconds}}', String(cooldown))
                : t('verify.resend')
            }
            variant="secondary"
            onPress={() => void resend()}
            loading={resending}
            disabled={cooldown > 0}
            testID="verify-resend"
          />
          <Button
            label={t('verify.wrongAccount')}
            variant="ghost"
            onPress={() => {
              void signOut();
              router.replace('/(auth)/welcome');
            }}
            testID="verify-sign-out"
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display, marginTop: spacing.lg },
  body: { ...typography.body },
  actions: { gap: spacing.md, marginTop: spacing.xl },
});
