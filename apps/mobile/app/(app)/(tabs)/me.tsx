import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../../../src/components/Button';
import { Card, CardHeading } from '../../../src/components/Card';
import { Logo } from '../../../src/components/Logo';
import { PhaseNotice } from '../../../src/components/PhaseNotice';
import { Screen } from '../../../src/components/Screen';
import { LOCALE_META, useLocale } from '../../../src/i18n/LocaleProvider';
import { useSession } from '../../../src/session/SessionProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../../../src/theme/tokens';

export default function MeScreen() {
  const { t, locale, setLocale, available, direction } = useLocale();
  const { signOut } = useSession();
  const theme = useTheme();

  return (
    <Screen title={t('tabs.me')}>
      <Card style={styles.identity}>
        <View style={styles.identityRow}>
          <Logo size={44} />
          <View style={styles.identityText}>
            <Text
              style={[
                styles.identityName,
                { color: theme.colors.text, writingDirection: direction },
              ]}
            >
              NikahMate
            </Text>
            <Text
              style={[
                styles.identityMeta,
                { color: theme.colors.textMuted, writingDirection: direction },
              ]}
            >
              {t('onboarding.incomplete')}
            </Text>
          </View>
        </View>
      </Card>

      <Card style={styles.section}>
        <CardHeading
          overline={t('onboarding.chooseLanguage')}
          title={LOCALE_META[locale].nativeName}
        />
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
                  styles.language,
                  {
                    borderColor: selected ? theme.colors.brand : theme.colors.border,
                    backgroundColor: selected ? theme.colors.brandSurface : theme.colors.surface,
                  },
                ]}
              >
                <View style={styles.languageText}>
                  <Text
                    style={[
                      styles.languageNative,
                      { color: selected ? theme.colors.brandHover : theme.colors.text },
                    ]}
                  >
                    {meta.nativeName}
                  </Text>
                  <Text style={[styles.languageMeta, { color: theme.colors.textSubtle }]}>
                    {meta.englishName} · {meta.direction.toUpperCase()}
                  </Text>
                </View>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={20} color={theme.colors.brand} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </Card>

      <PhaseNotice
        phase="Phase 3"
        feature="Profile, photos, privacy controls and verification arrive with their phases."
      />

      <Button label={t('auth.signOut')} variant="danger" onPress={signOut} style={styles.signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: { marginBottom: spacing.md },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  identityText: { flexShrink: 1 },
  identityName: { ...typography.heading },
  identityMeta: { ...typography.caption, marginTop: 2 },
  section: { marginBottom: spacing.md },
  languages: { gap: spacing.sm, marginTop: spacing.lg },
  language: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  languageText: { flexShrink: 1 },
  languageNative: { ...typography.bodyStrong },
  languageMeta: { ...typography.caption },
  signOut: { marginTop: spacing.xl },
});
