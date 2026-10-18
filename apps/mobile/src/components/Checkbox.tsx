import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';

/**
 * A consent checkbox.
 *
 * The whole row is the target, not the 20dp box: consent that is hard to tick
 * is consent people tick by accident on the second try. `accessibilityRole`
 * is "checkbox" so it is announced as one and toggled with a screen reader's
 * activate gesture.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  error,
  testID,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  error?: boolean;
  testID?: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      testID={testID}
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={styles.row}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: error
              ? theme.colors.danger
              : checked
                ? theme.colors.brand
                : theme.colors.borderStrong,
            backgroundColor: checked ? theme.colors.brand : theme.colors.surface,
          },
        ]}
      >
        {checked ? <Text style={[styles.tick, { color: theme.colors.textOnBrand }]}>✓</Text> : null}
      </View>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.sm,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    // Nudged down so it sits on the first line of a wrapping label rather
    // than floating above it.
    marginTop: 2,
  },
  tick: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  label: { ...typography.body, flex: 1 },
});
