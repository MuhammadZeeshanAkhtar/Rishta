import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { ProfileCard as ProfileCardData } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/EmptyState';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { ProfileCard } from '../../../src/components/ProfileCard';
import { useDiscoverFeed } from '../../../src/discovery/useDiscoverFeed';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Discover — the strongest screen in the app.
 *
 * ONE COLUMN OF LARGE CARDS rather than a grid. This is a decision about a
 * person, not a product listing: two small cards side by side would halve the
 * portrait and turn a considered choice into a browse. The list is long and
 * slow on purpose.
 *
 * STATES ARE NEVER AMBIGUOUS. First load shows skeletons shaped like the real
 * card; a failure shows an error with a retry, never "no one matches you",
 * because telling someone nobody suits them when the request simply failed is
 * the most demoralising thing this screen could do. Those are different
 * components taking different props so the two cannot be confused.
 */
export default function DiscoverScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const feed = useDiscoverFeed('recommended');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const expressInterest = useCallback(
    async (profile: ProfileCardData) => {
      setBusy(profile.userId);
      setActionError(null);
      try {
        await getClient().sendInterest(profile.userId);
        // Sent interests leave the feed: showing someone you have already
        // written to invites a second attempt that the server will refuse.
        await feed.dismiss(profile.userId);
      } catch (err) {
        setActionError(describeError(err, t).message);
      } finally {
        setBusy(null);
      }
    },
    [feed, t],
  );

  const renderCard = useCallback(
    ({ item, index }: { item: ProfileCardData; index: number }) => (
      <ProfileCard
        profile={item}
        index={index}
        onPress={() => router.push(`/(app)/profile/${item.userId}`)}
        testID={`discover-card-${item.userId}`}
        actions={
          <>
            <CardAction
              icon="close"
              label={t('discovery.pass')}
              onPress={() => void feed.dismiss(item.userId)}
              disabled={busy !== null}
            />
            <CardAction
              icon={item.isShortlisted ? 'bookmark' : 'bookmark-outline'}
              label={item.isShortlisted ? t('discovery.unsave') : t('discovery.save')}
              active={item.isShortlisted}
              onPress={() => void feed.toggleShortlist(item.userId)}
              disabled={busy !== null}
            />
            <CardAction
              icon="heart"
              label={t('discovery.express')}
              primary
              loading={busy === item.userId}
              onPress={() => void expressInterest(item)}
              disabled={busy !== null}
            />
          </>
        }
      />
    ),
    [busy, expressInterest, feed, router, t],
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t('discovery.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          {t('discovery.subtitle')}
        </Text>
      </View>
      <Pressable
        onPress={() => router.push('/(app)/notifications')}
        accessibilityRole="button"
        accessibilityLabel={t('notifications.title')}
        style={[
          styles.bell,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <Ionicons name="notifications-outline" size={20} color={theme.colors.text} />
      </Pressable>
    </View>
  );

  // First load only. A refresh keeps the list in place beneath the spinner.
  if (feed.loading) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <View style={{ paddingTop: insets.top + spacing.lg }}>{header}</View>
        <View style={styles.listPad}>
          <SkeletonList count={2} variant="card" />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={feed.items}
        keyExtractor={(item) => item.userId}
        renderItem={renderCard}
        ListHeaderComponent={
          <View style={{ paddingTop: insets.top + spacing.lg }}>
            {header}
            {actionError ? <Banner tone="error" message={actionError} /> : null}
          </View>
        }
        ListEmptyComponent={
          feed.error ? (
            <EmptyState
              tone="error"
              title={t('discovery.errorTitle')}
              body={t('discovery.errorBody')}
              actionLabel={t('discovery.retry')}
              onAction={() => void feed.refresh()}
            />
          ) : (
            <EmptyState
              icon="sparkles-outline"
              title={t('discovery.emptyTitle')}
              body={t('discovery.emptyBody')}
              actionLabel={t('discovery.emptyAction')}
              onAction={() => router.push('/(app)/edit-preferences')}
            />
          )
        }
        ListFooterComponent={
          feed.loadingMore ? (
            <ActivityIndicator
              color={theme.colors.brand}
              style={styles.footer}
              accessibilityLabel={t('a11y.loading')}
            />
          ) : feed.items.length > 0 && !feed.hasMore ? (
            <Text style={[styles.end, { color: theme.colors.textSubtle }]}>
              {t('discovery.endOfList')}
            </Text>
          ) : null
        }
        contentContainerStyle={[
          styles.listPad,
          { paddingBottom: insets.bottom + spacing.xxl },
          feed.items.length === 0 && styles.listEmpty,
        ]}
        ItemSeparatorComponent={() => <View style={{ height: spacing.lg }} />}
        refreshControl={
          <RefreshControl
            refreshing={feed.refreshing}
            onRefresh={() => void feed.refresh()}
            tintColor={theme.colors.brand}
            colors={[theme.colors.brand]}
          />
        }
        onEndReached={() => void feed.loadMore()}
        // Half a screen of warning, so the next page is usually there before
        // the list runs out — but not so early that it fetches eagerly.
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        // Keeps memory flat on low-end devices with large portraits.
        windowSize={5}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        removeClippedSubviews
      />
    </View>
  );
}

/**
 * A card action.
 *
 * The primary action is wider and brand-filled; the other two are equal-weight
 * outlines. Making "express interest" the obvious one without making the
 * others feel discouraged is the whole balance of this row.
 */
function CardAction({
  icon,
  label,
  onPress,
  primary = false,
  active = false,
  disabled = false,
  loading = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const theme = useTheme();

  const background = primary
    ? theme.colors.brand
    : active
      ? theme.colors.accentSurface
      : 'transparent';
  const foreground = primary
    ? theme.colors.textOnBrand
    : active
      ? theme.colors.accent
      : theme.colors.textMuted;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      style={[
        styles.action,
        primary && styles.actionPrimary,
        {
          backgroundColor: background,
          borderColor: primary ? theme.colors.brand : theme.colors.border,
          opacity: disabled && !loading ? 0.5 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <>
          <Ionicons name={icon} size={17} color={foreground} />
          {primary ? (
            <Text style={[styles.actionLabel, { color: foreground }]} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listPad: { paddingHorizontal: layout.gutter },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  headerText: { flex: 1 },
  title: { ...typography.display },
  subtitle: { ...typography.body, marginTop: 2 },
  bell: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    height: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  actionPrimary: { flex: 1 },
  actionLabel: { ...typography.bodyStrong, flexShrink: 1 },
  footer: { paddingVertical: spacing.xl },
  end: { ...typography.caption, textAlign: 'center', paddingVertical: spacing.xl },
});
