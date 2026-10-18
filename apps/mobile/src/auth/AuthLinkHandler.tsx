import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { useLocale } from '../i18n/LocaleProvider';
import { useSession } from '../session/SessionProvider';
import { useTheme } from '../theme/ThemeProvider';
import { isNikahMateError } from '@nikahmate/api-client';
import { describeError } from '../lib/errors';
import { layout, spacing, typography } from '../theme/tokens';

/**
 * Completes Supabase email links, wherever the app happens to be.
 *
 * Mounted in the root layout rather than on a route, for one reason that
 * matters in practice: how a deep link maps to a route differs between a dev
 * client (`exp://…/--/auth/callback`) and a standalone build
 * (`nikahmate://auth/callback`). Handling the URL at the root means
 * verification and password recovery work in both without the routing table
 * having to agree.
 *
 * `detectSessionInUrl` is off in the client on purpose — on mobile it would
 * let any deep link hand the app a session — so this is the only place a link
 * becomes a session, and it is explicit about which kind it just handled.
 */
export function AuthLinkHandler() {
  const { t } = useLocale();
  const { completeAuthLink } = useSession();
  const theme = useTheme();
  const router = useRouter();

  const url = Linking.useURL();
  const [error, setError] = useState<string | null>(null);

  // A link is redeemable once. Without this, a re-render or a resume event
  // would retry a code that has already been spent, and the second attempt
  // fails — turning a working link into an error message.
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!url) return;
    // Only auth links. The app is deep-linkable for other reasons and this
    // must not intercept every incoming URL.
    if (!/[?#&](code|token_hash|error|error_code)=/.test(url)) return;
    if (seen.current.has(url)) return;
    seen.current.add(url);

    void (async () => {
      try {
        const type = await completeAuthLink(url);
        if (type === 'recovery') {
          router.replace('/(auth)/reset-password');
          return;
        }
        // Verification or magic link: the session gate knows where to go next.
        router.replace('/');
      } catch (err) {
        // An expired link arrives looking like a success — Supabase reports
        // the failure inside the URL rather than by refusing to open it — so
        // this is the ordinary path for anyone who waited a day to tap.
        //
        // `session_expired` is the right KIND but the wrong words here: the
        // generic copy says "your session has expired", and the person never
        // had a session — they tapped an old link. Say that instead.
        setError(
          isNikahMateError(err) && err.kind === 'session_expired'
            ? t('auth.resetLinkExpired')
            : describeError(err, t).message,
        );
      }
    })();
  }, [url, completeAuthLink, router, t]);

  if (!error) return null;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={() => setError(null)}>
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <View style={styles.inner}>
          <Logo size={44} />
          <Text style={[styles.title, { color: theme.colors.text, textAlign: 'center' }]}>
            {t('auth.linkProblemTitle')}
          </Text>
          <Banner tone="error" message={error} />
          <Button
            label={t('auth.backToSignIn')}
            onPress={() => {
              setError(null);
              router.replace('/(auth)/sign-in');
            }}
            testID="auth-link-error-back"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: layout.gutter },
  inner: {
    width: '100%',
    maxWidth: layout.maxContentWidth,
    alignItems: 'center',
    gap: spacing.lg,
  },
  title: { ...typography.title },
});
