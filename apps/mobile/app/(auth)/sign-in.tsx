import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../../src/components/Button';
import { Card } from '../../src/components/Card';
import { PhaseNotice } from '../../src/components/PhaseNotice';
import { Screen } from '../../src/components/Screen';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radius, spacing, typography } from '../../src/theme/tokens';

/**
 * Sign-in shell.
 *
 * The real flow needs a NikahMate Supabase project, which does not exist yet.
 * The methods are shown as disabled rows rather than live inputs — a form that
 * silently cannot submit is worse than an honest empty state.
 */
export default function SignInScreen() {
  const { t, direction } = useLocale();
  const theme = useTheme();
  const router = useRouter();

  const methods = [
    { key: 'email', label: t('auth.email'), icon: 'mail-outline' as const },
    { key: 'phone', label: t('auth.phone'), icon: 'call-outline' as const },
    { key: 'google', label: t('auth.continueWithGoogle'), icon: 'logo-google' as const },
  ];

  return (
    <Screen title={t('auth.signIn')}>
      <View style={styles.methods}>
        {methods.map((m) => (
          <Card key={m.key} tone="sunken" style={styles.method}>
            <View style={styles.methodRow}>
              <View style={[styles.iconWell, { backgroundColor: theme.colors.brandSurface }]}>
                <Ionicons name={m.icon} size={18} color={theme.colors.brand} />
              </View>
              <Text
                style={[
                  styles.methodText,
                  { color: theme.colors.textMuted, writingDirection: direction },
                ]}
              >
                {m.label}
              </Text>
            </View>
          </Card>
        ))}
      </View>

      <PhaseNotice
        phase="Blocked"
        feature="Email, phone and Google sign-in arrive in Phase 2. They need a NikahMate Supabase project first — see docs/SUPABASE_SETUP.md."
      />

      <Button
        label={t('common.back')}
        variant="ghost"
        onPress={() => router.back()}
        style={styles.back}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  methods: { gap: spacing.sm },
  method: { paddingVertical: spacing.md, opacity: 0.7 },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconWell: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodText: { ...typography.body, flexShrink: 1 },
  back: { marginTop: spacing.xl },
});
