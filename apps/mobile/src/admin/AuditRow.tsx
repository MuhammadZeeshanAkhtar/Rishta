import { StyleSheet, Text } from 'react-native';
import type { AdminAuditEntry } from '@nikahmate/domain';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { AdminCard, AdminMeta } from './AdminChrome';

/** One audit entry: what was done, when, by whom, to what, and why (review L1). */
export function AuditRow({ entry }: { entry: AdminAuditEntry }) {
  const { t } = useLocale();
  const theme = useTheme();
  return (
    <AdminCard testID={`admin-audit-${entry.id}`}>
      <Text style={[styles.action, { color: theme.colors.text }]}>{entry.action}</Text>
      <AdminMeta label={t('admin.audit.when')} value={new Date(entry.createdAt).toLocaleString()} />
      <AdminMeta
        label={t('admin.audit.by')}
        value={entry.actor.displayName ?? entry.actor.adminUserId}
      />
      <AdminMeta label={t('admin.audit.target')} value={`${entry.targetType} ${entry.targetId}`} />
      {entry.reason ? <AdminMeta label={t('admin.audit.reason')} value={entry.reason} /> : null}
    </AdminCard>
  );
}

const styles = StyleSheet.create({
  action: { ...typography.bodyStrong },
});
