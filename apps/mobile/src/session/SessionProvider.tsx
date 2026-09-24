import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getItem, removeItem, setItem } from '../storage';

/**
 * Session state.
 *
 * Phase 1 has no Supabase project and therefore no real sign-in. This provider
 * holds the shape the real implementation will fill: a token, whether the
 * profile is complete, and the three gates routing depends on.
 *
 * What it deliberately does NOT do is fake a signed-in user in production. The
 * preview session below is compiled out of release builds.
 */

const TOKEN_KEY = 'session_token';

export type SessionState = 'loading' | 'signed_out' | 'onboarding' | 'ready';

interface SessionContextValue {
  state: SessionState;
  token: string | null;
  signOut: () => void;
  /**
   * Development-only. Lets the protected shell be opened without a backend so
   * the tab layout and RTL can be inspected before Supabase exists.
   *
   * `__DEV__` is false in release builds and Metro strips the branch, so this
   * cannot ship. It is still the first thing to delete once real auth lands.
   */
  startPreviewSession: (() => void) | undefined;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<SessionState>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getItem(TOKEN_KEY);
      if (cancelled) return;
      setToken(stored);
      setState(stored ? 'onboarding' : 'signed_out');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setState('signed_out');
    void removeItem(TOKEN_KEY);
  }, []);

  const startPreviewSession = useCallback(() => {
    const preview = 'preview';
    setToken(preview);
    setState('onboarding');
    void setItem(TOKEN_KEY, preview);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      token,
      signOut,
      startPreviewSession: __DEV__ ? startPreviewSession : undefined,
    }),
    [state, token, signOut, startPreviewSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
