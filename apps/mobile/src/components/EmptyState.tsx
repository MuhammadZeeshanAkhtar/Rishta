import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import { useTheme } from '../theme/ThemeProvider';
import { layout, radius, spacing, typography } from '../theme/tokens';

/**
 * Empty and error states.
 *
 * TWO DIFFERENT THINGS, deliberately one component with a `tone`, because the
 * failure mode is showing the wrong one: "no one matches you yet" when the
 * request actually failed is the most demoralising message this product could
 * send, and it is one `catch` away. Keeping both here forces the caller to say
 * which it is.
 *
 * Empty states carry an action wherever one exists. "Nothing here" with no way
 * forward is a dead end; "nothing here, widen your preferences" is a next step.
 */

export interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body?: string;
  tone?: 'empty' | 'error';
  actionLabel?: string;
  onAction?: () => void;
  style?: ViewStyle;
}

export function EmptyState({
  icon = 'sparkles-outline',
  title,
  body,
  tone = 'empty',
  actionLabel,
  onAction,
  style,
}: EmptyStateProps) {
  const theme = useTheme();
  const isError = tone === 'error';

  return (
    <View style={[styles.root, style]}>
      <LinearGradient
        colors={
          isError
            ? [theme.colors.dangerSurface, theme.colors.surface]
            : [theme.colors.brandSurface, theme.colors.surface]
        }
        style={styles.halo}
      >
        <Ionicons
          name={isError ? 'cloud-offline-outline' : icon}
          size={30}
          color={isError ? theme.colors.danger : theme.colors.brand}
        />
      </LinearGradient>

      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: theme.colors.textMuted }]}>{body}</Text> : null}

      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          variant={isError ? 'primary' : 'secondary'}
          onPress={onAction}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: layout.gutter,
    gap: spacing.md,
  },
  halo: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.title, textAlign: 'center' },
  body: { ...typography.body, textAlign: 'center', maxWidth: 320 },
  action: { marginTop: spacing.sm, minWidth: 200 },
});
