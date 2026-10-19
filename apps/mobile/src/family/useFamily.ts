import { useCallback, useEffect, useState } from 'react';
import type {
  FamilyAccessLogEntry,
  FamilyMember,
  FamilyPermission,
  ReviewSummary,
} from '@nikahmate/domain';
import { getClient } from '../api/client';

/**
 * The Family screens' data, in one place.
 *
 * Deliberately NOT cached across mounts, unlike `useReference`. Reference data
 * is the same for everyone and changes rarely; a family grant is the thing a
 * person revokes when they need it gone, and showing them a cached list after
 * a revocation would be the one stale read this product cannot afford. Every
 * mount re-reads.
 */

export interface FamilyState {
  /** Delegates acting for me. */
  members: FamilyMember[];
  /** People I act for. */
  managed: FamilyMember[];
  /** Matches awaiting MY decision, as a delegate. */
  reviews: ReviewSummary[];
  /** Reviews pending on MY matches, with the stalled warning. */
  myReviews: MyReview[];
  loading: boolean;
  error: boolean;
  reload: () => void;
}

export interface MyReview {
  matchId: string;
  decision: string;
  requestedAt: string;
  decidedAt: string | null;
  note: string | null;
  overdue: boolean;
}

export function useFamily(): FamilyState {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [managed, setManaged] = useState<FamilyMember[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [myReviews, setMyReviews] = useState<MyReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    const client = getClient();

    // Four independent reads, settled together. `allSettled` rather than
    // `all`: a delegate with no principals and a member with no delegates are
    // both ordinary, and one empty or failing list must not blank the whole
    // screen.
    void Promise.allSettled([
      client.listFamilyMembers(),
      client.listManagedProfiles(),
      client.listFamilyReviews(),
      client.listMyFamilyReviews(),
    ]).then((results) => {
      if (cancelled) return;

      const [m, g, r, mine] = results;
      if (m.status === 'fulfilled') setMembers(m.value.items);
      if (g.status === 'fulfilled') setManaged(g.value.items);
      if (r.status === 'fulfilled') setReviews(r.value.items);
      if (mine.status === 'fulfilled') {
        const body = mine.value as { items?: MyReview[] };
        setMyReviews(body.items ?? []);
      }

      // Only an error if EVERY read failed — that is a connectivity problem
      // rather than an empty family.
      setError(results.every((x) => x.status === 'rejected'));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { members, managed, reviews, myReviews, loading, error, reload };
}

/**
 * The access log, loaded on demand.
 *
 * Separate from `useFamily` because it is a screen of its own and can be long.
 * Someone opening the family tab should not pay for a log they are not
 * looking at.
 */
export function useFamilyAccessLog(): {
  entries: FamilyAccessLogEntry[];
  loading: boolean;
  error: boolean;
  reload: () => void;
} {
  const [entries, setEntries] = useState<FamilyAccessLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    getClient()
      .listFamilyAccessLog()
      .then((page) => {
        if (cancelled) return;
        setEntries(page.items);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { entries, loading, error, reload };
}

/** The six permissions a member can actually grant today. */
export const GRANTABLE: readonly FamilyPermission[] = [
  'view_profile',
  'view_matches',
  'review_interest',
  'approve_communication',
  'report_on_behalf',
  'block_on_behalf',
];
