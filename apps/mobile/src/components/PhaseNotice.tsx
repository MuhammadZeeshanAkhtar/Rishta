import { StyleSheet, Text, View } from 'react-native';
import { useLocale } from '../i18n/LocaleProvider';
import { colors, radius, spacing, typography } from '../theme/tokens';

/**
 * Marks a screen as an empty shell.
 *
 * Phase 1 builds navigation, not features. Saying so on the screen keeps the
 * app honest to anyone opening it, rather than implying something works.
 */
export function PhaseNotice({ phase, feature }: { phase: string; feature: string }) {
  const { direction } = useLocale();
  return (
    <View style={styles.box}>
      <Text style={[styles.label, { writingDirection: direction, textAlign: 'left' }]}>
        {phase}
      </Text>
      <Text style={[styles.body, { writingDirection: direction, textAlign: 'left' }]}>
        {feature}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  label: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  body: { ...typography.body, color: colors.textMuted },
});
