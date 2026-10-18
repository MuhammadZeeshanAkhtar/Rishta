import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Localization from 'expo-localization';
import { isNikahMateError, type AuthSession, type NikahMateError } from '@nikahmate/api-client';
import { DEFAULT_LOCALE, type Me } from '@nikahmate/domain';
import { getClient, MissingConfigError } from '../api/client';
import { forgetCards } from '../discovery/cardCache';

/**
 * Session state, and the routing gates that depend on it.
 *
 * One source of truth for "who is signed in", derived from two facts that can
 * disagree: Supabase holds the auth session, our API holds the account. A
 * verified auth account with no profile is NOT a usable member (README §9.1),
 * so the gate is computed from both rather than from the token alone.
 *
 *   signed_out     no session
 *   unverified     session, email not confirmed
 *   onboarding     verified, profile incomplete
 *   ready          verified, profile complete
 */

export type SessionState =
  'loading' | 'misconfigured' | 'signed_out' | 'unverified' | 'onboarding' | 'ready';

interface SessionContextValue {
  state: SessionState;
  session: AuthSession | null;
  me: Me | null;
  /** Present when the client could not be configured at all. */
  configError: string[] | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  signOut: () => Promise<void>;
  resendVerification: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  /** Re-reads verification state and the account. Used by the verify screen. */
  refresh: () => Promise<void>;
  /**
   * Completes an email link and routes on its `type`.
   *
   * Returns what kind of link it was, so the callback screen knows whether to
   * send someone to a password form or on into the app.
   */
  completeAuthLink: (url: string) => Promise<string | null>;
  /** Sets a new password for the current (recovery) session. */
  updatePassword: (password: string) => Promise<void>;
  /** The email awaiting verification, so the verify screen can name it. */
  pendingEmail: string | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function stateFor(session: AuthSession | null, me: Me | null): SessionState {
  if (!session) return 'signed_out';
  if (!session.user.emailVerified) return 'unverified';
  if (!me) return 'onboarding';
  return me.profileCompleted && me.status === 'active' ? 'ready' : 'onboarding';
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<SessionState>('loading');
  const [configError, setConfigError] = useState<string[] | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Guards against a late response from a previous account overwriting the
  // current one — switching accounts quickly is exactly when that bites.
  const generation = useRef(0);

  /**
   * Loads the account for a verified session.
   *
   * `bootstrap` rather than `getMe`: it is idempotent and creates the `users`
   * row if sign-up was interrupted between the auth account and ours. Calling
   * it on every launch means a half-finished sign-up repairs itself instead of
   * stranding someone with an auth account and no application account.
   */
  const loadAccount = useCallback(async (next: AuthSession | null): Promise<void> => {
    const mine = ++generation.current;

    if (!next) {
      setSession(null);
      setMe(null);
      setState('signed_out');
      return;
    }

    setSession(next);

    if (!next.user.emailVerified) {
      setMe(null);
      setState('unverified');
      return;
    }

    try {
      const account = await getClient().bootstrap({
        locale: DEFAULT_LOCALE,
        timezone: Localization.getCalendars()[0]?.timeZone ?? 'UTC',
      });
      if (generation.current !== mine) return;
      setMe(account);
      setState(stateFor(next, account));
    } catch (error) {
      if (generation.current !== mine) return;
      // The account could not be loaded. Treat it as onboarding rather than
      // signing the person out: the session is genuinely valid, and the most
      // likely cause is a dropped connection, not a bad token.
      if (isNikahMateError(error) && error.kind === 'unauthenticated') {
        setMe(null);
        setState('signed_out');
        return;
      }
      setMe(null);
      setState('onboarding');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      let client;
      try {
        client = getClient();
      } catch (error) {
        if (cancelled) return;
        // No Supabase configuration. Say which values are missing rather than
        // showing an empty screen or crashing on the first request.
        setConfigError(error instanceof MissingConfigError ? error.missing : ['configuration']);
        setState('misconfigured');
        return;
      }

      try {
        const existing = await client.auth.getSession();
        if (cancelled) return;
        await loadAccount(existing);
      } catch {
        if (!cancelled) setState('signed_out');
      }

      // Token refreshes, sign-outs from another tab, and expiry all arrive
      // here, so the UI follows the real session rather than a stale snapshot.
      unsubscribe = client.auth.onAuthStateChange((next, event) => {
        if (cancelled) return;
        if (event === 'TOKEN_REFRESHED') {
          // Same identity, new token. Re-fetching the account would be a
          // needless request on every refresh.
          setSession(next);
          return;
        }
        void loadAccount(next);
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [loadAccount]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const next = await getClient().auth.signIn(email, password);
      setPendingEmail(email.trim());
      await loadAccount(next);
    },
    [loadAccount],
  );

  const signUp = useCallback(async (email: string, password: string) => {
    const result = await getClient().auth.signUp(email, password);
    setPendingEmail(email.trim());
    return result;
  }, []);

  const signOut = useCallback(async () => {
    await getClient().auth.signOut();
    generation.current += 1;
    setSession(null);
    setMe(null);
    setPendingEmail(null);
    // Other people's cards were shown to THIS member under the privacy rules
    // that applied to them. They must not survive into whoever signs in next
    // on this device.
    forgetCards();
    setState('signed_out');
  }, []);

  const resendVerification = useCallback(async () => {
    const email = pendingEmail ?? session?.user.email;
    if (!email) return;
    await getClient().auth.resendVerification(email);
  }, [pendingEmail, session]);

  const requestPasswordReset = useCallback(async (email: string) => {
    await getClient().auth.requestPasswordReset(email);
  }, []);

  const completeAuthLink = useCallback(
    async (url: string): Promise<string | null> => {
      const { session: next, type } = await getClient().auth.completeAuthLink(url);
      // A recovery link must NOT be treated as a normal sign-in: loading the
      // account here would route the person into the app and away from the
      // password form they were sent to.
      if (next && type !== 'recovery') {
        await loadAccount(next);
      } else if (next) {
        setSession(next);
      }
      return type;
    },
    [loadAccount],
  );

  const updatePassword = useCallback(async (password: string) => {
    await getClient().auth.updatePassword(password);
  }, []);

  const refresh = useCallback(async () => {
    const client = getClient();
    const user = await client.auth.refreshUser();
    if (!user) {
      await signOut();
      return;
    }
    // getSession returns the stored session; refreshUser has just updated the
    // verification flag on the server, so re-read rather than trusting the
    // snapshot we already hold.
    const next = await client.auth.getSession();
    await loadAccount(
      next ? { ...next, user: { ...next.user, emailVerified: user.emailVerified } } : null,
    );
  }, [loadAccount, signOut]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      session,
      me,
      configError,
      signIn,
      signUp,
      signOut,
      resendVerification,
      requestPasswordReset,
      refresh,
      completeAuthLink,
      updatePassword,
      pendingEmail: pendingEmail ?? session?.user.email ?? null,
    }),
    [
      state,
      session,
      me,
      configError,
      signIn,
      signUp,
      signOut,
      resendVerification,
      requestPasswordReset,
      refresh,
      completeAuthLink,
      updatePassword,
      pendingEmail,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

export type { NikahMateError };
