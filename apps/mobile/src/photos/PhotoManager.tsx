import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  MAX_PHOTOS_PER_USER,
  PHOTO_VISIBILITIES,
  type OwnPhoto,
  type PhotoVisibility,
} from '@nikahmate/domain';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { useLocale } from '../i18n/LocaleProvider';
import { useTheme } from '../theme/ThemeProvider';
import { getClient } from '../api/client';
import { describeError } from '../lib/errors';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../theme/tokens';

/**
 * Upload, order and privacy for the member's own photos.
 *
 * The upload is three steps, and each is a separate round trip on purpose:
 * reserve a slot, PUT the bytes straight to storage, then finalize. The API
 * never carries the image, which keeps a 10MB file off the request path.
 *
 * Nothing here is visible to anyone else yet. Photos are owner-only until the
 * reveal flow exists, and every tier below is a statement of intent that takes
 * effect when Discover does.
 */
export function PhotoManager() {
  const { t } = useLocale();
  const theme = useTheme();

  const [photos, setPhotos] = useState<OwnPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPhotos(await getClient().listPhotos());
      setError(null);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickAndUpload = async () => {
    // Permission first, and a refusal is a normal answer rather than an error:
    // someone may simply not want to grant library access today.
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(t('photos.permissionDenied'));
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [3, 4],
      quality: 0.85,
    });
    if (picked.canceled || !picked.assets[0]) return;

    const asset = picked.assets[0];
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(asset.uri);
      const blob = await response.blob();

      const client = getClient();
      const target = await client.createPhotoUploadTarget({
        contentType: 'image/jpeg',
        byteSize: blob.size,
      });
      await client.uploadPhotoBytes(target, blob);
      // Variants and moderation happen here. Until it returns, the photo has
      // no usable URL at all.
      await client.finalizePhoto(target.photoId);
      await load();
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (photo: OwnPhoto) => {
    Alert.alert(t('photos.deleteTitle'), t('photos.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('photos.delete'),
        style: 'destructive',
        onPress: () => void act(() => getClient().deletePhoto(photo.id)),
      },
    ]);
  };

  const move = (index: number, delta: number) => {
    const next = [...photos];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    void act(() => getClient().reorderPhotos(next.map((p) => p.id)));
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.colors.brand} accessibilityLabel={t('a11y.loading')} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
        {t('photos.title')}
      </Text>
      <Text style={[styles.hint, { color: theme.colors.textSubtle }]}>
        {t('photos.privateByDefault')}
      </Text>

      {error ? <Banner tone="error" message={error} /> : null}

      {photos.length === 0 ? (
        <View style={[styles.empty, { borderColor: theme.colors.border }]}>
          <Text style={[styles.emptyText, { color: theme.colors.textMuted }]}>
            {t('photos.emptyState')}
          </Text>
        </View>
      ) : null}

      {photos.map((photo, index) => (
        <View
          key={photo.id}
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <View style={styles.cardTop}>
            {photo.urls.thumb ? (
              <Image
                source={{ uri: photo.urls.thumb }}
                style={styles.thumb}
                accessibilityIgnoresInvertColors
                accessibilityLabel={t('photos.thumbAlt')}
              />
            ) : (
              <View style={[styles.thumb, { backgroundColor: theme.colors.surfaceSunken }]} />
            )}

            <View style={styles.cardBody}>
              {photo.isPrimary ? (
                <Text style={[styles.badge, { color: theme.colors.brandHover }]}>
                  {t('photos.primary')}
                </Text>
              ) : null}
              <Text
                style={[
                  styles.status,
                  {
                    color:
                      photo.moderationStatus === 'approved'
                        ? theme.colors.textMuted
                        : photo.moderationStatus === 'rejected'
                          ? theme.colors.danger
                          : theme.colors.accent,
                  },
                ]}
              >
                {t(`photos.moderation.${photo.moderationStatus}`)}
              </Text>

              <View style={styles.rowButtons}>
                <Pressable
                  onPress={() => move(index, -1)}
                  disabled={index === 0 || busy}
                  accessibilityRole="button"
                  accessibilityLabel={t('photos.moveUp')}
                  style={[styles.iconButton, { borderColor: theme.colors.border }]}
                >
                  <Text style={{ color: theme.colors.text }}>↑</Text>
                </Pressable>
                <Pressable
                  onPress={() => move(index, 1)}
                  disabled={index === photos.length - 1 || busy}
                  accessibilityRole="button"
                  accessibilityLabel={t('photos.moveDown')}
                  style={[styles.iconButton, { borderColor: theme.colors.border }]}
                >
                  <Text style={{ color: theme.colors.text }}>↓</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* Visibility tiers. `blurred` serves a separate pre-blurred file. */}
          <View style={styles.tiers}>
            {PHOTO_VISIBILITIES.map((tier) => {
              const selected = photo.visibility === tier;
              return (
                <Pressable
                  key={tier}
                  onPress={() =>
                    void act(() =>
                      getClient().updatePhoto(photo.id, { visibility: tier as PhotoVisibility }),
                    )
                  }
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={t(`photos.visibility.${tier}`)}
                  style={[
                    styles.tier,
                    {
                      borderColor: selected ? theme.colors.brand : theme.colors.borderStrong,
                      backgroundColor: selected ? theme.colors.brandSurface : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.tierLabel,
                      { color: selected ? theme.colors.brandHover : theme.colors.textMuted },
                    ]}
                  >
                    {t(`photos.visibility.${tier}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.cardActions}>
            {!photo.isPrimary ? (
              <Button
                label={t('photos.makePrimary')}
                variant="ghost"
                onPress={() =>
                  void act(() => getClient().updatePhoto(photo.id, { isPrimary: true }))
                }
                disabled={busy}
                style={styles.flex}
              />
            ) : null}
            <Button
              label={t('photos.delete')}
              variant="danger"
              onPress={() => confirmDelete(photo)}
              disabled={busy}
              style={styles.flex}
              testID={`photo-delete-${photo.id}`}
            />
          </View>
        </View>
      ))}

      <Button
        label={t('photos.add')}
        variant="secondary"
        onPress={() => void pickAndUpload()}
        loading={busy}
        disabled={photos.length >= MAX_PHOTOS_PER_USER}
        testID="photos-add"
      />
      {photos.length >= MAX_PHOTOS_PER_USER ? (
        <Text style={[styles.hint, { color: theme.colors.textSubtle }]}>
          {t('photos.limitReached').replace('{{max}}', String(MAX_PHOTOS_PER_USER))}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  centre: { paddingVertical: spacing.xxl, alignItems: 'center' },
  sectionTitle: { ...typography.overline },
  hint: { ...typography.caption },
  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyText: { ...typography.body, textAlign: 'center' },
  card: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.md },
  cardTop: { flexDirection: 'row', gap: spacing.md },
  thumb: { width: 72, height: 96, borderRadius: radius.sm },
  cardBody: { flex: 1, gap: spacing.xs },
  badge: { ...typography.overline },
  status: { ...typography.caption },
  rowButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: 'auto' },
  iconButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET - 8,
    borderWidth: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tiers: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tier: {
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tierLabel: { ...typography.caption, fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
});
