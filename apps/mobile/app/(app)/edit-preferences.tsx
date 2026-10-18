import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Preferences } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { usePreferencesForm } from '../../src/profile/PreferencesForm';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { layout, spacing, typography } from '../../src/theme/tokens';

/**
 * Edit partner preferences after onboarding.
 *
 * The same fields as onboarding step 5, from the same hook — so "what I chose
 * during sign-up" and "what I can change later" are one implementation rather
 * than two that drift.
 *
 * Ownership is never asserted here. The PUT goes to `/me/preferences`, which
 * resolves the caller from the verified JWT; there is no user id in the
 * request for a client to tamper with, and RLS scopes the row regardless.
 */
export default function EditPreferencesScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { fields, collect } = usePreferencesForm(preferences);

  useEffect(() => {
    void (async () => {
      try {
        setPreferences(await getClient().getPreferences());
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const submit = async () => {
    const patch = collect();
    setSaved(false);
    if (!patch) return;

    setSaving(true);
    setError(null);
    try {
      setPreferences(await getClient().updatePreferences(patch));
      setSaved(true);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setSaving(false);
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
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inner}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{t('preferences.title')}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {t('onboarding.preferencesSubtitle')}
          </Text>

          {error ? <Banner tone="error" message={error} /> : null}
          {saved ? <Banner tone="success" message={t('onboarding.savedDraft')} /> : null}

          {fields}

          <Button
            label={t('common.save')}
            onPress={() => void submit()}
            loading={saving}
            testID="edit-preferences-save"
          />
          <Button label={t('common.back')} variant="ghost" onPress={() => router.back()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.lg },
  title: { ...typography.display },
  subtitle: { ...typography.body },
});
