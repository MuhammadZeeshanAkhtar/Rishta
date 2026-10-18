import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Logo } from '../../src/components/Logo';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { layout, spacing } from '../../src/theme/tokens';

/**
 * Where `nikahmate://auth/callback` lands.
 *
 * It deliberately does nothing. The link is completed by `AuthLinkHandler` in
 * the root layout, which sees every incoming URL regardless of which route
 * expo-router chooses to render — so the work does not depend on deep-link
 * path matching, which differs between a dev client and a standalone build.
 *
 * This route exists so the path resolves to a spinner instead of the
 * "Unmatched Route" screen for the half-second before the handler redirects.
 */
export default function AuthCallbackScreen() {
  const { t } = useLocale();
  const theme = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <Logo size={44} />
      <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: layout.gutter,
  },
});
