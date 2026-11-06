import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { USER_ACTIONS, type AdminAuditEntry, type UserAction } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { ChoiceGroup } from '../../src/components/ChoiceGroup';
import { EmptyState } from '../../src/components/EmptyState';
import { TextField } from '../../src/components/TextField';
import { AdminCard, AdminShell } from '../../src/admin/AdminChrome';
import { AuditRow } from '../../src/admin/AuditRow';
import { useAdmin } from '../../src/admin/AdminProvider';
import { expiresAtFromDate, MAX_STAFF_NOTE, userActionProblems } from '../../src/admin/adminAccess';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { spacing, typography } from '../../src/theme/tokens';

/**
 * A member's moderation history and account actions (review L1).
 *
 * Warn, suspend, ban, clear — each with a required written reason (the
 * database refuses a blank one: an unexplained ban cannot be appealed). The
 * history above the form is the audit trail for this member, newest first,
 * so the next moderator sees what was already done and why.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AdminUsers() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { handleError } = useAdmin();
  const params = useLocalSearchParams<{ userId?: string }>();
  const [lookup, setLookup] = useState(params.userId ?? '');
  const userId = params.userId && UUID.test(params.userId) ? params.userId : null;

  const [history, setHistory] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [action, setAction] = useState<UserAction | null>(null);
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [problems, setProblems] = useState<ReturnType<typeof userActionProblems>>({});
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      setHistory((await getClient().listAudit({ targetId: userId, limit: 50 })).items);
      setError(null);
    } catch (err) {
      if (!handleError(err)) setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [handleError, t, userId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submit = async () => {
    if (!userId) return;
    const next = userActionProblems({ action, reason, expiresAt: endDate });
    setProblems(next);
    if (Object.keys(next).length > 0 || action === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const expiresAt = expiresAtFromDate(endDate);
      const result = await getClient().actOnUser(userId, {
        action,
        reason: reason.trim(),
        ...(expiresAt ? { expiresAt } : {}),
      });
      setNotice(
        t('admin.users.done').replace('{{status}}', t(`admin.users.status.${result.status}`)),
      );
      setAction(null);
      setReason('');
      setEndDate('');
      await loadHistory();
    } catch (err) {
      if (!handleError(err)) setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell title={t('admin.area.users')} subtitle={t('admin.areaHint.users')}>
      <View style={styles.lookup}>
        <TextField
          label={t('admin.users.lookupLabel')}
          hint={t('admin.users.lookupHint')}
          value={lookup}
          onChangeText={setLookup}
          autoCapitalize="none"
          error={
            lookup.trim().length > 0 && !UUID.test(lookup.trim())
              ? t('admin.users.lookupInvalid')
              : undefined
          }
          testID="admin-user-lookup"
        />
        <Button
          label={t('admin.users.open')}
          variant="secondary"
          disabled={!UUID.test(lookup.trim())}
          onPress={() => router.setParams({ userId: lookup.trim() })}
        />
      </View>

      {error ? <Banner tone="error" message={error} /> : null}
      {notice ? <Banner tone="success" message={notice} /> : null}

      {userId ? (
        <>
          <Text style={[styles.heading, { color: theme.colors.text }]}>
            {t('admin.users.history')}
          </Text>
          {loading ? (
            <ActivityIndicator color={theme.colors.brand} />
          ) : history.length === 0 ? (
            <EmptyState icon="document-outline" title={t('admin.users.noHistory')} />
          ) : (
            history.map((entry) => <AuditRow key={entry.id} entry={entry} />)
          )}

          <AdminCard testID="admin-user-action">
            <Text style={[styles.heading, { color: theme.colors.text }]}>
              {t('admin.users.actionTitle')}
            </Text>
            <ChoiceGroup
              label={t('admin.users.actionLabel')}
              choices={USER_ACTIONS.map((a) => ({ value: a, label: t(`admin.users.action.${a}`) }))}
              value={action}
              onChange={(v) => setAction(v as UserAction)}
              error={problems.action ? t(problems.action) : undefined}
            />
            <TextField
              label={t('admin.users.reasonLabel')}
              hint={t('admin.users.reasonHint')}
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={MAX_STAFF_NOTE}
              error={problems.reason ? t(problems.reason) : undefined}
            />
            {action === 'suspend' ? (
              <TextField
                label={t('admin.users.endLabel')}
                hint={t('admin.users.endHint')}
                value={endDate}
                onChangeText={setEndDate}
                placeholder="YYYY-MM-DD"
                error={problems.expiresAt ? t(problems.expiresAt) : undefined}
              />
            ) : null}
            {action === 'ban' || action === 'suspend' ? (
              <Banner tone="info" message={t('admin.users.hidesEverywhere')} />
            ) : null}
            <Button
              label={t('admin.users.apply')}
              variant={action === 'ban' ? 'danger' : 'primary'}
              onPress={() => void submit()}
              loading={busy}
              testID="admin-user-apply"
            />
          </AdminCard>
        </>
      ) : null}
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  lookup: { gap: spacing.sm },
  heading: { ...typography.heading },
});
