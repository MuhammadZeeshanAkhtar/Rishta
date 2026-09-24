import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, motion, radius, spacing, typography } from '../theme/tokens';

/**
 * Button.
 *
 * The press animation is deliberately small — a 3% scale over 90ms. Enough to
 * confirm the touch registered, short enough that it never feels like lag on a
 * low-end device. Anything showier becomes tiring in an app people use while
 * making a serious decision.
 *
 * `useNativeDriver` keeps the animation off the JS thread, so it stays smooth
 * even while the app is fetching.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Renders to the start of the label. */
  icon?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  icon,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number, duration: number) =>
    Animated.timing(scale, { toValue: to, duration, useNativeDriver: true }).start();

  const labelColor = {
    primary: theme.colors.textOnBrand,
    secondary: theme.colors.brand,
    ghost: theme.colors.textMuted,
    danger: theme.colors.danger,
  }[variant];

  const surface: ViewStyle = {
    primary: {},
    secondary: {
      borderWidth: 1.5,
      borderColor: theme.colors.brandBorder,
      backgroundColor: theme.colors.surface,
    },
    ghost: { backgroundColor: 'transparent' },
    danger: {
      borderWidth: 1.5,
      borderColor: theme.colors.dangerSurface,
      backgroundColor: theme.colors.dangerSurface,
    },
  }[variant];

  const content = (
    <View style={styles.content}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => animate(motion.pressScale, motion.pressIn)}
        onPressOut={() => animate(1, motion.pressOut)}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        style={[styles.base, surface, disabled && styles.disabled]}
      >
        {variant === 'primary' ? (
          <LinearGradient
            colors={[...theme.gradients.brand]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {content}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { alignItems: 'center', justifyContent: 'center' },
  label: { ...typography.bodyStrong },
  disabled: { opacity: 0.45 },
});
