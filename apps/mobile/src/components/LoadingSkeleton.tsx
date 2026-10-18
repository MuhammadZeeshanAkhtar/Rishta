import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useReducedMotion } from '../theme/useReducedMotion';
import { radius, spacing } from '../theme/tokens';

/**
 * Loading placeholders.
 *
 * A PULSE, NOT A SHIMMER. A sweeping highlight means animating a gradient
 * across every block on screen, which on the low-end Android devices this
 * product targets is real fill-rate for no information. A slow opacity pulse
 * costs one native-driven value for the whole screen and reads just as clearly
 * as "this is loading, not broken".
 *
 * The skeletons mirror the real layout rather than being generic bars, so the
 * content does not jump when it arrives — the single thing that makes a list
 * feel cheap.
 */

function usePulse(): Animated.AnimatedInterpolation<number> {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // A loop is the hardest motion to tolerate: it never ends, and it is on
    // screen precisely while someone is waiting with nothing else to look at.
    // Reduced motion gets a flat block at the midpoint of the pulse, which
    // still reads as "not content yet".
    if (reduced) {
      value.setValue(0.5);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);

  return value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] });
}

export function SkeletonBlock({
  width,
  height,
  rounded = radius.sm,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  rounded?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const opacity = usePulse();

  return (
    <Animated.View
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: rounded,
          backgroundColor: theme.colors.surfaceSunken,
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Mirrors ProfileCard, so nothing shifts when the real card arrives. */
export function ProfileCardSkeleton() {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SkeletonBlock height={200} rounded={radius.lg} />
      <View style={styles.cardBody}>
        <SkeletonBlock width="55%" height={20} />
        <SkeletonBlock width="38%" height={14} />
        <View style={styles.row}>
          <SkeletonBlock width={88} height={26} rounded={radius.pill} />
          <SkeletonBlock width={72} height={26} rounded={radius.pill} />
        </View>
      </View>
    </View>
  );
}

/** Mirrors a row with an avatar — interests, matches, notifications. */
export function ListRowSkeleton() {
  return (
    <View
      style={styles.row}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SkeletonBlock width={48} height={48} rounded={radius.pill} />
      <View style={styles.rowBody}>
        <SkeletonBlock width="60%" height={16} />
        <SkeletonBlock width="40%" height={12} />
      </View>
    </View>
  );
}

export function SkeletonList({
  count = 3,
  variant = 'row',
}: {
  count?: number;
  variant?: 'row' | 'card';
}) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, i) =>
        variant === 'card' ? <ProfileCardSkeleton key={i} /> : <ListRowSkeleton key={i} />,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: {
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.md,
    overflow: 'hidden',
  },
  cardBody: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowBody: { flex: 1, gap: spacing.sm },
});
