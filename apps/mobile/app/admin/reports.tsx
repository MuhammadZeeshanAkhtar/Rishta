import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { REPORT_STATUSES, type AdminReportQueue, type ReportStatus } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { EmptyState } from '../../src/components/EmptyState';
import { TextField } from '../../src/components/TextField';
import { AdminCard, AdminMeta, AdminShell } from '../../src/admin/AdminChrome';
import { MAX_STAFF_NOTE, MIN_STAFF_NOTE } from '../../src/admin/adminAccess';
import { useQueue } from '../../src/admin/useQueue';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { spacing, typography } from '../../src/theme/tokens';

/**
 * Reports — the moderation cases (review L1). Triage, action or dismiss, with
 * a written note for the audit; actioning or dismissing tells the reporter in
 * general terms. Account action on the reported member is a separate,
 * deliberate step in Members.
 */

type Item = AdminReportQueue['items'][number];
const keyOf = (item: Item) => item.reportId;
const OUTCOMES = [
  'report.actioned',
  'report.no_violation',
  'report.insufficient_evidence',
] as const;

export default function AdminReports() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const [status, setStatus] = useState<ReportStatus>('open');
  const load = useCallback(
    async () => (await getClient().listReportQueue(status, 50)).items,
    [status],
  );
  const { items, loading, error, notice, act } = useQueue(load, keyOf);

  return (
    <AdminShell title={t('admin.area.reports')} subtitle={t('admin.areaHint.reports')}>
      <ChoiceGroup
        label={t('admin.reports.filter')}
        choices={REPORT_STATUSES.map((s) => ({ value: s, label: t(`admin.reports.status.${s}`) }))}
        value={status}
        onChange={(v) => setStatus(v as ReportStatus)}
      />
      {error ? <Banner tone="error" message={error} /> : null}
      {notice ? <Banner tone="success" message={notice} /> : null}
      {loading ? (
        <ActivityIndicator color={theme.colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState icon="checkmark-done-outline" title={t('admin.queueEmpty')} />
      ) : (
        items.map((item) => (
          <AdminCard key={item.reportId} testID={`admin-report-${item.reportId}`}>
            <Text style={[styles.category, { color: theme.colors.text }]}>{item.category}</Text>
            {item.description ? (
              <Text style={[styles.body, { color: theme.colors.text }]}>{item.description}</Text>
            ) : null}
            <AdminMeta label={t('admin.reports.reported')} value={item.reportedUserId} />
            <AdminMeta label={t('admin.reports.reporter')} value={item.reporterUserId} />
            {item.contextType ? (
              <AdminMeta
                label={t('admin.reports.context')}
                value={`${item.contextType} ${item.contextId ?? ''}`}
              />
            ) : null}
            <AdminMeta
              label={t('admin.meta.submitted')}
              value={new Date(item.createdAt).toLocaleString()}
            />
            <Button
              label={t('admin.reports.actOnMember')}
              variant="ghost"
              onPress={() => router.push(`/admin/users?userId=${item.reportedUserId}`)}
            />
            {item.status === 'open' || item.status === 'triaged' ? (
              <ReportDecisionForm
                current={item.status}
                onSubmit={(next) =>
                  act(
                    item,
                    () => getClient().updateReport(item.reportId, next),
                    t('admin.reports.updated'),
                  )
                }
              />
            ) : null}
          </AdminCard>
        ))
      )}
    </AdminShell>
  );
}

function ReportDecisionForm({
  current,
  onSubmit,
}: {
  current: ReportStatus;
  onSubmit: (value: {
    status: 'triaged' | 'actioned' | 'dismissed';
    outcomeKey?: string;
    note: string;
  }) => Promise<void>;
}) {
  const { t } = useLocale();
  const [next, setNext] = useState<'triaged' | 'actioned' | 'dismissed' | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (['triaged', 'actioned', 'dismissed'] as const).filter((s) => s !== current);

  const submit = async () => {
    const trimmed = note.trim();
    if (next === null) return setProblem(t('admin.decision.chooseOne'));
    if (trimmed.length < MIN_STAFF_NOTE) return setProblem(t('admin.decision.noteRequired'));
    setProblem(null);
    setBusy(true);
    try {
      await onSubmit({
        status: next,
        note: trimmed,
        ...(outcome && next !== 'triaged' ? { outcomeKey: outcome } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <ChoiceGroup
        label={t('admin.reports.moveTo')}
        choices={options.map((s) => ({ value: s, label: t(`admin.reports.status.${s}`) }))}
        value={next}
        onChange={(v) => setNext(v as 'triaged' | 'actioned' | 'dismissed')}
      />
      {next === 'actioned' || next === 'dismissed' ? (
        <ChoiceGroup
          label={t('admin.reports.outcome')}
          choices={OUTCOMES.map((o) => ({
            value: o,
            label: t(`admin.reports.outcomes.${o.split('.')[1]}`),
          }))}
          value={outcome}
          onChange={setOutcome}
        />
      ) : null}
      <TextField
        label={t('admin.decision.noteLabel')}
        hint={t('admin.decision.noteHint')}
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={MAX_STAFF_NOTE}
        error={problem ?? undefined}
      />
      <Button label={t('admin.decision.submit')} onPress={() => void submit()} loading={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  category: { ...typography.heading },
  body: { ...typography.body },
  form: { gap: spacing.md },
});
