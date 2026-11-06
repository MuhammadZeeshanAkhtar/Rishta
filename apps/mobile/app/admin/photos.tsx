import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, Text } from 'react-native';
import { PHOTO_REJECTION_REASONS, type AdminPhotoQueue } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { AdminCard, AdminMeta, AdminShell, DecisionForm } from '../../src/admin/AdminChrome';
import { useQueue } from '../../src/admin/useQueue';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { radius, typography } from '../../src/theme/tokens';

/**
 * Photo moderation queue (review B5/L1). Finalized, pending photos, oldest
 * first. The image is a short-lived URL signed with the MODERATOR's token,
 * which 0029's Storage policy allows only for an active moderator with a
 * second factor. A rejection carries the reason the member is shown.
 */

type Item = AdminPhotoQueue['items'][number];
const keyOf = (item: Item) => item.photoId;

export default function AdminPhotos() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const load = useCallback(async () => (await getClient().listPhotoQueue(50)).items, []);
  const { items, loading, error, notice, act } = useQueue(load, keyOf);

  return (
    <AdminShell title={t('admin.area.photos')} subtitle={t('admin.areaHint.photos')}>
      {error ? <Banner tone="error" message={error} /> : null}
      {notice ? <Banner tone="success" message={notice} /> : null}
      {loading ? (
        <ActivityIndicator color={theme.colors.brand} />
      ) : items.length === 0 ? (
        <EmptyState icon="checkmark-done-outline" title={t('admin.queueEmpty')} />
      ) : (
        items.map((item) => (
          <AdminCard key={item.photoId} testID={`admin-photo-${item.photoId}`}>
            {item.url ? (
              <Image
                source={{ uri: item.url }}
                style={[styles.image, { backgroundColor: theme.colors.surfaceSunken }]}
                resizeMode="contain"
                accessibilityLabel={t('admin.photos.imageAlt')}
              />
            ) : (
              <Text style={[styles.missing, { color: theme.colors.textMuted }]}>
                {t('admin.photos.noImage')}
              </Text>
            )}
            <AdminMeta label={t('admin.meta.member')} value={item.userId} />
            <AdminMeta
              label={t('admin.meta.submitted')}
              value={new Date(item.createdAt).toLocaleString()}
            />
            <Button
              label={t('admin.users.openHistory')}
              variant="ghost"
              onPress={() => router.push(`/admin/users?userId=${item.userId}`)}
            />
            <DecisionForm
              area="photos"
              reasons={PHOTO_REJECTION_REASONS}
              onSubmit={(value) =>
                act(
                  item,
                  () => getClient().decidePhoto(item.photoId, value),
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
  image: { width: '100%', height: 320, borderRadius: radius.md },
  missing: { ...typography.caption },
});
