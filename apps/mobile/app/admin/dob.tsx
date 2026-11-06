import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import type { AdminDobQueue } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { EmptyState } from '../../src/components/EmptyState';
import { AdminCard, AdminMeta, AdminShell, DecisionForm } from '../../src/admin/AdminChrome';
import { useQueue } from '../../src/admin/useQueue';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { typography } from '../../src/theme/tokens';

/**
 * Date-of-birth corrections (review B6, company decision 4). Support checks
 * the member's document outside the app, then decides here. Approval writes
 * the new date (the age gate still applies); the note is audited, and on a
 * rejection it is exactly what the member is shown.
 */

type Item = AdminDobQueue['items'][number];
const keyOf = (item: Item) => item.requestId;

export default function AdminDob() {
  const { t } = useLocale();
  const theme = useTheme();
  const load = useCallback(async () => (await getClient().listDobQueue(50)).items, []);
  const { items, loading, error, notice, act } = useQueue(load, keyOf);

  return (
    <AdminShell
      title={t('admin.area.dobCorrections')}
      subtitle={t('admin.areaHint.dobCorrections')}
    >
      <Banner tone="info" message={t('admin.dob.verifyOutside')} />
      {error ? <Banner tone="error" message={error} /> : null}
      {notice ? <Banner tone="success" message={notice} /> : null}
      {loading ? (
        <ActivityIndicator color={theme.colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState icon="checkmark-done-outline" title={t('admin.queueEmpty')} />
      ) : (
        items.map((item) => (
          <AdminCard key={item.requestId} testID={`admin-dob-${item.requestId}`}>
            <Text style={[styles.change, { color: theme.colors.text }]}>
              {`${item.currentDob ?? '—'}  →  ${item.requestedDob}`}
            </Text>
            <AdminMeta label={t('admin.meta.member')} value={item.userId} />
            <AdminMeta
              label={t('admin.meta.submitted')}
              value={new Date(item.createdAt).toLocaleString()}
            />
            <AdminMeta label={t('admin.dob.memberReason')} value={item.reason} />
            <DecisionForm
              area="dobCorrections"
              onSubmit={(value) =>
                act(
                  item,
                  () => getClient().decideDobCorrection(item.requestId, value),
                  t(`admin.decided.${value.decision}`),
                )
              }
            />
          </AdminCard>
        ))
      )}
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  change: { ...typography.heading },
});
