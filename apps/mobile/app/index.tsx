import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../src/session/SessionProvider';
import { useLocale } from '../src/i18n/LocaleProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { layout, spacing, typography } from '../src/theme/tokens';

/**
 * Splash, and the routing gates from README §6.1.
 *
 *   signed out            -> (auth)/welcome
 *   email unverified      -> (auth)/verify-email
 *   verified, incomplete  -> (onboarding)
 *   complete              -> (app)
 *
 * Routing mirrors the server's decision; it never makes it. The API is what
 * actually enforces that an incomplete profile is not discoverable — this only
 * decides which screen to show while that is true.
 */
export default function Index() {
  const { state, configError } = useSession();
  const { t } = useLocale();
  const theme = useTheme();

  if (state === 'loading') {
    return (
      <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  // A build with no Supabase configuration. Naming the missing variables beats
  // a blank screen or a crash on the first request.
  if (state === 'misconfigured') {
    return (
      <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
        <View style={styles.inner}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {t('errors.configMissing').replace('{{values}}', (configError ?? []).join(', '))}
          </Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>
            See docs/SUPABASE_SETUP.md, then restart the app.
          </Text>
        </View>
      </View>
    );
  }

  if (state === 'signed_out') return <Redirect href="/(auth)/welcome" />;
  if (state === 'unverified') return <Redirect href="/(auth)/verify-email" />;
  if (state === 'onboarding') return <Redirect href="/(onboarding)/basics" />;
  return <Redirect href="/discover" />;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: layout.gutter },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, gap: spacing.sm },
  // Variable names are long unbroken tokens. Without an explicit break they
  // run off the side of a 320dp screen instead of wrapping.
  title: { ...typography.heading, textAlign: 'center', flexShrink: 1 },
  body: { ...typography.caption, textAlign: 'center', flexShrink: 1 },
});
