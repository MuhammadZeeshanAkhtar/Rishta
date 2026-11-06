import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Report } from '@nikahmate/domain';
import { getClient } from '../../../src/api/client';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { EmptyState } from '../../../src/components/EmptyState';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { StatusBadge, type StatusTone } from '../../../src/components/StatusBadge';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { describeError } from '../../../src/lib/errors';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { layout, spacing, typography } from '../../../src/theme/tokens';

const TONE: Record<Report['status'], StatusTone> = {
  open: 'warm',
  triaged: 'warm',
  actioned: 'success',
  dismissed: 'neutral',
};

/**
 * Reports this member has filed, and where each stands. The API tells a reporter the
 * outcome by notification (ERD §14), which needs somewhere to lead. Says nothing about
 * what happened to the other person.
 */
export default function ReportsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const [items, setItems] = useState<Report[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await getClient().listMyReports(after ? { cursor: after } : {});
        setItems((list) => (after ? [...list, ...page.items] : page.items));
        setCursor(page.hasMore ? page.nextCursor : null);
        setError(null);
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title={t('account.reportsTitle')} fallback="/me" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>
          {error ? <Banner tone="error" message={error} /> : null}
          {items.map((report) => (
            <View
              key={report.id}
              style={[styles.row, { borderBottomColor: theme.colors.border }]}
              testID={`report-${report.id}`}
            >
              <View style={styles.main}>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                  {t(`safety.category.${report.category}`)}
                </Text>
                <Text style={[styles.date, { color: theme.colors.textMuted }]}>
                  {new Date(report.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <StatusBadge
                label={t(`account.reportStatus.${report.status}`)}
                tone={TONE[report.status]}
              />
            </View>
          ))}
          {loading ? <ActivityIndicator color={theme.colors.brand} style={styles.spinner} /> : null}
          {!loading && !error && items.length === 0 ? (
            <EmptyState
              icon="flag-outline"
              title={t('account.reportsEmptyTitle')}
              body={t('account.reportsEmptyBody')}
            />
          ) : null}
          {cursor && !loading ? (
            <Button
              label={t('common.loadMore')}
              variant="ghost"
              onPress={() => void load(cursor)}
            />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1, gap: spacing.xs },
  title: { ...typography.bodyStrong },
  date: { ...typography.caption },
  spinner: { marginTop: spacing.lg },
});
