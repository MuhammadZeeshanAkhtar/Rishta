import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import type { AdminAuditEntry } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { EmptyState } from '../../src/components/EmptyState';
import { AdminShell } from '../../src/admin/AdminChrome';
import { useAdmin } from '../../src/admin/AdminProvider';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { AuditRow } from '../../src/admin/AuditRow';

/**
 * The audit trail (review L1, ERD §17): every staff decision, by whom and
 * why, newest first. Append-only in the database for every role — this
 * screen only reads it.
 */

const TARGETS = ['all', 'user', 'profile', 'photo', 'report'] as const;

export default function AdminAudit() {
  const { t } = useLocale();
  const theme = useTheme();
  const { handleError } = useAdmin();
  const [target, setTarget] = useState<(typeof TARGETS)[number]>('all');
  const [items, setItems] = useState<AdminAuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await getClient().listAudit({
          ...(target === 'all' ? {} : { targetType: target }),
          ...(after ? { cursor: after } : {}),
          limit: 25,
        });
        setItems((current) => (after ? [...current, ...page.items] : page.items));
        setCursor(page.hasMore ? page.nextCursor : null);
        setError(null);
      } catch (err) {
        if (!handleError(err)) setError(describeError(err, t).message);
      } finally {
        setLoading(false);
      }
    },
    [handleError, t, target],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminShell title={t('admin.area.audit')} subtitle={t('admin.areaHint.audit')}>
      <ChoiceGroup
        label={t('admin.audit.filter')}
        choices={TARGETS.map((x) => ({ value: x, label: t(`admin.audit.targets.${x}`) }))}
        value={target}
        onChange={(v) => setTarget(v as (typeof TARGETS)[number])}
      />
      {error ? <Banner tone="error" message={error} /> : null}
      {items.length === 0 && !loading ? (
        <EmptyState icon="document-outline" title={t('admin.audit.empty')} />
      ) : null}
      {items.map((entry) => (
        <AuditRow key={entry.id} entry={entry} />
      ))}
      {loading ? <ActivityIndicator color={theme.colors.brand} /> : null}
      {cursor && !loading ? (
        <Button
          label={t('admin.audit.more')}
          variant="secondary"
          onPress={() => void load(cursor)}
        />
      ) : null}
    </AdminShell>
  );
}
