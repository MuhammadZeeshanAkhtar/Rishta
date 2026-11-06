import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AdminSession } from '@nikahmate/domain';
import { isNikahMateError } from '@nikahmate/api-client';
import { getClient } from '../api/client';
import { gateFor, type AdminGate } from './adminAccess';

/**
 * The staff session (review L1).
 *
 * Asks the API — `GET /admin/session` — who the caller is. The API checks the
 * staff row, the role and the second factor; this provider only reports what
 * it said, so the interface can show the matching screen. There is no
 * service-role credential anywhere in the app, and no screen decides access:
 * every action route checks again, and a refused action re-runs this check so
 * an expired session or a revoked role lands on the right screen.
 */

export type AdminState =
  | { status: 'loading' }
  | { status: 'ready'; session: AdminSession }
  | { status: 'gate'; gate: AdminGate };

interface AdminContextValue {
  state: AdminState;
  reload: () => Promise<void>;
  /** For any API error inside the console: re-checks access when it was an auth refusal. */
  handleError: (error: unknown) => boolean;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AdminState>({ status: 'loading' });

  const reload = useCallback(async () => {
    try {
      const session = await getClient().getAdminSession();
      setState({ status: 'ready', session });
    } catch (error) {
      const kind = isNikahMateError(error) ? error.kind : 'unknown';
      // Only a refusal for want of a second factor needs to know about
      // factors; asking Supabase Auth otherwise is wasted round trips.
      let assurance = null;
      let hasFactor = false;
      if (kind === 'forbidden') {
        try {
          assurance = await getClient().auth.getAssurance();
          hasFactor = (await getClient().auth.listTotpFactors()).length > 0;
        } catch {
          // Leave the defaults: the gate then offers enrolment, and enrolling
          // with a factor already present fails with a message, not silently.
        }
      }
      setState({ status: 'gate', gate: gateFor(kind, assurance, hasFactor) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleError = useCallback(
    (error: unknown) => {
      if (
        isNikahMateError(error) &&
        ['unauthenticated', 'forbidden', 'not_found', 'session_expired'].includes(error.kind)
      ) {
        // 404 from an action route means the THING is gone, not the staff
        // row — but re-checking is cheap and correct in both cases.
        void reload();
        return error.kind !== 'not_found';
      }
      return false;
    },
    [reload],
  );

  const value = useMemo(() => ({ state, reload, handleError }), [state, reload, handleError]);
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin outside AdminProvider');
  return value;
}
