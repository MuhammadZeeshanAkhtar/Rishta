import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Block } from '@nikahmate/domain';
import { getClient } from '../../../src/api/client';
import { Banner } from '../../../src/components/Banner';
import { Button } from '../../../src/components/Button';
import { EmptyState } from '../../../src/components/EmptyState';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useLocale } from '../../../src/i18n/LocaleProvider';
import { confirmAction } from '../../../src/lib/confirm';
import { describeError } from '../../../src/lib/errors';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { layout, spacing, typography } from '../../../src/theme/tokens';

/**
 * The people this member has blocked, and the way to undo it. A block with no way to
 * see or reverse it is a mistake that cannot be corrected.
 */
export default function BlockedScreen() {
  const { t } = useLocale();
  const theme = useTheme();
  const [items, setItems] = useState<Block[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      try {
        const page = await getClient().listBlocks(after ? { cursor: after } : {});
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

  useEffect(() => {
    void load();
  }, [load]);

  const unblock = (block: Block) => {
    const who = block.displayName?.trim() || t('profile.someone');
    confirmAction({
      title: t('account.unblockTitle').replace('{{name}}', who),
      message: t('account.unblockBody'),
      confirmLabel: t('safety.unblock'),
      cancelLabel: t('common.cancel'),
      destructive: false,
      onConfirm: () => {
        setBusy(block.userId);
        setError(null);
        void getClient()
          .unblockUser(block.userId)
          .then(() => setItems((list) => list.filter((b) => b.userId !== block.userId)))
          .catch((err: unknown) => setError(describeError(err, t).message))
          .finally(() => setBusy(null));
      },
    });
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title={t('account.blockedTitle')} fallback="/me" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>
          {error ? <Banner tone="error" message={error} /> : null}
          {items.map((block) => (
            <View
              key={block.userId}
              style={[styles.row, { borderBottomColor: theme.colors.border }]}
              testID={`blocked-${block.userId}`}
            >
              <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                {block.displayName?.trim() || t('profile.someone')}
              </Text>
              <Button
                label={t('safety.unblock')}
                variant="secondary"
                loading={busy === block.userId}
                disabled={busy !== null && busy !== block.userId}
                onPress={() => unblock(block)}
                testID={`unblock-${block.userId}`}
              />
            </View>
          ))}
          {loading ? <ActivityIndicator color={theme.colors.brand} style={styles.spinner} /> : null}
          {!loading && !error && items.length === 0 ? (
            <EmptyState
              icon="shield-checkmark-outline"
              title={t('account.blockedEmptyTitle')}
              body={t('account.blockedEmptyBody')}
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
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { ...typography.bodyStrong, flex: 1 },
  spinner: { marginTop: spacing.lg },
});
