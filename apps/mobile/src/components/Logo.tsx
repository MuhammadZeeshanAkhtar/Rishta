import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';
import { emerald, gold } from '../theme/palette';
import { spacing, typography } from '../theme/tokens';

/**
 * The NikahMate mark.
 *
 * An eight-pointed star built from two overlapping squares — the khatim /
 * Rub el Hizb figure that runs through Islamic geometric art for a thousand
 * years. It is drawn here as exactly what it is: **two squares becoming one
 * form**, which is the product in a single shape.
 *
 * Why this and not a heart: a heart says romance and says it in the visual
 * language of dating apps. A geometric seal says permanence, craft and
 * seriousness, reads as international rather than regional, and carries the
 * union metaphor without sentimentality.
 *
 * Why it survives at 24dp: two solid shapes, two colours, no interior detail,
 * no thin strokes. The silhouette alone is recognisable — which is the only
 * test an app icon has to pass on a crowded home screen.
 *
 * Drawn from primitives, so there is no third-party asset and nothing to
 * license.
 */

export interface LogoProps {
  size?: number;
  /** `mark` is the icon alone; `wordmark` adds the name beneath it. */
  variant?: 'mark' | 'wordmark';
  /** `onBrand` inverts the mark for use on a brand-coloured background. */
  tone?: 'default' | 'onBrand';
}

export function Logo({ size = 48, variant = 'mark', tone = 'default' }: LogoProps) {
  const theme = useTheme();
  const onBrand = tone === 'onBrand';

  // 48-unit canvas. A 26-unit square leaves the rotated copy's corners at
  // 24 ± 18.4, so the star fits with a little breathing room at every size.
  const SIDE = 26;
  const ORIGIN = (48 - SIDE) / 2;
  const CORNER = 5;
  const INNER = SIDE * 0.58;
  const CORE = SIDE * 0.26;

  return (
    <View style={styles.container}>
      <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityRole="image">
        <Defs>
          <LinearGradient id="mark-brand" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={onBrand ? '#FFFFFF' : emerald[500]} />
            <Stop offset="1" stopColor={onBrand ? '#EAF5F2' : emerald[700]} />
          </LinearGradient>
        </Defs>

        {/* The second square: rotated 45°, gold. Its corners are the four
            points that turn a square into a star. */}
        <Rect
          x={ORIGIN}
          y={ORIGIN}
          width={SIDE}
          height={SIDE}
          rx={CORNER}
          fill={onBrand ? gold[300] : gold[500]}
          origin="24, 24"
          rotation={45}
        />

        {/* The first square, in front. */}
        <Rect
          x={ORIGIN}
          y={ORIGIN}
          width={SIDE}
          height={SIDE}
          rx={CORNER}
          fill={onBrand ? '#FFFFFF' : 'url(#mark-brand)'}
        />

        {/* The same figure again, smaller and inverted. Nesting is what turns
            two flat squares into a seal, and it is how the geometry works in
            the tilework this borrows from. It also keeps the mark legible
            small: the inner layers merge into one solid core rather than
            leaving an empty box. */}
        <Rect
          x={24 - INNER / 2}
          y={24 - INNER / 2}
          width={INNER}
          height={INNER}
          rx={INNER * 0.2}
          fill={onBrand ? emerald[700] : '#FFFFFF'}
          origin="24, 24"
          rotation={45}
        />

        <Rect
          x={24 - CORE / 2}
          y={24 - CORE / 2}
          width={CORE}
          height={CORE}
          rx={CORE * 0.22}
          fill={onBrand ? gold[300] : gold[500]}
        />
      </Svg>

      {variant === 'wordmark' ? (
        <Text
          style={[
            styles.wordmark,
            { color: onBrand ? theme.colors.textOnBrand : theme.colors.text },
          ]}
        >
          NikahMate
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  wordmark: {
    ...typography.title,
    marginTop: spacing.sm,
  },
});
