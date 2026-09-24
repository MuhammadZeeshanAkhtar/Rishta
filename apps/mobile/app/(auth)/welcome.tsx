import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LOCALE_META, useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import {
  colors,
  layout,
  radius,
  spacing,
  typography,
  MIN_TOUCH_TARGET,
} from '../../src/theme/tokens';

/**
 * First screen. Language comes before anything else — asking someone to read
 * English to find out how to switch to Urdu is the wrong first impression for
 * a product that claims to be worldwide.
 */
export default function WelcomeScreen() {
  const { t, locale, setLocale, available, direction, needsRestartForRtl } = useLocale();
  const { startPreviewSession } = useSession();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg },
      ]}
    >
      <View style={styles.inner}>
        <Text style={styles.brand}>NikahMate</Text>
        <Text style={[styles.tagline, { writingDirection: direction, textAlign: 'left' }]}>
          {t('onboarding.welcome')}
        </Text>

        <Text style={[styles.label, { writingDirection: direction, textAlign: 'left' }]}>
          {t('onboarding.chooseLanguage')}
        </Text>

        <View style={styles.languages}>
          {available.map((code) => {
            const meta = LOCALE_META[code];
            const selected = code === locale;
            return (
              <Pressable
                key={code}
                onPress={() => setLocale(code)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={meta.englishName}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {meta.nativeName}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {needsRestartForRtl ? (
          <Text style={styles.restartNote}>Restart the app to apply right-to-left layout.</Text>
        ) : null}

        <View style={styles.actions}>
          <Link href="/(auth)/sign-in" asChild>
            <Pressable style={styles.primaryButton} accessibilityRole="button">
              <Text style={styles.primaryButtonText}>{t('auth.signIn')}</Text>
            </Pressable>
          </Link>

          <Link href="/(auth)/sign-in" asChild>
            <Pressable style={styles.secondaryButton} accessibilityRole="button">
              <Text style={styles.secondaryButtonText}>{t('auth.signUp')}</Text>
            </Pressable>
          </Link>
        </View>

        <Text style={[styles.ageGate, { writingDirection: direction, textAlign: 'left' }]}>
          {t('onboarding.ageGate')}
        </Text>

        {/*
          Development only. Metro strips this from release builds, so it cannot
          ship. It is still the first thing to delete once real auth exists.
        */}
        {startPreviewSession ? (
          <Pressable
            onPress={startPreviewSession}
            style={styles.devButton}
            accessibilityRole="button"
          >
            <Text style={styles.devButtonText}>Preview app shell (dev only)</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: layout.gutter },
  inner: { flex: 1, width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  brand: { ...typography.display, color: colors.primary, marginBottom: spacing.xs },
  tagline: { ...typography.body, color: colors.textMuted, marginBottom: spacing.xl },
  label: { ...typography.heading, color: colors.text, marginBottom: spacing.sm },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  chipText: { ...typography.body, color: colors.text },
  chipTextSelected: { color: colors.primaryDark, fontWeight: '700' },
  restartNote: { ...typography.caption, color: colors.accent, marginTop: spacing.sm },
  actions: { marginTop: spacing.xl, gap: spacing.sm },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { ...typography.body, color: colors.textInverse, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { ...typography.body, color: colors.primary, fontWeight: '700' },
  ageGate: { ...typography.caption, color: colors.textMuted, marginTop: spacing.lg },
  devButton: {
    marginTop: 'auto',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.sm,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  devButtonText: { ...typography.caption, color: colors.textMuted },
});
