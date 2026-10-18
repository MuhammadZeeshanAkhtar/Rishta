import { Animated, Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { useEntrance } from '../theme/useEntrance';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * The top of a profile. The first thing anyone sees, on both the owner's
 * profile and someone else's.
 *
 * PHOTO-FIRST, WITH A FALLBACK THAT IS NOT A FAILURE. A profile that opens on
 * a grey silhouette makes a real person look like missing data. So the
 * no-photo state is a deep emerald ground with a gold monogram and the same
 * typography — a designed state, not a hole. It has to be: cross-user photo
 * delivery does not exist yet, so on someone else's profile the fallback is
 * the ONLY state, and the owner's own profile is the only place a real
 * photograph appears today.
 *
 * THE SCRIM IS BOTTOM-WEIGHTED. White text over a photograph needs a ground,
 * but darkening the whole frame darkens the face. Transparent at the top,
 * near-opaque at the bottom: the name sits on colour, the portrait does not.
 *
 * WHAT GOES ON IT. Name, age · place, one line of profession, and at most one
 * pill. That is the "quick impression" — enough to know who this is and
 * whether to read on. Faith, education and the rest are sections below;
 * putting them here would turn the one calm part of the screen into a summary
 * of the whole page.
 *
 * ENTRANCE. The frame fades and settles while the text rises slightly behind
 * it — about a third of a second, native-driven. Any longer and it is in the
 * way of someone who opened the screen to read something.
 */

export interface ProfileHeroProps {
  /** Stable seed for the fallback ground, so one person is one colour everywhere. */
  userId: string;
  displayName: string | null;
  /** Already-formatted: "27 · Pakistan". The hero does not assemble strings. */
  meta: string | null;
  /** One line. Profession, or the nearest thing to it. */
  tagline?: string | null;
  /** Signed URL for the primary photo, when one exists. */
  photoUri?: string | null;
  /** Top-right slot — a compatibility badge on someone else's profile. */
  badge?: React.ReactNode;
  /** A single pill under the name. Verified, or profile complete. */
  pill?: { label: string; icon?: keyof typeof Ionicons.glyphMap } | null;
  /** Rendered over the hero at the top-left — a back control. */
  leading?: React.ReactNode;
  /** Extra top padding for the status bar. */
  insetTop?: number;
  style?: ViewStyle;
  testID?: string;
}

/** Five emerald grounds, chosen by user id. Matches ProfileAvatar's set. */
const GROUNDS: ReadonlyArray<readonly [string, string]> = [
  ['#03291F', '#065F46'],
  ['#064E3B', '#047857'],
  ['#03291F', '#0F766E'],
  ['#065F46', '#059669'],
  ['#064E3B', '#046A52'],
];

function groundFor(seed: string): readonly [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return GROUNDS[hash % GROUNDS.length]!;
}

function monogramOf(name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return '·';
  // `codePointAt`, so a name beginning with a surrogate pair does not render
  // as half a character.
  return String.fromCodePoint(trimmed.codePointAt(0) as number).toUpperCase();
}

export function ProfileHero({
  userId,
  displayName,
  meta,
  tagline,
  photoUri,
  badge,
  pill,
  leading,
  insetTop = 0,
  style,
  testID,
}: ProfileHeroProps) {
  const theme = useTheme();

  // Index 0: the hero leads, and the sections below stagger after it.
  const entrance = useEntrance(0);

  const rise = entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });

  return (
    <Animated.View style={[styles.frame, theme.shadow.raised, { opacity: entrance }, style]}>
      {photoUri ? (
        <Image
          source={{ uri: photoUri }}
          style={StyleSheet.absoluteFill}
          // `cover` so a portrait fills the frame without distortion. The frame
          // is 4:5-ish, which is the shape phone cameras actually produce.
          resizeMode="cover"
          accessibilityIgnoresInvertColors
          accessible={false}
        />
      ) : (
        <LinearGradient
          colors={groundFor(userId)}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFill}
        >
          {/* Confined to the upper band, NOT centred in the frame. Centred, it
              lands exactly where a two-line name sits and the two collide —
              which is what happened the first time this was built. */}
          <View style={styles.monogramBand} pointerEvents="none">
            <Text style={styles.monogram} accessible={false}>
              {monogramOf(displayName)}
            </Text>
          </View>
        </LinearGradient>
      )}

      {/* Bottom-weighted, so white text holds without dimming the face. */}
      <LinearGradient
        colors={['rgba(3,41,31,0.34)', 'rgba(3,41,31,0.06)', 'rgba(3,41,31,0.86)']}
        locations={[0, 0.38, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {leading ? (
        <View style={[styles.leading, { top: insetTop + spacing.sm }]}>{leading}</View>
      ) : null}
      {badge ? <View style={[styles.badge, { top: insetTop + spacing.md }]}>{badge}</View> : null}

      <Animated.View
        style={[styles.identity, { transform: [{ translateY: rise }] }]}
        testID={testID}
      >
        <Text style={styles.name} numberOfLines={2}>
          {displayName ?? '—'}
        </Text>

        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}

        {tagline ? (
          <Text style={styles.tagline} numberOfLines={1}>
            {tagline}
          </Text>
        ) : null}

        {pill ? (
          <View style={styles.pill}>
            {pill.icon ? <Ionicons name={pill.icon} size={13} color="#E5C76B" /> : null}
            <Text style={styles.pillLabel} numberOfLines={1}>
              {pill.label}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: {
    // Tall enough to read as a portrait rather than a banner, short enough
    // that the first section is visible under it at 320×568.
    height: 380,
    borderRadius: radius.xl,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    backgroundColor: '#064E3B',
  },
  // The top 58% of the frame. The identity block occupies the bottom, and a
  // name long enough to wrap to two lines reaches roughly the 62% mark.
  monogramBand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '58%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogram: {
    fontSize: 104,
    lineHeight: 120,
    fontWeight: '700',
    letterSpacing: -2,
    // Gold, held back to a watermark. At full strength it competes with the
    // name for the eye, and the name has to win.
    color: '#E5C76B',
    opacity: 0.5,
  },
  leading: { position: 'absolute', left: spacing.sm },
  badge: { position: 'absolute', right: spacing.md },
  identity: { padding: spacing.xl, gap: 3 },
  name: { ...typography.display, color: '#FFFFFF' },
  meta: { ...typography.bodyStrong, color: 'rgba(255,255,255,0.92)' },
  tagline: { ...typography.body, color: 'rgba(255,255,255,0.76)' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 1,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  pillLabel: {
    ...typography.caption,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
});
