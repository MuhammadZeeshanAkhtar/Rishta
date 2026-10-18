import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * Card.
 *
 * A soft border carries most of the separation and the shadow only hints at
 * elevation. Heavy drop shadows read as dated, and they cost fill-rate on the
 * low-end devices this product targets.
 */
export function Card({
  children,
  style,
  tone = 'default',
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  tone?: 'default' | 'brand' | 'sunken';
}) {
  const theme = useTheme();

  const toneStyle: ViewStyle = {
    default: { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
    brand: { backgroundColor: theme.colors.brandSurface, borderColor: theme.colors.brandBorder },
    sunken: { backgroundColor: theme.colors.surfaceSunken, borderColor: theme.colors.border },
  }[tone];

  return (
    <View style={[styles.card, toneStyle, tone !== 'sunken' && theme.shadow.card, style]}>
      {children}
    </View>
  );
}

/** Eyebrow + body pairing used inside cards. */
export function CardHeading({ overline, title }: { overline?: string; title: string }) {
  const theme = useTheme();
  return (
    <View>
      {overline ? (
        <Text style={[styles.overline, { color: theme.colors.brand }]}>
          {overline.toUpperCase()}
        </Text>
      ) : null}
      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
  },
  overline: { ...typography.overline, marginBottom: spacing.xs },
  title: { ...typography.heading },
});
