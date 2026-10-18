import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, spacing, typography } from '../theme/tokens';

/**
 * A form-level message: the failure that belongs to the whole submission
 * rather than to one field.
 *
 * `accessibilityLiveRegion` matters more than it looks. Without it a screen
 * reader says nothing when a sign-in fails — the user hears silence and
 * assumes the button did not work, then taps again.
 */

export type BannerTone = 'error' | 'success' | 'info';

export function Banner({ tone, message }: { tone: BannerTone; message: string }) {
  const theme = useTheme();

  const palette = {
    error: { bg: theme.colors.dangerSurface, fg: theme.colors.danger },
    success: { bg: theme.colors.brandSurface, fg: theme.colors.brandHover },
    info: { bg: theme.colors.surfaceSunken, fg: theme.colors.textMuted },
  }[tone];

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.root, { backgroundColor: palette.bg }]}
    >
      <Text style={[styles.text, { color: palette.fg }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  text: { ...typography.body },
});
