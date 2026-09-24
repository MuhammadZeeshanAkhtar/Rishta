import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../../../src/components/Screen';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { LOCALE_META, useLocale } from '../../../src/i18n/LocaleProvider';
import { useSession } from '../../../src/session/SessionProvider';
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from '../../../src/theme/tokens';

export default function MeScreen() {
  const { t, locale, setLocale, available, direction } = useLocale();
  const { signOut } = useSession();

  return (
    <Screen title={t('tabs.me')}>
      <Text style={[styles.section, { writingDirection: direction, textAlign: 'left' }]}>
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
              style={[styles.language, selected && styles.languageSelected]}
            >
              <Text style={[styles.languageNative, selected && styles.languageTextSelected]}>
                {meta.nativeName}
              </Text>
              <Text style={[styles.languageEnglish, selected && styles.languageTextSelected]}>
                {meta.englishName} · {meta.direction.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <PhaseNotice
        phase="Phase 3"
        feature="Profile, photos, privacy controls and verification arrive with their phases."
      />

      <Pressable onPress={signOut} style={styles.signOut} accessibilityRole="button">
        <Text style={styles.signOutText}>{t('auth.signOut')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { ...typography.heading, color: colors.text, marginBottom: spacing.sm },
  languages: { gap: spacing.sm },
  language: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  languageSelected: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  languageNative: { ...typography.body, color: colors.text, fontWeight: '600' },
  languageEnglish: { ...typography.caption, color: colors.textMuted },
  languageTextSelected: { color: colors.primaryDark },
  signOut: {
    marginTop: spacing.xl,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  signOutText: { ...typography.body, color: colors.danger, fontWeight: '600' },
});
