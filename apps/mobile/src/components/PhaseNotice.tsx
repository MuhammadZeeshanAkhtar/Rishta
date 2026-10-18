import { StyleSheet, Text } from 'react-native';
import { Card, CardHeading } from './Card';
import { useTheme } from '../theme/ThemeProvider';
import { spacing, typography } from '../theme/tokens';

/**
 * Marks a screen as an empty shell.
 *
 * Phase 1 builds navigation, not features. Saying so on the screen keeps the
 * app honest to anyone opening it, rather than implying something works.
 */
export function PhaseNotice({ phase, feature }: { phase: string; feature: string }) {
  const theme = useTheme();

  return (
    <Card tone="sunken" style={styles.card}>
      <CardHeading overline={phase} title="Not built yet" />
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>{feature}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: spacing.md },
  body: { ...typography.body, marginTop: spacing.sm },
});
