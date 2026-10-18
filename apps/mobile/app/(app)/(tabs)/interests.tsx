import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Interest, InterestDirection } from '@nikahmate/domain';
import { Banner } from '../../../src/components/Banner';
import { CompatibilityBadge } from '../../../src/components/CompatibilityBadge';
import { EmptyState } from '../../../src/components/EmptyState';
import { SkeletonList } from '../../../src/components/LoadingSkeleton';
import { ProfileAvatar } from '../../../src/components/ProfileAvatar';
import { StatusBadge, type StatusTone } from '../../../src/components/StatusBadge';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getClient } from '../../../src/api/client';
import { describeError } from '../../../src/lib/errors';
import { MIN_TOUCH_TARGET, layout, radius, spacing, typography } from '../../../src/theme/tokens';

/**
 * Interests — received and sent, in one screen with a segmented switch.
 *
 * TWO TABS, NOT TWO SCREENS. They are the two halves of one conversation and
 * people move between them constantly; separate routes would mean a back
 * button between "who wants to talk to me" and "who have I asked".
 *
 * RECEIVED LEADS. It opens on the half that needs a decision — sent interests
 * are a waiting list, received ones are a question someone asked.
 *
 * DESTRUCTIVE ACTIONS CONFIRM. Declining and withdrawing are both one-way, and
 * both are easy to hit by accident on a row full of buttons.
 */
export default function InterestsScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [direction, setDirection] = useState<InterestDirection>('received');
  const [items, setItems] = useState<Interest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      try {
        const page = await getClient().listInterests(direction, { limit: 30 });
        setItems(page.items);
        setError(null);
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [direction, t],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const respond = useCallback(
    async (interest: Interest, decision: 'accept' | 'decline' | 'maybe_later') => {
      setBusy(interest.id);
      setError(null);
      try {
        const result = await getClient().respondToInterest(interest.id, decision);
        setItems((list) => list.map((i) => (i.id === interest.id ? result.interest : i)));
        // Accepting creates a match. Sending people straight there makes the
        // outcome obvious rather than leaving them on a row that just changed
        // colour.
        if (result.match) router.push('/(app)/(tabs)/messages');
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setBusy(null);
      }
    },
    [router, t],
  );

  const confirmDecline = useCallback(
    (interest: Interest) => {
      Alert.alert(t('interests.declineTitle'), t('interests.declineBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('interests.decline'),
          style: 'destructive',
          onPress: () => void respond(interest, 'decline'),
        },
      ]);
    },
    [respond, t],
  );

  const confirmWithdraw = useCallback(
    (interest: Interest) => {
      Alert.alert(t('interests.withdrawTitle'), t('interests.withdrawBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('interests.withdraw'),
          style: 'destructive',
          onPress: () => {
            setBusy(interest.id);
            void getClient()
              .withdrawInterest(interest.id)
              .then(() => load('refresh'))
              .catch((err: unknown) => setError(describeError(err, t).message))
              .finally(() => setBusy(null));
          },
        },
      ]);
    },
    [load, t],
  );

  const header = (
    <View style={{ paddingTop: insets.top + spacing.lg }}>
      <Text style={[styles.title, { color: theme.colors.text }]}>{t('interests.title')}</Text>

      <View style={[styles.segmented, { backgroundColor: theme.colors.surfaceSunken }]}>
        {(['received', 'sent'] as const).map((value) => {
          const active = direction === value;
          return (
            <Pressable
              key={value}
              onPress={() => setDirection(value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[
                styles.segment,
                active && { backgroundColor: theme.colors.surface },
                active && theme.shadow.card,
              ]}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  { color: active ? theme.colors.text : theme.colors.textMuted },
                ]}
              >
                {value === 'received' ? t('interests.incoming') : t('interests.outgoing')}
              </Text>
            </Pressable>
          );
        })}
      </View>

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
        renderItem={({ item }) => (
          <InterestRow
            interest={item}
            busy={busy === item.id}
            onOpen={() =>
              item.counterpart ? router.push(`/(app)/profile/${item.counterpartUserId}`) : undefined
            }
            onAccept={() => void respond(item, 'accept')}
            onDecline={() => confirmDecline(item)}
            onMaybe={() => void respond(item, 'maybe_later')}
            onWithdraw={() => confirmWithdraw(item)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={direction === 'received' ? 'mail-open-outline' : 'paper-plane-outline'}
            title={
              direction === 'received'
                ? t('interests.emptyIncomingTitle')
                : t('interests.emptyOutgoingTitle')
            }
            body={
              direction === 'received'
                ? t('interests.emptyIncomingBody')
                : t('interests.emptyOutgoingBody')
            }
            actionLabel={direction === 'sent' ? t('discovery.title') : undefined}
            onAction={
              direction === 'sent' ? () => router.push('/(app)/(tabs)/discover') : undefined
            }
          />
        }
        contentContainerStyle={[
          styles.pad,
          { paddingBottom: insets.bottom + spacing.xxl },
          items.length === 0 && styles.empty,
        ]}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
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

const TONES: Record<string, StatusTone> = {
  pending: 'warm',
  accepted: 'success',
  declined: 'neutral',
  maybe_later: 'brand',
  withdrawn: 'neutral',
};

function InterestRow({
  interest,
  busy,
  onOpen,
  onAccept,
  onDecline,
  onMaybe,
  onWithdraw,
}: {
  interest: Interest;
  busy: boolean;
  onOpen: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onMaybe: () => void;
  onWithdraw: () => void;
}) {
  const theme = useTheme();
  const { t } = useLocale();

  const card = interest.counterpart;
  const incoming = interest.direction === 'received';
  const actionable = incoming && interest.status === 'pending';
  const withdrawable = !incoming && interest.status === 'pending';

  const place = [card?.cityName, card?.countryCode?.toUpperCase()]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Pressable
        onPress={onOpen}
        disabled={!card}
        accessibilityRole="button"
        accessibilityLabel={card?.displayName ?? t('profile.someone')}
        style={styles.rowTop}
      >
        <ProfileAvatar
          userId={interest.counterpartUserId}
          displayName={card?.displayName ?? null}
          uri={card?.primaryPhoto?.url}
          size="lg"
        />

        <View style={styles.rowBody}>
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
            <StatusBadge
              label={t(`interests.status.${interest.status}`)}
              tone={TONES[interest.status] ?? 'neutral'}
            />
            <CompatibilityBadge score={card?.compatibilityScore} size="sm" />
          </View>
        </View>
      </Pressable>

      {actionable ? (
        <View style={styles.rowActions}>
          <RowButton
            label={t('interests.decline')}
            onPress={onDecline}
            disabled={busy}
            tone="quiet"
          />
          <RowButton
            label={t('interests.maybeLater')}
            onPress={onMaybe}
            disabled={busy}
            tone="quiet"
          />
          <RowButton
            label={t('interests.accept')}
            onPress={onAccept}
            disabled={busy}
            loading={busy}
            tone="primary"
          />
        </View>
      ) : withdrawable ? (
        <View style={styles.rowActions}>
          <RowButton
            label={t('interests.withdraw')}
            onPress={onWithdraw}
            disabled={busy}
            loading={busy}
            tone="quiet"
          />
        </View>
      ) : null}
    </View>
  );
}

function RowButton({
  label,
  onPress,
  tone,
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  tone: 'primary' | 'quiet';
  disabled?: boolean;
  loading?: boolean;
}) {
  const theme = useTheme();
  const primary = tone === 'primary';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[
        styles.rowButton,
        {
          flex: primary ? 1.2 : 1,
          backgroundColor: primary ? theme.colors.brand : 'transparent',
          borderColor: primary ? theme.colors.brand : theme.colors.borderStrong,
          opacity: disabled && !loading ? 0.5 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={primary ? theme.colors.textOnBrand : theme.colors.textMuted}
        />
      ) : (
        <Text
          style={[
            styles.rowButtonLabel,
            { color: primary ? theme.colors.textOnBrand : theme.colors.textMuted },
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: layout.gutter },
  empty: { flexGrow: 1, justifyContent: 'center' },
  title: { ...typography.display, marginBottom: spacing.lg },
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: spacing.lg,
  },
  segment: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET - 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentLabel: { ...typography.bodyStrong },
  row: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md },
  rowTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  rowBody: { flex: 1, gap: 2 },
  name: { ...typography.heading },
  place: { ...typography.caption },
  metaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' },
  rowActions: { flexDirection: 'row', gap: spacing.sm },
  rowButton: {
    height: MIN_TOUCH_TARGET - 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  rowButtonLabel: { ...typography.caption, fontWeight: '700' },
});
