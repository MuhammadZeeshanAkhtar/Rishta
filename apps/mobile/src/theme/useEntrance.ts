import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { motion } from './tokens';
import { useReducedMotion } from './useReducedMotion';

/**
 * The staggered entrance used by cards, sections and tiles.
 *
 * ONE COPY, because there were five. `ProfileCard`, `SectionCard`,
 * `ProfileHighlights`, `ProfileStatusCard` and `ProfileHero` each carried the
 * same `useRef(new Animated.Value(...))` plus effect, with slightly different
 * durations and delays that nobody chose — they drifted. Worse, adding reduced
 * motion to five near-identical blocks is five chances to miss one, and the
 * one missed is the one that makes someone ill.
 *
 * `index` controls the stagger and is capped by `motion.staggerCap`, so the
 * eighth card is not still animating when a reader reaches it. Omit it for an
 * element that should simply appear.
 *
 * REDUCED MOTION SKIPS TO THE END — it does not merely shorten. A faster
 * animation is still an animation. The value starts at 1, no timing runs, and
 * the caller's interpolations resolve to their resting state.
 */
export function useEntrance(index?: number): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(index === undefined ? 1 : 0)).current;

  useEffect(() => {
    if (index === undefined) return;

    if (reduced) {
      // Already in place. No animation is started, so there is nothing to
      // interrupt if the setting is switched on mid-entrance.
      value.setValue(1);
      return;
    }

    const animation = Animated.timing(value, {
      toValue: 1,
      duration: motion.entrance,
      delay: Math.min(index, motion.staggerCap) * motion.stagger,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [index, reduced, value]);

  return value;
}

/**
 * The press-scale pair shared by every pressable surface.
 *
 * Returns the animated value and the two handlers. Under reduced motion the
 * handlers are no-ops and the value stays at 1 — the control still works and
 * still shows its own colour/opacity feedback, it simply does not move. Tap
 * feedback itself is never removed: `pro-rules` requires a visible response
 * within 80-150ms, and that obligation does not depend on motion settings.
 */
export function usePressScale(): {
  scale: Animated.Value;
  onPressIn: () => void;
  onPressOut: () => void;
} {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  const to = (value: number, duration: number) => () => {
    if (reduced) return;
    Animated.timing(scale, { toValue: value, duration, useNativeDriver: true }).start();
  };

  return {
    scale,
    onPressIn: to(motion.pressScale, motion.pressIn),
    onPressOut: to(1, motion.pressOut),
  };
}
