import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import type { ProfileCard as Card } from '@nikahmate/domain';
import { getClient } from '../../../src/api/client';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { EmptyState } from '../../../src/components/EmptyState';
import { ProfileCard } from '../../../src/components/ProfileCard';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { describeError } from '../../../src/lib/errors';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { layout, spacing } from '../../../src/theme/tokens';

/**
 * Saved profiles. Members could save someone from Discover or a profile, and then never
 * find them again. Re-read on focus, because saving is undone from the profile screen.
 */
export default function SavedScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const [items, setItems] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await getClient().getShortlist(after ? { cursor: after } : {});
        setItems((list) => (after ? [...list, ...page.items] : page.items));
        setCursor(page.hasMore ? page.nextCursor : null);
        setError(null);
      } catch (err) {
        setError(describeError(err, t).message);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title={t('account.savedTitle')} fallback="/me" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>
          {error ? <Banner tone="error" message={error} /> : null}
          {items.map((card) => (
            <ProfileCard
              key={card.userId}
              profile={card}
              onPress={() => router.push(`/(app)/profile/${card.userId}`)}
            />
          ))}
          {loading ? <ActivityIndicator color={theme.colors.brand} style={styles.spinner} /> : null}
          {!loading && !error && items.length === 0 ? (
            <EmptyState
              icon="bookmark-outline"
              title={t('account.savedEmptyTitle')}
              body={t('account.savedEmptyBody')}
            />
          ) : null}
          {cursor && !loading ? (
            <Button
              label={t('common.loadMore')}
              variant="ghost"
              onPress={() => void load(cursor)}
            />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: layout.gutter, flexGrow: 1 },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.md },
  spinner: { marginTop: spacing.lg },
});
