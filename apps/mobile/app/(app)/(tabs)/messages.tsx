import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  Alert,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { Match } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { CompatibilityBadge } from '../../../src/components/CompatibilityBadge';
import { EmptyState } from '../../../src/components/EmptyState';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { ProfileAvatar } from '../../../src/components/ProfileAvatar';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { SafetyMenu } from '../../../src/safety/SafetyMenu';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Matches.
 *
 * WHY THIS IS THE MESSAGES TAB. The five tabs are fixed by ADR 0004 and there
 * is no Matches tab. A match is the thing that will later open a conversation,
 * so it belongs where someone will look for that conversation — and when chat
 * ships, a thread opens from this same row rather than from a sixth tab.
 *
 * MESSAGING IS NOT HERE, and the screen says so rather than implying it. ADR
 * 0011 is explicit that a match does not necessarily open a conversation; the
 * gate decides. Pretending otherwise would promise something the backend
 * deliberately withholds.
 */
export default function MessagesScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      try {
        const page = await getClient().listMatches({ limit: 30 });
        setItems(page.items);
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

  const confirmUnmatch = useCallback(
    (match: Match) => {
      Alert.alert(t('matches.unmatchTitle'), t('matches.unmatchBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('matches.unmatch'),
          style: 'destructive',
          onPress: () => {
            setBusy(match.id);
            void getClient()
              .unmatch(match.id)
              // Removed locally rather than refetched: the list is small and a
              // full reload makes a deliberate action feel like a page jump.
              .then(() => setItems((list) => list.filter((m) => m.id !== match.id)))
              .catch((err: unknown) => setError(describeError(err, t).message))
              .finally(() => setBusy(null));
          },
        },
      ]);
    },
    [t],
  );

  const header = (
    <View style={{ paddingTop: insets.top + spacing.lg }}>
      <Text style={[styles.title, { color: theme.colors.text }]}>{t('matches.title')}</Text>
      <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
        {t('matches.subtitle')}
      </Text>
      {error ? <Banner tone="error" message={error} /> : null}
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <View style={styles.pad}>{header}</View>
        <View style={styles.pad}>
          <SkeletonList count={4} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        renderItem={({ item, index }) => (
          <MatchCard
            match={item}
            index={index}
            busy={busy === item.id}
            onOpen={() => router.push(`/(app)/profile/${item.counterpartUserId}`)}
            onUnmatch={() => confirmUnmatch(item)}
            // A blocked counterpart is invisible, so the row cannot be
            // reloaded. Dropped locally rather than refetched, exactly as an
            // unmatch is.
            onBlocked={() => setItems((list) => list.filter((m) => m.id !== item.id))}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon="heart-outline"
            title={t('matches.emptyTitle')}
            body={t('matches.emptyBody')}
            actionLabel={t('discovery.title')}
            onAction={() => router.push('/(app)/(tabs)/discover')}
          />
        }
        contentContainerStyle={[
          styles.pad,
          { paddingBottom: insets.bottom + spacing.xxl },
          items.length === 0 && styles.empty,
        ]}
        ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.brand}
            colors={[theme.colors.brand]}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

/**
 * A match card.
 *
 * The entrance is a short rise and fade. For a newly arrived match that reads
 * as a small celebration without a confetti burst — which on a marriage
 * platform would be the wrong register entirely, and on a low-end device would
 * cost real frames.
 */
function MatchCard({
  match,
  index,
  busy,
  onOpen,
  onUnmatch,
  onBlocked,
}: {
  match: Match;
  index: number;
  busy: boolean;
  onOpen: () => void;
  onUnmatch: () => void;
  onBlocked: () => void;
}) {
  const theme = useTheme();
  const { t } = useLocale();
  const card = match.counterpart;

  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(entrance, {
      toValue: 1,
      duration: 280,
      delay: Math.min(index, 6) * 50,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entrance, index]);

  const place = [card?.cityName, card?.countryCode?.toUpperCase()]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  return (
    <Animated.View
      style={{
        opacity: entrance,
        transform: [
          { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
        ],
      }}
    >
      <View
        style={[
          styles.card,
          theme.shadow.card,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={card?.displayName ?? t('profile.someone')}
          style={styles.cardTop}
        >
          <ProfileAvatar
            userId={match.counterpartUserId}
            displayName={card?.displayName ?? null}
            uri={card?.primaryPhoto?.url}
            size="lg"
          />
          <View style={styles.cardBody}>
            <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
              {card?.displayName ?? t('profile.someone')}
              {card?.age ? (
                <Text style={{ color: theme.colors.textMuted }}>{`  ${card.age}`}</Text>
              ) : null}
            </Text>
            {place ? (
              <Text style={[styles.place, { color: theme.colors.textMuted }]} numberOfLines={1}>
                {place}
              </Text>
            ) : null}
            <View style={styles.metaRow}>
              <CompatibilityBadge score={card?.compatibilityScore} size="sm" />
              <StatusBadge label={t('matches.chatPending')} tone="neutral" />
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSubtle} />
        </Pressable>

        <View style={[styles.cardFooter, { borderTopColor: theme.colors.border }]}>
          <Text style={[styles.matchedOn, { color: theme.colors.textSubtle }]}>
            {t('matches.matchedOn')} {new Date(match.createdAt).toLocaleDateString()}
          </Text>
          <View style={styles.cardActions}>
            <Pressable
              onPress={onUnmatch}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t('matches.unmatch')}
              style={styles.unmatch}
            >
              <Text style={[styles.unmatchLabel, { color: theme.colors.danger }]}>
                {t('matches.unmatch')}
              </Text>
            </Pressable>

            {/* Blocking from here matters more than from a profile: this is
                where someone looks when a match has gone wrong. Unmatching
                ends the match; blocking also makes them invisible. */}
            <SafetyMenu
              userId={match.counterpartUserId}
              displayName={card?.displayName ?? null}
              variant="row"
              onBlocked={onBlocked}
              testID={`match-safety-${match.id}`}
            />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: layout.gutter },
  empty: { flexGrow: 1, justifyContent: 'center' },
  title: { ...typography.display },
  subtitle: { ...typography.body, marginTop: 2, marginBottom: spacing.lg },
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  cardBody: { flex: 1, gap: 2 },
  name: { ...typography.heading },
  place: { ...typography.caption },
  metaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
  },
  matchedOn: { ...typography.caption },
  unmatch: {
    minHeight: MIN_TOUCH_TARGET - 8,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  unmatchLabel: { ...typography.caption, fontWeight: '700' },
});
