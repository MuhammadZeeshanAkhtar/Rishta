import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the person has asked their device for less motion.
 *
 * WHY THIS EXISTS. Nine components in this app animate on mount — cards rise,
 * heroes fade, chips scale under a finger, a progress bar fills. None of them
 * asked permission. iOS "Reduce Motion" and Android "Remove animations" are
 * accessibility settings people turn on for vestibular disorders, migraine and
 * motion sickness, and an app that ignores them can make someone physically
 * unwell.
 *
 * That matters more here than in most products. NikahMate is used by a wide
 * age range making a serious decision, often slowly and carefully, scrolling a
 * long profile. Staggered entrances down a list are exactly the pattern that
 * triggers it.
 *
 * SUBSCRIBED, NOT READ ONCE. The setting can be changed while the app is open
 * — someone who starts feeling unwell turns it on mid-session, and that is the
 * moment it most needs to take effect. The listener is removed on unmount.
 *
 * WHAT CALLERS SHOULD DO WITH IT. Not "animate faster": skip to the final
 * state. A shorter animation is still an animation. Opacity-only changes are
 * generally tolerated where movement is not, so a caller may keep a fade and
 * drop the translation — but the default should be to arrive already there.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;

    // The initial read is async and can resolve after unmount on a slow
    // device, so the result is gated rather than set blindly.
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value: boolean) => {
        if (active) setReduced(value);
      },
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
