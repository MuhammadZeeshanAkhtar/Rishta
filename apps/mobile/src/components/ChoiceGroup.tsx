import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';

/**
 * A small set of mutually exclusive choices, shown as chips.
 *
 * Used where a dropdown would be heavier than the question deserves — gender,
 * yes/no, a handful of codes. Announced as radios so a screen reader conveys
 * "one of these", which a row of buttons does not.
 */

export interface Choice {
  value: string;
  label: string;
}

export function ChoiceGroup({
  label,
  hint,
  error,
  choices,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  choices: readonly Choice[];
  value: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.root} testID={testID}>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>

      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.row}>
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              key={choice.value}
              onPress={() => !disabled && onChange(choice.value)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={choice.label}
              testID={`${testID ?? 'choice'}-${choice.value}`}
              style={[
                styles.chip,
                {
                  borderColor: error
                    ? theme.colors.danger
                    : selected
                      ? theme.colors.brand
                      : theme.colors.borderStrong,
                  backgroundColor: selected ? theme.colors.brandSurface : theme.colors.surface,
                },
                disabled && styles.disabled,
              ]}
            >
              <Text
                style={[
                  styles.chipLabel,
                  { color: selected ? theme.colors.brandHover : theme.colors.text },
                ]}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <Text accessibilityRole="alert" style={[styles.message, { color: theme.colors.danger }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.message, { color: theme.colors.textSubtle }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.xs },
  label: { ...typography.bodyStrong },
  row: { flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  chipLabel: { ...typography.bodyStrong },
  disabled: { opacity: 0.5 },
  message: { ...typography.caption },
});
