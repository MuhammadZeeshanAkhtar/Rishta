import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ReferenceType } from '@nikahmate/domain';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { useReference } from '../reference/useReference';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../theme/tokens';
import { TextField } from './TextField';

/**
 * Picks one or many values from a coded list.
 *
 * A full-screen sheet rather than an inline dropdown: the longest list here is
 * ~68 countries, and a native picker on a 320dp screen is a scroll trap. The
 * sheet gets a search box once the list is long enough to need one.
 *
 * Labels come from the API already translated, so this never contains a
 * display string of its own.
 */

export function ReferenceSelect({
  label,
  type,
  value,
  onChange,
  multiple = false,
  hint,
  error,
  placeholder,
  testID,
}: {
  label: string;
  type: ReferenceType;
  /** A code for single select, a list of codes for multiple. */
  value: string | string[] | null;
  onChange: (next: string & string[]) => void;
  multiple?: boolean;
  hint?: string;
  error?: string | undefined;
  placeholder?: string;
  testID?: string;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const { items, loading, error: loadError, reload } = useReference(type);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(() => (Array.isArray(value) ? value : value ? [value] : []), [value]);

  const summary = useMemo(() => {
    if (selected.length === 0) return placeholder ?? t('common.notStated');
    const labels = selected
      .map((code) => items.find((i) => i.code === code)?.label ?? code)
      .filter(Boolean);
    // Two names then a count: "Pakistan, United Kingdom +3". Listing all of
    // them wraps to four lines and pushes the rest of the form off screen.
    return labels.length <= 2
      ? labels.join(', ')
      : `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
  }, [selected, items, placeholder, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const toggle = (code: string) => {
    if (multiple) {
      const next = selected.includes(code)
        ? selected.filter((c) => c !== code)
        : [...selected, code];
      onChange(next as string & string[]);
    } else {
      onChange(code as string & string[]);
      setOpen(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>

      <Pressable
        testID={testID}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: summary }}
        style={[
          styles.field,
          {
            borderColor: error ? theme.colors.danger : theme.colors.border,
            backgroundColor: theme.colors.surface,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.value,
            {
              color: selected.length > 0 ? theme.colors.text : theme.colors.textSubtle,
            },
          ]}
        >
          {loading && selected.length === 0 ? t('common.loading') : summary}
        </Text>
      </Pressable>

      {error ? (
        <Text accessibilityRole="alert" style={[styles.message, { color: theme.colors.danger }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.message, { color: theme.colors.textSubtle }]}>{hint}</Text>
      ) : null}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>{label}</Text>
            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={spacing.md}
            >
              <Text style={[styles.close, { color: theme.colors.brand }]}>{t('common.done')}</Text>
            </Pressable>
          </View>

          {items.length > 12 ? (
            <View style={styles.search}>
              <TextField
                label={t('common.search')}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
              />
            </View>
          ) : null}

          {loadError ? (
            <View style={styles.centre}>
              <Text style={[styles.message, { color: theme.colors.textMuted }]}>
                {t('errors.network')}
              </Text>
              <Pressable onPress={reload} accessibilityRole="button" style={styles.retry}>
                <Text style={[styles.close, { color: theme.colors.brand }]}>
                  {t('common.retry')}
                </Text>
              </Pressable>
            </View>
          ) : loading ? (
            <View style={styles.centre}>
              <ActivityIndicator
                color={theme.colors.brand}
                accessibilityLabel={t('a11y.loading')}
              />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
              {filtered.map((item) => {
                const isSelected = selected.includes(item.code);
                return (
                  <Pressable
                    key={item.code}
                    onPress={() => toggle(item.code)}
                    accessibilityRole={multiple ? 'checkbox' : 'radio'}
                    accessibilityState={{ selected: isSelected, checked: isSelected }}
                    accessibilityLabel={item.label}
                    testID={`${testID ?? type}-option-${item.code}`}
                    style={[
                      styles.option,
                      {
                        borderColor: isSelected ? theme.colors.brand : theme.colors.border,
                        backgroundColor: isSelected
                          ? theme.colors.brandSurface
                          : theme.colors.surface,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionLabel,
                        {
                          color: isSelected ? theme.colors.brandHover : theme.colors.text,
                        },
                      ]}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.xs },
  label: { ...typography.bodyStrong },
  field: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  value: { ...typography.body },
  message: { ...typography.caption },
  sheet: { flex: 1, paddingTop: spacing.xxl },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  sheetTitle: { ...typography.title, flex: 1 },
  close: { ...typography.bodyStrong },
  search: { paddingHorizontal: layout.gutter, paddingBottom: spacing.md },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  retry: { padding: spacing.md },
  list: { paddingHorizontal: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.sm },
  option: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  optionLabel: { ...typography.body },
});
