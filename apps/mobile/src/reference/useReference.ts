import { useEffect, useState } from 'react';
import type { ReferenceItem, ReferenceType } from '@nikahmate/domain';
import { getClient } from '../api/client';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * Loads a coded list and keeps it for the session.
 *
 * Cached per (type, locale) in module scope rather than per component: an
 * onboarding step mounts several of these, and a user moving back and forth
 * between steps would otherwise re-fetch the same country list every time. On
 * the connections this product targets that is the difference between a form
 * that feels instant and one that flickers.
 *
 * The cache is deliberately not persisted to disk. Reference data changes
 * without a release, and a stale list on disk would be invisible until someone
 * noticed a missing option.
 */

const cache = new Map<string, ReferenceItem[]>();
const inFlight = new Map<string, Promise<ReferenceItem[]>>();

export interface ReferenceState {
  items: ReferenceItem[];
  loading: boolean;
  /** Already-translated message, or null. */
  error: boolean;
  reload: () => void;
}

async function load(type: ReferenceType, locale: string): Promise<ReferenceItem[]> {
  const key = `${type}:${locale}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Share one request between concurrent callers, so four fields asking for
  // `country` at once make one network call.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = getClient()
    .getReference(type, locale)
    .then((list) => {
      cache.set(key, list.items);
      inFlight.delete(key);
      return list.items;
    })
    .catch((error: unknown) => {
      inFlight.delete(key);
      throw error;
    });

  inFlight.set(key, request);
  return request;
}

export function useReference(type: ReferenceType): ReferenceState {
  const { locale } = useLocale();
  const [items, setItems] = useState<ReferenceItem[]>(() => cache.get(`${type}:${locale}`) ?? []);
  const [loading, setLoading] = useState(items.length === 0);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(`${type}:${locale}`);
    if (cached) {
      setItems(cached);
      setLoading(false);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    load(type, locale)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // The caller shows a retry. Reference data is not optional — an empty
        // country list is an onboarding step nobody can finish.
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [type, locale, attempt]);

  return { items, loading, error, reload: () => setAttempt((n) => n + 1) };
}

/** Clears the cache. Used when the locale changes and on sign-out. */
export function clearReferenceCache(): void {
  cache.clear();
  inFlight.clear();
}
