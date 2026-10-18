import { Animated, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { usePressScale } from '../theme/useEntrance';
import { MIN_TOUCH_TARGET, iconSize, radius, spacing, typography } from '../theme/tokens';

/**
 * A navigation row: icon, label, one line of explanation, chevron.
 *
 * WHY NOT BUTTONS. Four stacked full-width secondary buttons is what the
 * profile screen had, and it made the page look like a settings menu with a
 * profile attached. A row carries a sublabel, so "Privacy and photos" can say
 * what it governs, and it visually recedes — which is correct, because these
 * are things you do to the profile, not the profile itself.
 *
 * `destructive` shifts the icon and label to the danger colour and nothing
 * else. Sign-out is not an emergency; a full red row would make leaving the
 * app look like deleting the account.
 */

export interface ActionRowProps {
  label: string;
  sublabel?: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
  style?: ViewStyle;
  testID?: string;
}

export function ActionRow({
  label,
  sublabel,
  icon,
  onPress,
  destructive = false,
  style,
  testID,
}: ActionRowProps) {
  const theme = useTheme();

  const press = usePressScale();

  const tint = destructive ? theme.colors.danger : theme.colors.brand;
  const markBackground = destructive ? theme.colors.dangerSurface : theme.colors.brandSurface;

  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={sublabel ? `${label}. ${sublabel}` : label}
        testID={testID}
        style={[
          styles.row,
          theme.shadow.card,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <View style={[styles.mark, { backgroundColor: markBackground }]}>
          <Ionicons name={icon} size={iconSize.sm} color={tint} />
        </View>

        <View style={styles.text}>
          <Text
            style={[styles.label, { color: destructive ? theme.colors.danger : theme.colors.text }]}
          >
            {label}
          </Text>
          {sublabel ? (
            <Text style={[styles.sublabel, { color: theme.colors.textMuted }]} numberOfLines={2}>
              {sublabel}
            </Text>
          ) : null}
        </View>

        <Ionicons name="chevron-forward" size={iconSize.sm} color={theme.colors.textSubtle} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET + spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mark: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, flexShrink: 1, gap: 1 },
  label: { ...typography.bodyStrong },
  sublabel: { ...typography.caption },
});
