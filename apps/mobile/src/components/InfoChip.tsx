import { Animated, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { usePressScale } from '../theme/useEntrance';
import { iconSize, radius, spacing, typography } from '../theme/tokens';

/**
 * A fact, as a chip.
 *
 * WHY THIS EXISTS. A profile rendered as label-above-value is a database row
 * with spacing, and it reads like one: twelve left-aligned captions down the
 * page, each one asking to be parsed separately. A chip carries the same fact
 * as a single object you take in at a glance, and a row of them reads as
 * "this is who I am" rather than "field: value".
 *
 * SO THE LABEL IS DROPPED, NOT SHRUNK. "Sunni" needs no caption saying
 * "Sect" — the section heading already said Faith, and a person reading a
 * profile is not auditing a form. Where a value genuinely cannot stand alone
 * (a bare number, a date) `prefix` puts the minimum context inline, which
 * keeps it one object instead of two.
 *
 * TONES ARE RATIONED. `neutral` for most facts, `brand` for the one or two
 * worth weight in a group, `accent` for gold moments only. If everything is
 * emphasised then nothing is, and a profile in fifteen colours reads as a
 * novelty rather than as someone serious about marriage.
 */

export type ChipTone = 'neutral' | 'brand' | 'accent' | 'outline';

export interface InfoChipProps {
  label: string;
  /** Rendered before the label, same line. For values that cannot stand alone. */
  prefix?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: ChipTone;
  /** Only pass this when the chip really navigates somewhere. */
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
}

export function InfoChip({
  label,
  prefix,
  icon,
  tone = 'neutral',
  onPress,
  style,
  testID,
}: InfoChipProps) {
  const theme = useTheme();

  const tones: Record<ChipTone, { bg: string; fg: string; border: string; icon: string }> = {
    neutral: {
      bg: theme.colors.surfaceSunken,
      fg: theme.colors.text,
      border: 'transparent',
      icon: theme.colors.textMuted,
    },
    brand: {
      bg: theme.colors.brandSurface,
      fg: theme.colors.brandHover,
      border: 'transparent',
      icon: theme.colors.brand,
    },
    accent: {
      bg: theme.colors.accentSurface,
      fg: theme.colors.accent,
      border: 'transparent',
      icon: theme.colors.accent,
    },
    outline: {
      bg: 'transparent',
      fg: theme.colors.textMuted,
      border: theme.colors.border,
      icon: theme.colors.textSubtle,
    },
  };
  const colours = tones[tone];

  const press = usePressScale();

  const body = (
    <>
      {icon ? <Ionicons name={icon} size={iconSize.xs} color={colours.icon} /> : null}
      <Text style={[styles.label, { color: colours.fg }]} numberOfLines={1}>
        {prefix ? <Text style={{ color: theme.colors.textSubtle }}>{`${prefix} `}</Text> : null}
        {label}
      </Text>
    </>
  );

  const shell: ViewStyle = {
    backgroundColor: colours.bg,
    borderColor: colours.border,
    borderWidth: tone === 'outline' ? StyleSheet.hairlineWidth : 0,
  };

  // A static chip is a static chip. Wrapping a fact in a Pressable so it can
  // have a press animation would announce it to a screen reader as a button
  // that does nothing, which is worse than no animation.
  if (!onPress) {
    return (
      <View style={[styles.chip, shell, style]} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={prefix ? `${prefix} ${label}` : label}
        testID={testID}
        style={[styles.chip, shell]}
      >
        {body}
      </Pressable>
    </Animated.View>
  );
}

/**
 * A row of chips that wraps.
 *
 * Separate from the chip so every caller gets the same gap. Chip groups at
 * three different spacings on one screen is the kind of thing nobody can name
 * but everybody sees.
 */
export function ChipRow({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    // Caps a long reference label at the content width instead of letting it
    // push the row sideways. 320dp is the floor this product supports.
    maxWidth: '100%',
  },
  label: { ...typography.caption, fontWeight: '600', flexShrink: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
