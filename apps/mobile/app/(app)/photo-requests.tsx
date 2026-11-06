import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PhotoRequest } from '@nikahmate/domain';
import { Banner } from '../../src/components/Banner';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { StatusBadge, type StatusTone } from '../../src/components/StatusBadge';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * Photo requests (review L3) — the ones you received and the ones you sent.
 *
 * Approving shares your BLURRED and ON-REQUEST photos in full with that one
 * member. It never shares a photo you set to private, and setting a photo
 * private later withdraws it again — the copy says so, because a privacy
 * control is only trustworthy if its limits are stated before it is used.
 */

type Direction = 'incoming' | 'outgoing';

const TONE: Record<PhotoRequest['status'], StatusTone> = {
  pending: 'warm',
  approved: 'success',
  declined: 'neutral',
  withdrawn: 'neutral',
};

export default function PhotoRequestsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [direction, setDirection] = useState<Direction>('incoming');
  const [items, setItems] = useState<PhotoRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await getClient().listPhotoRequests({ direction, limit: 50 });
      setItems(page.items);
      setError(null);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [direction, t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const respond = async (request: PhotoRequest, decision: 'approve' | 'decline') => {
    setBusy(request.id);
    setError(null);
    try {
      const updated = await getClient().respondToPhotoRequest(request.id, decision);
      setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
      ]}
    >
      <View style={styles.inner}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t('photoRequests.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          {t('photoRequests.subtitle')}
        </Text>

        <View accessibilityRole="tablist" style={styles.tabs}>
          {(['incoming', 'outgoing'] as const).map((d) => {
            const selected = d === direction;
            return (
              <Pressable
                key={d}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setDirection(d)}
                testID={`photo-requests-${d}`}
                style={[
                  styles.tab,
                  {
                    borderColor: selected ? theme.colors.brand : theme.colors.borderStrong,
                    backgroundColor: selected ? theme.colors.brandSurface : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.tabLabel,
                    { color: selected ? theme.colors.brandHover : theme.colors.textMuted },
                  ]}
                >
                  {t(`photoRequests.${d}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {direction === 'incoming' ? (
          <Banner tone="info" message={t('photoRequests.approveExplains')} />
        ) : null}
        {error ? <Banner tone="error" message={error} /> : null}

        {loading ? (
          <ActivityIndicator color={theme.colors.brand} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="images-outline"
            title={t(`photoRequests.empty.${direction}`)}
            body={t('photoRequests.emptyBody')}
          />
        ) : (
          items.map((request) => (
            <View
              key={request.id}
              style={[
                styles.card,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
              ]}
              testID={`photo-request-${request.id}`}
            >
              <Pressable
                accessibilityRole="link"
                onPress={() => router.push(`/(app)/profile/${request.counterpart.userId}`)}
                style={styles.who}
              >
                <Text style={[styles.name, { color: theme.colors.text }]}>
                  {request.counterpart.displayName ?? t('profile.someone')}
                </Text>
                <StatusBadge
                  label={t(`photoRequests.status.${request.status}`)}
                  tone={TONE[request.status]}
                />
              </Pressable>
              {request.message ? (
                <Text style={[styles.message, { color: theme.colors.textMuted }]}>
                  “{request.message}”
                </Text>
              ) : null}
              {direction === 'incoming' && request.status === 'pending' ? (
                <View style={styles.actions}>
                  <Button
                    label={t('photoRequests.decline')}
                    variant="secondary"
                    onPress={() => void respond(request, 'decline')}
                    disabled={busy !== null}
                    testID={`photo-request-decline-${request.id}`}
                  />
                  <Button
                    label={t('photoRequests.approve')}
                    onPress={() => void respond(request, 'approve')}
                    loading={busy === request.id}
                    disabled={busy !== null}
                    testID={`photo-request-approve-${request.id}`}
                  />
                </View>
              ) : null}
            </View>
          ))
        )}

        <Button label={t('common.back')} variant="ghost" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  title: { ...typography.display },
  subtitle: { ...typography.body },
  tabs: { flexDirection: 'row', gap: spacing.sm },
  tab: {
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: MIN_TOUCH_TARGET - 8,
    justifyContent: 'center',
  },
  tabLabel: { ...typography.bodyStrong },
  card: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  who: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET - 8,
  },
  name: { ...typography.heading, flexShrink: 1 },
  message: { ...typography.body, fontStyle: 'italic' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap' },
});
