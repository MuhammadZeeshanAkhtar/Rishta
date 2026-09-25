import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../../src/components/Button';
import { Logo } from '../../src/components/Logo';
import { LOCALE_META, useLocale } from '../../src/i18n/LocaleProvider';
import { useSession } from '../../src/session/SessionProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { emerald } from '../../src/theme/palette';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * First screen.
 *
 * Language comes before anything else — asking someone to read English to find
 * out how to switch to Urdu is the wrong first impression for a product that
 * claims to be worldwide. It sits directly under the mark, not behind a menu.
 *
 * The gradient hero exists to make the brand land in the first second and then
 * get out of the way; everything below it is plain surface.
 */
export default function WelcomeScreen() {
  const { t, locale, setLocale, available, direction, needsRestartForRtl } = useLocale();
  const { startPreviewSession } = useSession();
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
        <Text style={[styles.tagline, { writingDirection: direction }]}>
          {t('onboarding.welcome')}
        </Text>
      </LinearGradient>

      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <View style={styles.inner}>
          <Text
            style={[
              styles.label,
              { color: theme.colors.textMuted, writingDirection: direction, textAlign: 'left' },
            ]}
          >
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
                  style={[
                    styles.chip,
                    {
                      borderColor: selected ? theme.colors.brand : theme.colors.borderStrong,
                      backgroundColor: selected ? theme.colors.brandSurface : theme.colors.surface,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipNative,
                      { color: selected ? theme.colors.brandHover : theme.colors.text },
                    ]}
                  >
                    {meta.nativeName}
                  </Text>
                  <Text style={[styles.chipMeta, { color: theme.colors.textSubtle }]}>
                    {meta.englishName}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {needsRestartForRtl ? (
            <Text style={[styles.restartNote, { color: theme.colors.accent }]}>
              Restart the app to apply right-to-left layout.
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button label={t('auth.signIn')} onPress={() => router.push('/(auth)/sign-in')} />
            <Button
              label={t('auth.signUp')}
              variant="secondary"
              onPress={() => router.push('/(auth)/sign-in')}
            />
          </View>

          <Text
            style={[
              styles.ageGate,
              { color: theme.colors.textSubtle, writingDirection: direction, textAlign: 'left' },
            ]}
          >
            {t('onboarding.ageGate')}
          </Text>

          {/*
            Development only. Metro strips this from release builds, so it
            cannot ship. It is still the first thing to delete once real auth
            exists.
          */}
          {startPreviewSession ? (
            <Button
              label="Preview app shell (dev only)"
              variant="ghost"
              onPress={startPreviewSession}
              style={styles.devButton}
            />
          ) : null}
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
  label: { ...typography.overline, marginBottom: spacing.md },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  chipNative: { ...typography.bodyStrong },
  chipMeta: { ...typography.caption },
  restartNote: { ...typography.caption, marginTop: spacing.sm },
  actions: { marginTop: spacing.xxl, gap: spacing.md },
  ageGate: { ...typography.caption, marginTop: spacing.xl },
  devButton: { marginTop: 'auto' },
});
