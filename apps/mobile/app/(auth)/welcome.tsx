import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../../src/components/Button';
import { Logo } from '../../src/components/Logo';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { emerald } from '../../src/theme/palette';
import { layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * First screen.
 *
 * The app ships in English only (ADR 0012), so there is no language choice to
 * make here — the screen goes straight from the mark to signing up or in.
 *
 * The gradient hero exists to make the brand land in the first second and then
 * get out of the way; everything below it is plain surface.
 */
export default function WelcomeScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <LinearGradient
        colors={[...theme.gradients.brandDeep]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.hero, { paddingTop: insets.top + spacing.xxl }]}
      >
        <Logo size={88} variant="stacked" tone="dark" />
        <Text style={styles.tagline}>{t('onboarding.welcome')}</Text>
      </LinearGradient>

      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <View style={styles.inner}>
          <Text style={[styles.pitch, { color: theme.colors.textMuted }]}>
            {t('onboarding.welcomeSubtitle')}
          </Text>

          <View style={styles.actions}>
            <Button
              label={t('auth.signUp')}
              onPress={() => router.push('/(auth)/sign-up')}
              testID="welcome-sign-up"
            />
            <Button
              label={t('auth.signIn')}
              variant="secondary"
              onPress={() => router.push('/(auth)/sign-in')}
              testID="welcome-sign-in"
            />
          </View>

          <Text style={[styles.ageGate, { color: theme.colors.textSubtle }]}>
            {t('onboarding.ageGate')}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: {
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.xxl,
    alignItems: 'center',
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  tagline: {
    ...typography.body,
    // A light step of the brand hue rather than a one-off tint: the tagline
    // sits on the emerald gradient and should belong to it.
    color: emerald[100],
    marginTop: spacing.md,
    textAlign: 'center',
  },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: layout.gutter, paddingTop: spacing.xl, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', flex: 1 },
  pitch: { ...typography.body, marginBottom: spacing.xl },
  actions: { marginTop: spacing.xxl, gap: spacing.md },
  ageGate: { ...typography.caption, marginTop: spacing.xl },
});
