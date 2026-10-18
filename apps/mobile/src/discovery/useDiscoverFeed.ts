import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProfileCard } from '@nikahmate/domain';
import { getClient } from '../api/client';
import { describeError } from '../lib/errors';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * The Discover feed: a cursor-paged list with optimistic owner actions.
 *
 * KEPT IN A HOOK rather than in the screen so the loading, error, paging and
 * optimistic-removal rules live in one place. A screen that owns its own
 * fetching ends up with four subtly different versions of "are we loading" by
 * the third list, and the one that is wrong is always the error case.
 *
 * THREE DISTINCT STATES, never collapsed into a boolean: first load, loading
 * more, and refreshing. They look different on screen — a skeleton, a footer
 * spinner, and the pull-to-refresh control — and conflating them is what makes
 * a list flash its skeleton every time someone pulls down.
 *
 * NO OPTIMISM ABOUT FAILURE. Dismiss and shortlist remove or mark a card
 * immediately because they are near-certain to succeed and the alternative is
 * a card that lingers after you tapped "not for me". If the request fails, the
 * card comes back and the error surfaces — the UI never silently diverges from
 * the server.
 */

const PAGE_SIZE = 10;

export interface DiscoverFeed {
  items: ProfileCard[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  dismiss: (userId: string) => Promise<void>;
  toggleShortlist: (userId: string) => Promise<void>;
}

export function useDiscoverFeed(sectionKey = 'recommended'): DiscoverFeed {
  const { t } = useLocale();

  const [items, setItems] = useState<ProfileCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Guards a late response from an earlier request overwriting a newer one —
  // which is exactly what happens when someone pulls to refresh twice.
  const generation = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const mine = ++generation.current;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);

      try {
        const page = await getClient().getDiscoverySection(sectionKey, { limit: PAGE_SIZE });
        if (generation.current !== mine) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setError(null);
      } catch (err) {
        if (generation.current !== mine) return;
        setError(describeError(err, t).message);
      } finally {
        if (generation.current === mine) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [sectionKey, t],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const loadMore = useCallback(async () => {
    // Every guard matters: no cursor, already fetching, or nothing left.
    if (!hasMore || !cursor || loadingMore || loading) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await getClient().getDiscoverySection(sectionKey, {
        cursor,
        limit: PAGE_SIZE,
      });
      if (generation.current !== mine) return;
      // De-duplicated on merge. A profile can legitimately arrive twice if the
      // precompute changed between pages, and a duplicate key in a list is a
      // React warning and a visible repeat.
      setItems((previous) => {
        const seen = new Set(previous.map((p) => p.userId));
        return [...previous, ...page.items.filter((p) => !seen.has(p.userId))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // A failed page is not a failed screen: what is already loaded stays,
      // and the footer simply stops. Replacing the list with an error here
      // would throw away everything the person was reading.
      setHasMore(false);
    } finally {
      if (generation.current === mine) setLoadingMore(false);
    }
  }, [cursor, hasMore, loading, loadingMore, sectionKey]);

  const dismiss = useCallback(
    async (userId: string) => {
      const previous = items;
      setItems((list) => list.filter((p) => p.userId !== userId));
      try {
        await getClient().dismissProfile(userId);
      } catch (err) {
        setItems(previous);
        setError(describeError(err, t).message);
      }
    },
    [items, t],
  );

  const toggleShortlist = useCallback(
    async (userId: string) => {
      const current = items.find((p) => p.userId === userId);
      if (!current) return;
      const next = !current.isShortlisted;

      setItems((list) =>
        list.map((p) => (p.userId === userId ? { ...p, isShortlisted: next } : p)),
      );
      try {
        const client = getClient();
        if (next) await client.addToShortlist(userId);
        else await client.removeFromShortlist(userId);
      } catch (err) {
        setItems((list) =>
          list.map((p) => (p.userId === userId ? { ...p, isShortlisted: !next } : p)),
        );
        setError(describeError(err, t).message);
      }
    },
    [items, t],
  );

  return {
    items,
    loading,
    refreshing,
    loadingMore,
    error,
    hasMore,
    refresh: () => load('refresh'),
    loadMore,
    dismiss,
    toggleShortlist,
  };
}
