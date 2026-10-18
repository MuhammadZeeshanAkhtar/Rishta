import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { useEntrance } from '../theme/useEntrance';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * The quick impression: three or four facts, immediately under the hero.
 *
 * WHY A GRID AND NOT A LIST. This sits between the photograph and the reading
 * matter, and its whole job is to be absorbed without reading — education,
 * work, place, faith, in one glance, before anyone decides whether to scroll.
 * A vertical list of the same four facts takes the same space and demands four
 * separate acts of attention.
 *
 * TWO COLUMNS, FIXED. Three would be 86dp per tile at 320dp, which cannot hold
 * "Bachelor's degree" at an enlarged font size without clipping. Two columns
 * hold two lines of real text at every size this product supports.
 *
 * SMALL TILES, NOT BOXES. A caption above a short value, a muted icon, a
 * hairline border and no shadow. These are supporting facts; giving them
 * elevation would make them compete with the sections that carry the substance.
 *
 * THE CALLER DECIDES WHAT MATTERS. This renders what it is handed and silently
 * drops anything with no value, so a sparse profile gets a shorter grid rather
 * than tiles reading "Not added yet" — which is the fastest way to make a
 * profile feel empty.
 */

export interface Highlight {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** The fact. Two lines at most. */
  value: string | null;
  /** What the fact is. Two or three words. */
  caption: string;
}

export function ProfileHighlights({
  items,
  /** Staggered entrance base index, shared with the sections below. */
  index,
}: {
  items: readonly Highlight[];
  index?: number;
}) {
  const present = items.filter((item): item is Highlight & { value: string } =>
    Boolean(item.value),
  );

  const entrance = useEntrance(index);

  if (present.length === 0) return null;

  return (
    <Animated.View
      style={[
        styles.grid,
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
      ]}
    >
      {present.map((item) => (
        <Tile key={item.key} item={item} />
      ))}
    </Animated.View>
  );
}

function Tile({ item }: { item: Highlight & { value: string } }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.tile,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
      // One announcement per tile — "Education, Bachelor's degree" — instead of
      // the caption and value arriving as two separate stops.
      accessible
      accessibilityLabel={`${item.caption}: ${item.value}`}
    >
      {/* Icon beside the caption rather than above it. Stacked, each tile ran
          to about 105dp and four of them pushed the first real section off a
          320×568 screen — a "quick impression" you have to scroll for is not
          one. */}
      <View style={styles.tileHead}>
        <Ionicons name={item.icon} size={15} color={theme.colors.brand} />
        <Text
          style={[styles.caption, { color: theme.colors.textSubtle }]}
          numberOfLines={1}
          // Shrinks before it clips: "Compatibility" is longer than "Work".
          adjustsFontSizeToFit={false}
        >
          {item.caption}
        </Text>
      </View>
      <Text style={[styles.value, { color: theme.colors.text }]} numberOfLines={2}>
        {item.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    // NOT `width: '48%'`. The gap is absolute while the width is a percentage,
    // so two 48% tiles plus a 12dp gap came to 280.8dp inside 280dp of content
    // at 320 — eight tenths of a pixel over, which wrapped every tile onto its
    // own row and turned the grid into a list.
    //
    // A zero basis that grows, floored at 128, holds two columns from 320dp
    // up: 128 + 128 + 12 = 268 fits, and a third would need 408.
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 128,
    gap: spacing.xs + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  caption: { ...typography.overline, letterSpacing: 0.5, flexShrink: 1 },
  value: { ...typography.bodyStrong },
});
