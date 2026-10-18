import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { AppNotification } from '@nikahmate/domain';
import { EmptyState } from '../../src/components/EmptyState';
import { SkeletonList } from '../../src/components/LoadingSkeleton';
import { useLocale } from '../../src/i18n/LocaleProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { getClient } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../src/theme/tokens';

/**
 * The notification inbox.
 *
 * COPY COMES FROM THE CATALOG. The API sends `titleKey` and `bodyKey`, never
 * prose — so the wording lives in one place and the server never hardcodes a
 * sentence. This screen is the only thing that turns a key into words.
 *
 * NO AVATARS HERE, and that is deliberate rather than an omission. The payload
 * carries identifiers only, so rendering the actor would mean a profile fetch
 * per row — N+1 requests for decoration, on the screen most likely to be
 * opened on a poor connection. The row is tappable and the profile is one tap
 * away, where it is fetched once and with its visibility rules applied.
 */

const PAGE_SIZE = 20;

export default function NotificationsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      try {
        const page = await getClient().listNotifications({ limit: PAGE_SIZE });
        setItems(page.items);
        setUnreadCount(page.unreadCount);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setError(null);
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !cursor) return;
    try {
      const page = await getClient().listNotifications({ cursor, limit: PAGE_SIZE });
      setItems((previous) => {
        const seen = new Set(previous.map((n) => n.id));
        return [...previous, ...page.items.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setHasMore(false);
    }
  }, [cursor, hasMore]);

  /** Optimistic: the dot clears on tap, and comes back if the server refuses. */
  const markRead = useCallback(async (notification: AppNotification) => {
    if (notification.readAt) return;
    const now = new Date().toISOString();
    setItems((list) => list.map((n) => (n.id === notification.id ? { ...n, readAt: now } : n)));
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await getClient().markNotificationRead(notification.id);
    } catch {
      setItems((list) => list.map((n) => (n.id === notification.id ? { ...n, readAt: null } : n)));
      setUnreadCount((count) => count + 1);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const previous = items;
    const previousCount = unreadCount;
    const now = new Date().toISOString();
    setItems((list) => list.map((n) => ({ ...n, readAt: n.readAt ?? now })));
    setUnreadCount(0);
    try {
      await getClient().markAllNotificationsRead();
    } catch (err) {
      setItems(previous);
      setUnreadCount(previousCount);
      setError(describeError(err, t).message);
    }
  }, [items, t, unreadCount]);

  /**
   * Where a notification leads.
   *
   * Derived from the payload's identifiers rather than stored as a URL: a link
   * written when the notification was created would outlive the thing it
   * points at.
   */
  const open = useCallback(
    (notification: AppNotification) => {
      void markRead(notification);
      const data = notification.data as Record<string, string | undefined>;
      if (notification.type === 'new_match') router.push('/(app)/(tabs)/messages');
      else if (notification.type === 'interest_received') router.push('/(app)/(tabs)/interests');
      else if (notification.type === 'interest_accepted' && data.actorUserId) {
        router.push(`/(app)/profile/${data.actorUserId}`);
      }
    },
    [markRead, router],
  );

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + spacing.lg }]}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        style={styles.back}
      >
        <Ionicons name="chevron-back" size={24} color={theme.colors.text} />
      </Pressable>
      <Text style={[styles.title, { color: theme.colors.text }]}>{t('notifications.title')}</Text>
      {unreadCount > 0 ? (
        <Pressable
          onPress={() => void markAllRead()}
          accessibilityRole="button"
          style={styles.markAll}
        >
          <Text style={[styles.markAllText, { color: theme.colors.brand }]}>
            {t('notifications.markAllRead')}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.back} />
      )}
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        {header}
        <View style={styles.pad}>
          <SkeletonList count={5} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      {header}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <NotificationItem notification={item} onPress={() => open(item)} />
        )}
        ListEmptyComponent={
          error ? (
            <EmptyState
              tone="error"
              title={t('discovery.errorTitle')}
              body={t('discovery.errorBody')}
              actionLabel={t('discovery.retry')}
              onAction={() => void load('refresh')}
            />
          ) : (
            <EmptyState
              icon="notifications-outline"
              title={t('notifications.emptyTitle')}
              body={t('notifications.emptyBody')}
            />
          )
        }
        contentContainerStyle={[
          styles.pad,
          { paddingBottom: insets.bottom + spacing.xxl },
          items.length === 0 && styles.empty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.brand}
            colors={[theme.colors.brand]}
          />
        }
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

/**
 * One notification row.
 *
 * Unread is carried by THREE signals, not one: a tinted surface, a brand dot,
 * and a heavier title. Colour alone would be invisible to a colourblind reader
 * and in bright sunlight, which is where a phone usually is.
 */
function NotificationItem({
  notification,
  onPress,
}: {
  notification: AppNotification;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { t } = useLocale();
  const unread = notification.readAt === null;

  const icon: keyof typeof Ionicons.glyphMap =
    notification.type === 'new_match'
      ? 'heart'
      : notification.type === 'interest_accepted'
        ? 'checkmark-circle'
        : notification.type === 'security_alert'
          ? 'shield-checkmark'
          : 'mail-outline';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t(notification.titleKey)}. ${t(notification.bodyKey)}${
        unread ? `. ${t('notifications.unread')}` : ''
      }`}
      style={[
        styles.item,
        {
          backgroundColor: unread ? theme.colors.brandSurface : theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={[styles.itemIcon, { backgroundColor: theme.colors.surface }]}>
        <Ionicons name={icon} size={18} color={theme.colors.brand} />
      </View>

      <View style={styles.itemBody}>
        <Text
          style={[
            styles.itemTitle,
            { color: theme.colors.text, fontWeight: unread ? '700' : '600' },
          ]}
          numberOfLines={1}
        >
          {t(notification.titleKey)}
        </Text>
        <Text style={[styles.itemText, { color: theme.colors.textMuted }]} numberOfLines={2}>
          {t(notification.bodyKey)}
        </Text>
        <Text style={[styles.itemTime, { color: theme.colors.textSubtle }]}>
          {relativeTime(notification.createdAt, t)}
        </Text>
      </View>

      {unread ? <View style={[styles.dot, { backgroundColor: theme.colors.brand }]} /> : null}
    </Pressable>
  );
}

/** Coarse on purpose: a notification does not need a clock. */
function relativeTime(iso: string, t: (key: string) => string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return t('notifications.justNow');
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: layout.gutter, gap: spacing.sm },
  empty: { flexGrow: 1, justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  back: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.title, flex: 1 },
  markAll: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  markAllText: { ...typography.caption, fontWeight: '700' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    minHeight: MIN_TOUCH_TARGET + spacing.md,
  },
  itemIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemBody: { flex: 1, gap: 2 },
  itemTitle: { ...typography.bodyStrong },
  itemText: { ...typography.caption },
  itemTime: { ...typography.overline, letterSpacing: 0.3, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
});
