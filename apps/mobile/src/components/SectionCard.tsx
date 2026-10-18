import { Animated, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { useEntrance } from '../theme/useEntrance';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * A section of a profile, as a card.
 *
 * ONE CARD PER SECTION, NOT PER FIELD. The failure mode this is built against
 * is a screen of eight cards each holding one value, which costs a whole
 * screen of scrolling to say very little. Faith is one card; the four things
 * it contains are chips inside it.
 *
 * THE ICON IS THE SECTION'S IDENTITY. Scrolling a long profile, the eye finds
 * a section by its mark long before it reads the heading — so the mark has to
 * be consistent per section across every profile, which is why callers pass a
 * fixed icon rather than choosing per render.
 *
 * ENTRANCE IS STAGGERED AND CAPPED. A short rise as the card arrives, delayed
 * by position so the page assembles rather than appearing all at once; capped
 * at six so the eighth section is not still animating when someone reaches it.
 * Native-driven, so it stays smooth while the screen is still fetching.
 */

export interface SectionCardProps {
  title: string;
  /** One line under the title. Says what the section is for, never repeats it. */
  subtitle?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Staggered entrance index. Omit for no animation. */
  index?: number;
  /** Rendered on the heading row, trailing — a count, a state. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

export function SectionCard({
  title,
  subtitle,
  icon,
  index,
  trailing,
  children,
  style,
  testID,
}: SectionCardProps) {
  const theme = useTheme();

  const entrance = useEntrance(index);

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.card,
        theme.shadow.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
        style,
      ]}
    >
      <View style={styles.head}>
        {icon ? (
          <View style={[styles.mark, { backgroundColor: theme.colors.brandSurface }]}>
            <Ionicons name={icon} size={17} color={theme.colors.brand} />
          </View>
        ) : null}
        <View style={styles.headText}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
          ) : null}
        </View>
        {trailing ?? null}
      </View>

      <View style={styles.body}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  mark: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `flexShrink` as well as `flex`: a long section title at 320dp must wrap
  // rather than push the trailing slot off the card.
  headText: { flex: 1, flexShrink: 1, gap: 1 },
  title: { ...typography.heading },
  subtitle: { ...typography.caption },
  body: { gap: spacing.md },
});
