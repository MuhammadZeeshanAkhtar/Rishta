import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider';
import { describeError } from '../lib/errors';
import { useAdmin } from './AdminProvider';

/**
 * Loads one staff queue and runs decisions against it.
 *
 * A decided item is removed locally — the API's queues are "oldest first,
 * still pending", so the next load would not show it anyway. Any auth refusal
 * re-runs the staff check (`handleError`), which moves the console to the
 * sign-in or second-factor screen instead of showing a raw error.
 */
export function useQueue<T>(load: () => Promise<T[]>, keyOf: (item: T) => string) {
  const { t } = useLocale();
  const { handleError } = useAdmin();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await load());
      setError(null);
    } catch (err) {
      if (!handleError(err)) setError(describeError(err, t).message);
    } finally {
      setLoading(false);
    }
  }, [handleError, load, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = useCallback(
    async (item: T, run: () => Promise<unknown>, done: string) => {
      setError(null);
      setNotice(null);
      try {
        await run();
        setItems((current) => current.filter((i) => keyOf(i) !== keyOf(item)));
        setNotice(done);
      } catch (err) {
        if (!handleError(err)) setError(describeError(err, t).message);
      }
    },
    [handleError, keyOf, t],
  );

  return { items, loading, error, notice, reload, act };
}
