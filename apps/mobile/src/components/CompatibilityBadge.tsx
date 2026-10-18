import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * The compatibility score, shown honestly.
 *
 * TWO RULES, both of which this product's scoring design earns:
 *
 *   * **No score, no badge.** A profile with no computed score renders
 *     nothing rather than "0%" or "—". A zero would be a claim the engine
 *     never made, and this is a decision people take seriously.
 *   * **No colour for "bad".** The band shades from emerald to neutral, never
 *     to red. Rendering a person in a warning colour because an algorithm
 *     scored them low is a judgement the product has no business making on
 *     screen — the explanation endpoint shows the differences honestly in
 *     words instead.
 */

export type BadgeSize = 'sm' | 'md' | 'lg';

export interface CompatibilityBadgeProps {
  /** 0–100, or null when nothing has been computed. */
  score: number | null | undefined;
  size?: BadgeSize;
  /** Inverted sits on a photo or a brand ground. */
  onDark?: boolean;
  style?: ViewStyle;
}

export function CompatibilityBadge({
  score,
  size = 'md',
  onDark = false,
  style,
}: CompatibilityBadgeProps) {
  const theme = useTheme();
  if (score === null || score === undefined || !Number.isFinite(score)) return null;

  const rounded = Math.round(score);
  // Emerald at the top, fading to neutral. Never red.
  const tone =
    rounded >= 75
      ? { bg: theme.colors.brand, fg: theme.colors.textOnBrand }
      : rounded >= 50
        ? { bg: theme.colors.brandSurface, fg: theme.colors.brandHover }
        : { bg: theme.colors.surfaceSunken, fg: theme.colors.textMuted };

  const onDarkTone = { bg: 'rgba(255,255,255,0.92)', fg: theme.colors.brandHover };
  const colours = onDark ? onDarkTone : tone;

  const metrics =
    size === 'lg'
      ? { pv: spacing.sm, ph: spacing.md, text: typography.bodyStrong }
      : size === 'sm'
        ? { pv: 2, ph: spacing.sm, text: typography.overline }
        : { pv: spacing.xs, ph: spacing.sm + 2, text: typography.caption };

  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: colours.bg,
          paddingVertical: metrics.pv,
          paddingHorizontal: metrics.ph,
        },
        style,
      ]}
      accessibilityRole="text"
      accessibilityLabel={`${rounded} percent compatible`}
    >
      <Text style={[metrics.text, styles.label, { color: colours.fg }]} numberOfLines={1}>
        {rounded}% match
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: radius.pill, alignSelf: 'flex-start' },
  label: { fontWeight: '700', letterSpacing: 0 },
});
