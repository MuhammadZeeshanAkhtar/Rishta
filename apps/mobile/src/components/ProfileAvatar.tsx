import { Image, StyleSheet, Text, type ImageStyle, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme/ThemeProvider';
import { radius, typography } from '../theme/tokens';

/**
 * A member's avatar, with a dignified fallback.
 *
 * THE FALLBACK IS THE NORMAL CASE, not an error state. Cross-user photo
 * delivery does not exist yet — the Storage policies are owner-scoped and this
 * app's API holds no service-role key — so every card in Discover renders this
 * today. It has to look deliberate rather than broken.
 *
 * So: an emerald gradient with the member's initial, not a grey silhouette. A
 * placeholder that looks like a missing image makes a real person look like
 * missing data, which is the wrong impression to give about someone who filled
 * in their profile.
 *
 * The gradient hue is derived from the user id, so the same person is the same
 * colour on every screen and in every session. Nothing random.
 */

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl' | 'hero';

const SIZES: Record<AvatarSize, number> = {
  sm: 36,
  md: 48,
  lg: 72,
  xl: 112,
  hero: 160,
};

/** Five emerald-to-gold grounds. Stable per user, never random. */
const GROUNDS: ReadonlyArray<readonly [string, string]> = [
  ['#065F46', '#047857'],
  ['#047857', '#059669'],
  ['#064E3B', '#065F46'],
  ['#065F46', '#0F766E'],
  ['#046A52', '#0D9488'],
];

function groundFor(seed: string): readonly [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return GROUNDS[hash % GROUNDS.length]!;
}

function initialOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return '·';
  // `codePointAt` rather than `[0]`, so a name starting with an emoji or a
  // surrogate pair does not render half a character.
  const first = String.fromCodePoint(trimmed.codePointAt(0) as number);
  return first.toUpperCase();
}

export interface ProfileAvatarProps {
  userId: string;
  displayName: string | null;
  /** Signed URL, when one exists. */
  uri?: string | null;
  size?: AvatarSize;
  /** Draws a soft ring — used on cards where the avatar sits on an image. */
  ringed?: boolean;
  /** A ViewStyle for the gradient fallback; the image branch narrows it. */
  style?: ViewStyle;
}

export function ProfileAvatar({
  userId,
  displayName,
  uri,
  size = 'md',
  ringed = false,
  style,
}: ProfileAvatarProps) {
  const theme = useTheme();
  const dimension = SIZES[size];
  const ring = ringed ? { borderWidth: 2, borderColor: theme.colors.surface } : null;
  const shape = { width: dimension, height: dimension, borderRadius: dimension / 2 };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[shape, ring, style as ImageStyle]}
        accessibilityIgnoresInvertColors
        accessible={false}
      />
    );
  }

  return (
    <LinearGradient
      colors={groundFor(userId)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[shape, styles.centre, ring, style]}
      // Decorative: the name is always rendered beside it, so announcing the
      // initial as well would read the same thing twice.
      accessible={false}
    >
      <Text
        style={[
          styles.initial,
          { fontSize: dimension * 0.4, lineHeight: dimension * 0.48, color: '#FFFFFF' },
        ]}
      >
        {initialOf(displayName)}
      </Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initial: { ...typography.display, fontWeight: '700', letterSpacing: 0 },
});

export const AVATAR_RADIUS = radius.pill;
