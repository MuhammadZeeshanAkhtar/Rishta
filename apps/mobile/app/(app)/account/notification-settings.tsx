import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { NotificationPreferences } from '@nikahmate/domain';
import { getClient } from '../../../src/api/client';
import { Banner } from '../../../src/components/Banner';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { describeError } from '../../../src/lib/errors';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { layout, spacing, typography } from '../../../src/theme/tokens';

/**
 * Which notifications appear in the app's inbox.
 *
 * Only the in-app switch is offered. The API stores push choices and quiet hours too,
 * but no push provider exists yet (L8), and a switch that changes nothing would be a
 * false promise, so those are kept as they are and sent back unchanged.
 *
 * Security alerts cannot be turned off, which the API also enforces.
 */
export default function NotificationSettingsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getClient()
      .getNotificationPreferences()
      .then((next) => {
        if (!cancelled) setPreferences(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, t).message);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const toggle = useCallback(
    async (type: string, inApp: boolean) => {
      if (!preferences) return;
      const next: NotificationPreferences = {
        ...preferences,
        types: preferences.types.map((item) => (item.type === type ? { ...item, inApp } : item)),
      };
      // Shown at once, and put back if the server refuses.
      setPreferences(next);
      setBusy(true);
      setError(null);
      try {
        setPreferences(await getClient().updateNotificationPreferences(next));
      } catch (err) {
        setPreferences(preferences);
        setError(describeError(err, t).message);
      } finally {
        setBusy(false);
      }
    },
    [preferences, t],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title={t('account.notificationsTitle')} fallback="/me" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>
          <Text style={[styles.intro, { color: theme.colors.textMuted }]}>
            {t('account.notificationsIntro')}
          </Text>
          {error ? <Banner tone="error" message={error} /> : null}
          {!preferences && !error ? (
            <ActivityIndicator color={theme.colors.brand} style={styles.spinner} />
          ) : null}
          {preferences?.types.map((item) => (
            <View key={item.type} style={[styles.row, { borderBottomColor: theme.colors.border }]}>
              <Text style={[styles.label, { color: theme.colors.text }]}>
                {t(`account.notificationType.${item.type}`)}
              </Text>
              <Switch
                value={item.inApp}
                disabled={busy || item.type === 'security_alert'}
                onValueChange={(next) => void toggle(item.type, next)}
                accessibilityLabel={t(`account.notificationType.${item.type}`)}
                testID={`notification-${item.type}`}
              />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.xs },
  intro: { ...typography.body, marginBottom: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { ...typography.body, flex: 1 },
  spinner: { marginTop: spacing.lg },
});
