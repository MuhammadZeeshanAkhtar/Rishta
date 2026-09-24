import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../../src/components/Screen';
import { PhaseNotice } from '../../src/components/PhaseNotice';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from '../../src/theme/tokens';

/**
 * Sign-in shell.
 *
 * The real flow needs a NikahMate Supabase project, which does not exist yet.
 * Rather than a form that cannot work, this says plainly what is missing — a
 * dead input box would be worse than an honest empty state.
 */
export default function SignInScreen() {
  const { t, direction } = useLocale();
  const router = useRouter();

  return (
    <Screen title={t('auth.signIn')}>
      <PhaseNotice
        phase="Blocked"
        feature="Email, phone and Google sign-in arrive in Phase 2. They need a NikahMate Supabase project first — see docs/SUPABASE_SETUP.md."
      />

      <View style={styles.methods}>
        {[t('auth.email'), t('auth.phone'), t('auth.continueWithGoogle')].map((label) => (
          <View key={label} style={styles.method}>
            <Text style={[styles.methodText, { writingDirection: direction, textAlign: 'left' }]}>
              {label}
            </Text>
          </View>
        ))}
      </View>

      <Pressable onPress={() => router.back()} style={styles.back} accessibilityRole="button">
        <Text style={styles.backText}>{t('common.back')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  methods: { marginTop: spacing.lg, gap: spacing.sm },
  method: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    opacity: 0.5,
  },
  methodText: { ...typography.body, color: colors.textMuted },
  back: {
    marginTop: spacing.xl,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { ...typography.body, color: colors.primary, fontWeight: '600' },
});
