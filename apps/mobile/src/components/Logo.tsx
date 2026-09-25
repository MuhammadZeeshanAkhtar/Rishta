import { Image, StyleSheet, Text, View } from 'react-native';
import SYMBOL from '../../assets/logo-symbol.png';
import { useTheme } from '../theme/ThemeProvider';
import { gold, neutral } from '../theme/palette';
import { spacing } from '../theme/tokens';

/**
 * The NikahMate mark.
 *
 * The symbol — a heart formed from two interlocking ribbons, one emerald and
 * one gold, beneath a crescent and star, with the N monogram held inside — is
 * the supplied brand artwork. It ships as a raster because that is what it is:
 * `docs/brand/source/` holds the original, and
 * `scripts/build-brand-assets.py` derives every asset from it.
 *
 * The wordmark is live text rather than part of the image. That keeps it crisp
 * at any size, lets it take the theme, and puts the two-tone treatment
 * (Nikah in the neutral, Mate in gold) in one place instead of in an export.
 */

/** The symbol is slightly taller than it is wide; preserve that ratio. */
const SYMBOL_ASPECT = 512 / 538;

export type LogoTone = 'light' | 'dark' | 'mono';
export type LogoVariant = 'symbol' | 'horizontal' | 'stacked';

export interface LogoProps {
  size?: number;
  /** `symbol` is the mark alone; the others add the wordmark. */
  variant?: LogoVariant;
  /** `light` for light UI, `dark` for brand grounds, `mono` for single-colour use. */
  tone?: LogoTone;
}

export function Logo({ size = 48, variant = 'symbol', tone = 'light' }: LogoProps) {
  const theme = useTheme();
  const horizontal = variant === 'horizontal';

  const mark = (
    <Image
      source={SYMBOL}
      style={{ width: size * SYMBOL_ASPECT, height: size }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="NikahMate"
    />
  );

  if (variant === 'symbol') return mark;

  // On a brand ground the first word is warm white; on light UI it takes the
  // text colour. Mono drops the accent entirely.
  const primary = tone === 'dark' ? neutral[25] : theme.colors.text;
  const accent = tone === 'mono' ? primary : gold[500];

  const fontSize = size * (horizontal ? 0.42 : 0.36);

  const wordmark = (
    <Text style={[styles.wordmark, { fontSize, lineHeight: fontSize * 1.28 }]}>
      <Text style={{ color: primary }}>Nikah</Text>
      <Text style={{ color: accent }}>Mate</Text>
    </Text>
  );

  return (
    <View style={horizontal ? styles.horizontal : styles.stacked}>
      {mark}
      {wordmark}
    </View>
  );
}

const styles = StyleSheet.create({
  horizontal: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stacked: { alignItems: 'center', gap: spacing.md },
  wordmark: {
    // The system sans — SF on iOS, Roboto on Android. Both are modern and
    // international, and neither costs a font file or a dependency. Slightly
    // negative tracking at weight 700 is what makes a wordmark read as set
    // rather than typed.
    fontWeight: '700',
    letterSpacing: -0.5,
  },
});
