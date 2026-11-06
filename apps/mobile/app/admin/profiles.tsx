import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { PROFILE_REJECTION_REASONS, type AdminProfileQueue } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { AdminCard, AdminMeta, AdminShell, DecisionForm } from '../../src/admin/AdminChrome';
import { useQueue } from '../../src/admin/useQueue';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { typography } from '../../src/theme/tokens';

/**
 * Profile moderation queue (review B6/L1). Only the free text a moderator
 * judges, and the name — the API sends no contact details, date of birth or
 * location, so there is nothing more here to leak.
 */

type Item = AdminProfileQueue['items'][number];
const keyOf = (item: Item) => item.userId;

export default function AdminProfiles() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const load = useCallback(async () => (await getClient().listProfileQueue(50)).items, []);
  const { items, loading, error, notice, act } = useQueue(load, keyOf);

  const field = (label: string, value: string | null) =>
    value ? (
      <Text style={[styles.field, { color: theme.colors.text }]}>
        <Text style={{ fontWeight: '600' }}>{label}: </Text>
        {value}
      </Text>
    ) : null;

  return (
    <AdminShell title={t('admin.area.profiles')} subtitle={t('admin.areaHint.profiles')}>
      {error ? <Banner tone="error" message={error} /> : null}
      {notice ? <Banner tone="success" message={notice} /> : null}
      {loading ? (
        <ActivityIndicator color={theme.colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState icon="checkmark-done-outline" title={t('admin.queueEmpty')} />
      ) : (
        items.map((item) => (
          <AdminCard key={item.userId} testID={`admin-profile-${item.userId}`}>
            <Text style={[styles.name, { color: theme.colors.text }]}>
              {item.displayName ?? item.userId}
            </Text>
            <AdminMeta
              label={t('admin.meta.submitted')}
              value={new Date(item.submittedAt).toLocaleString()}
            />
            {field(t('profile.aboutMe'), item.aboutMe)}
            {field(t('profile.lookingFor'), item.lookingFor)}
            {field(t('profile.institution'), item.institution)}
            {field(t('profile.familyBackground'), item.familyBackground)}
            <Button
              label={t('admin.users.openHistory')}
              variant="ghost"
              onPress={() => router.push(`/admin/users?userId=${item.userId}`)}
            />
            <DecisionForm
              area="profiles"
              reasons={PROFILE_REJECTION_REASONS}
              onSubmit={(value) =>
                act(
                  item,
                  () => getClient().decideProfile(item.userId, value),
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
  name: { ...typography.heading },
  field: { ...typography.body },
});
