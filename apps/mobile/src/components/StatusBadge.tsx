import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * A small state pill.
 *
 * Tones are muted on purpose. An interest someone declined is a real
 * disappointment to the person reading it, and rendering that in alarm-red
 * makes a normal outcome feel like a failure. `neutral` carries declines and
 * withdrawals; the warm tone is reserved for things still open.
 */

export type StatusTone = 'brand' | 'warm' | 'neutral' | 'success' | 'danger';

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  style?: ViewStyle;
}

export function StatusBadge({ label, tone = 'neutral', style }: StatusBadgeProps) {
  const theme = useTheme();

  const tones: Record<StatusTone, { bg: string; fg: string }> = {
    brand: { bg: theme.colors.brandSurface, fg: theme.colors.brandHover },
    warm: { bg: theme.colors.accentSurface, fg: theme.colors.accent },
    neutral: { bg: theme.colors.surfaceSunken, fg: theme.colors.textMuted },
    success: { bg: theme.colors.successSurface, fg: theme.colors.success },
    danger: { bg: theme.colors.dangerSurface, fg: theme.colors.danger },
  };
  const colours = tones[tone];

  return (
    <View style={[styles.pill, { backgroundColor: colours.bg }, style]}>
      <Text style={[styles.label, { color: colours.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm + 2,
    alignSelf: 'flex-start',
  },
  label: { ...typography.overline, letterSpacing: 0.4 },
});
