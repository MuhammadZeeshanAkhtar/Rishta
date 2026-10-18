import { useCallback, useState } from 'react';
import { LayoutAnimation, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, typography } from '../theme/tokens';

/**
 * Long prose, with a way in.
 *
 * A 1,500-character "about me" rendered in full is a wall that gets skipped,
 * and the person who wrote it is the one who loses. Four lines and a "More"
 * gets read.
 *
 * COLLAPSED BY MEASUREMENT, NOT BY CHARACTER COUNT. `numberOfLines` lets the
 * platform decide where four lines end, which is the only thing that is right
 * at every font scale — a character budget tuned at the default size clips
 * mid-word for anyone who has enlarged their type, which is a large share of
 * the audience for a product people read carefully.
 *
 * THE TOGGLE ONLY APPEARS WHEN IT IS NEEDED. `onTextLayout` reports the lines
 * the platform actually laid out, so a three-line introduction gets no "More"
 * to press. A control that does nothing is worse than no control.
 */

export interface ExpandableTextProps {
  text: string;
  /** Lines shown while collapsed. */
  collapsedLines?: number;
  moreLabel: string;
  lessLabel: string;
  testID?: string;
}

/**
 * Roughly how much text fits in one line of this component's body style.
 *
 * Only ever used as a fallback, and deliberately generous: showing a "More"
 * that reveals one extra line is a small oddity, whereas hiding one over text
 * that IS clipped leaves the reader at a dead end with an ellipsis.
 */
const CHARS_PER_LINE = 38;

export function ExpandableText({
  text,
  collapsedLines = 4,
  moreLabel,
  lessLabel,
  testID,
}: ExpandableTextProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [measured, setMeasured] = useState(false);

  // Seeded from a character estimate, then corrected by the real measurement.
  //
  // `onTextLayout` is a native-only callback: on react-native-web it never
  // fires, so a component that waited for it showed four clipped lines, an
  // ellipsis and NO way to expand — which is worse than not collapsing at all.
  // The estimate makes the control appear everywhere; the measurement makes it
  // correct where it is available.
  const [overflows, setOverflows] = useState(() => text.length > collapsedLines * CHARS_PER_LINE);

  const onTextLayout = useCallback(
    (event: { nativeEvent: { lines: ReadonlyArray<unknown> } }) => {
      // Fires on every layout, including after expanding — by which point the
      // line count is the FULL count and would answer the wrong question. Only
      // the first, collapsed measurement is meaningful.
      if (measured) return;
      setMeasured(true);
      setOverflows(event.nativeEvent.lines.length > collapsedLines);
    },
    [collapsedLines, measured],
  );

  const toggle = useCallback(() => {
    // Android needs the experimental flag for LayoutAnimation and silently
    // does nothing without it; on iOS this is a no-op. Either way the text
    // still toggles, so the animation is polish rather than a dependency.
    if (Platform.OS === 'ios') {
      LayoutAnimation.configureNext({
        duration: 220,
        update: { type: 'easeInEaseOut', property: 'opacity' },
      });
    }
    setExpanded((value) => !value);
  }, []);

  return (
    <View testID={testID}>
      <Text
        style={[styles.body, { color: theme.colors.text }]}
        numberOfLines={expanded ? undefined : collapsedLines}
        onTextLayout={onTextLayout}
      >
        {text}
      </Text>

      {overflows ? (
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={styles.toggle}
          // The text itself is only four lines tall when collapsed, so the
          // toggle gets the slop instead of growing the layout.
          hitSlop={{ top: 8, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={[styles.toggleLabel, { color: theme.colors.brand }]}>
            {expanded ? lessLabel : moreLabel}
          </Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={theme.colors.brand}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // A touch more leading than `body`: this is the one place on the screen
  // someone reads several sentences rather than scanning a value.
  body: { ...typography.body, lineHeight: 25 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  toggleLabel: { ...typography.caption, fontWeight: '700' },
});
