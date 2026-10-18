import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';

/**
 * A labelled text input with hint and error handling in one place.
 *
 * Two things every screen would otherwise get wrong on its own:
 *
 *   - **Error identity.** The message is tied to the input through
 *     `accessibilityLabelledBy`-style labelling, so a screen reader announces
 *     *which* field is wrong rather than reading a stray line of red text.
 *   - **Reachability.** 48dp minimum, and the error never replaces the hint by
 *     shifting layout — both occupy the same slot.
 */

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  hint?: string;
  /** Localised, already-resolved message. Presence also marks the field invalid. */
  error?: string | undefined;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  secureTextEntry?: boolean;
  /** Adds a show/hide toggle. Only meaningful with `secureTextEntry`. */
  revealable?: boolean;
  multiline?: boolean;
  maxLength?: number;
  editable?: boolean;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  returnKeyType?: TextInputProps['returnKeyType'];
  style?: ViewStyle;
  testID?: string;
}

export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  placeholder,
  keyboardType,
  autoCapitalize = 'none',
  autoComplete,
  textContentType,
  secureTextEntry = false,
  revealable = false,
  multiline = false,
  maxLength,
  editable = true,
  onBlur,
  onSubmitEditing,
  returnKeyType,
  style,
  testID,
}: TextFieldProps) {
  const { t } = useLocale();
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.brand
      : theme.colors.border;

  return (
    <View style={[styles.root, style]}>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>

      <View
        style={[
          styles.inputWrap,
          {
            borderColor,
            backgroundColor: editable ? theme.colors.surface : theme.colors.surfaceSunken,
          },
          multiline && styles.inputWrapMultiline,
        ]}
      >
        <TextInput
          ref={inputRef}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSubtle}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          textContentType={textContentType}
          secureTextEntry={secureTextEntry && !revealed}
          multiline={multiline}
          maxLength={maxLength}
          editable={editable}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          accessibilityLabel={label}
          {...(hint || error ? { accessibilityHint: error ?? hint } : {})}
          // Announces the field as invalid, not merely red. Colour alone is not
          // an error state for anyone who cannot see it.
          accessibilityState={{ disabled: !editable }}
          style={[
            styles.input,
            {
              color: editable ? theme.colors.text : theme.colors.textMuted,
            },
            multiline && styles.inputMultiline,
          ]}
        />

        {secureTextEntry && revealable ? (
          <Pressable
            onPress={() => setRevealed((r) => !r)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? t('auth.hidePassword') : t('auth.showPassword')}
            hitSlop={spacing.sm}
            style={styles.reveal}
          >
            {/*
              Short visible label, full accessible name above. "Show password"
              rendered inline eats roughly a third of the field at 320dp and
              leaves barely any room to see what was typed.
            */}
            <Text style={[styles.revealText, { color: theme.colors.brand }]}>
              {revealed ? t('auth.hideShort') : t('auth.showShort')}
            </Text>
          </Pressable>
        ) : null}
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
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderRadius: radius.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  inputWrapMultiline: { alignItems: 'flex-start', paddingVertical: spacing.sm },
  input: { ...typography.body, flex: 1, paddingVertical: spacing.sm },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  reveal: { paddingVertical: spacing.xs },
  revealText: { ...typography.caption, fontWeight: '600' },
  message: { ...typography.caption },
});
