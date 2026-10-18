import { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
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
  /**
   * Shows a spinner and blocks presses.
   *
   * The label stays in place underneath rather than being replaced, so the
   * button keeps its width and the layout does not jump the moment someone
   * submits — which on a slow connection is exactly when a shifting screen
   * makes people tap the wrong thing.
   */
  loading?: boolean;
  /** Renders to the start of the label. */
  icon?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  icon,
  style,
  testID,
  accessibilityHint,
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

  const blocked = disabled || loading;

  const content = (
    <View style={styles.content}>
      {icon && !loading ? <View style={styles.icon}>{icon}</View> : null}
      <Text
        style={[styles.label, { color: labelColor }, loading && styles.labelHidden]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {loading ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <ActivityIndicator style={styles.spinner} color={labelColor} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={blocked}
        onPressIn={() => animate(motion.pressScale, motion.pressIn)}
        onPressOut={() => animate(1, motion.pressOut)}
        accessibilityRole="button"
        // `busy` is what a screen reader announces during a submit. Without it
        // the button simply goes quiet and sounds broken.
        accessibilityState={{ disabled: blocked, busy: loading }}
        {...(accessibilityHint ? { accessibilityHint } : {})}
        style={[styles.base, surface, blocked && styles.disabled]}
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
  // Hidden but still laid out, so the button keeps its width while loading.
  labelHidden: { opacity: 0 },
  spinner: { flex: 1 },
  disabled: { opacity: 0.45 },
});
