import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FIELD_VISIBILITIES,
  LOCATION_PRECISIONS,
  VISIBILITY_FIELD_KEYS,
  type FieldVisibilityMap,
} from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { PhotoManager } from '../../src/photos/PhotoManager';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * Privacy Center — photos and per-field visibility in one place.
 *
 * Together rather than apart because they answer the same question: what can
 * other people see about me. Splitting them across two screens would mean
 * someone could tighten their photos and never discover that their workplace
 * is public.
 *
 * Saving is per-field rather than behind a Save button. A privacy control that
 * needs a second confirming tap is one people leave half-applied, and the
 * server is the source of truth either way.
 */

/** `about_me` cannot be hidden entirely, and location is a precision choice. */
function optionsFor(key: string): readonly string[] {
  if (key === 'location_precision') return LOCATION_PRECISIONS;
  if (key === 'about_me') return ['public', 'matched_only'];
  return FIELD_VISIBILITIES;
}

export default function PrivacyScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [visibility, setVisibility] = useState<FieldVisibilityMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setVisibility(await getClient().getFieldVisibility());
      setError(null);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (key: string, value: string) => {
    const previous = visibility;
    // Optimistic: the control moves immediately, and reverts if the server
    // refuses. On a slow connection a privacy toggle that lags feels broken.
    setVisibility({ ...visibility, [key]: value } as FieldVisibilityMap);
    setSaving(key);
    setError(null);
    try {
      setVisibility(
        await getClient().updateFieldVisibility({ [key]: value } as FieldVisibilityMap),
      );
    } catch (err) {
      setVisibility(previous);
      setError(describeError(err, t).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
      ]}
    >
      <View style={styles.inner}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t('privacy.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          {t('privacy.subtitle')}
        </Text>

        {error ? <Banner tone="error" message={error} /> : null}

        <PhotoManager />

        <View style={styles.divider} />

        <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          {t('privacy.fieldsTitle')}
        </Text>
        <Text style={[styles.hint, { color: theme.colors.textSubtle }]}>
          {t('privacy.fieldsHint')}
        </Text>

        {VISIBILITY_FIELD_KEYS.map((key) => (
          <View
            key={key}
            style={[
              styles.field,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <Text style={[styles.fieldLabel, { color: theme.colors.text }]}>
              {t(`privacy.field.${key}`)}
            </Text>

            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={t(`privacy.field.${key}`)}
              style={styles.options}
            >
              {optionsFor(key).map((option) => {
                const selected = visibility[key] === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => void change(key, option)}
                    disabled={saving !== null}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, busy: saving === key }}
                    accessibilityLabel={t(`privacy.value.${option}`)}
                    testID={`visibility-${key}-${option}`}
                    style={[
                      styles.option,
                      {
                        borderColor: selected ? theme.colors.brand : theme.colors.borderStrong,
                        backgroundColor: selected ? theme.colors.brandSurface : 'transparent',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionLabel,
                        { color: selected ? theme.colors.brandHover : theme.colors.textMuted },
                      ]}
                    >
                      {t(`privacy.value.${option}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        <Button label={t('common.back')} variant="ghost" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display },
  subtitle: { ...typography.body, marginBottom: spacing.sm },
  divider: { height: spacing.lg },
  sectionTitle: { ...typography.overline },
  hint: { ...typography.caption, marginBottom: spacing.sm },
  field: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  fieldLabel: { ...typography.bodyStrong },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  option: {
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET - 12,
    justifyContent: 'center',
  },
  optionLabel: { ...typography.caption, fontWeight: '600' },
});
