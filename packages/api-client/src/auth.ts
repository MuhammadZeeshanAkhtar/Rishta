import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type SupportedStorage,
} from '@supabase/supabase-js';
import { fromAuthError, NikahMateError } from './errors';

/**
 * Supabase Auth, wrapped.
 *
 * This is the ONLY module in the repository that imports the Supabase client
 * (ESLint blocks it everywhere else). Two reasons it is worth the indirection:
 *
 *   1. The future website reuses this package against the same user records.
 *      A second auth implementation is the fastest way to end up with two
 *      subtly different definitions of "signed in".
 *   2. Every failure leaves here as a NikahMateError, so no screen can render
 *      a raw provider message by accident.
 *
 * It is platform-agnostic on purpose: the host supplies storage. Mobile passes
 * a SecureStore adapter, the website will pass a cookie-backed one, and this
 * file does not need to know which.
 */

export interface AuthUser {
  /** The Supabase auth id. Resolved to our internal users.id by the API. */
  id: string;
  email: string | null;
  emailVerified: boolean;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds since epoch. */
  expiresAt: number | undefined;
  user: AuthUser;
}

export interface AuthClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** Where the session is persisted. Must be encrypted at rest on mobile. */
  storage: SupportedStorage;
  /** Deep link the verification and reset emails return to. */
  redirectTo?: string;
}

/** `null` means signed out. */
export type AuthListener = (session: AuthSession | null, event: AuthChangeEvent) => void;

function toSession(session: Session | null): AuthSession | null {
  if (!session?.user) return null;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
      // Supabase sets email_confirmed_at only once the link is followed. Its
      // absence is what the verification gate keys on, so treat a missing
      // value as unverified rather than optimistically assuming otherwise.
      emailVerified: Boolean(session.user.email_confirmed_at),
    },
  };
}

export class AuthClient {
  private readonly supabase: SupabaseClient;
  private readonly redirectTo: string | undefined;

  constructor(options: AuthClientOptions) {
    this.redirectTo = options.redirectTo;
    this.supabase = createClient(options.supabaseUrl, options.publishableKey, {
      auth: {
        storage: options.storage,
        // Persist and refresh, but never read the session out of a URL: that is
        // a browser concern, and on mobile it would let any deep link hand the
        // app a session.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    });
  }

  /** Restores a stored session, refreshing it if it has expired. */
  async getSession(): Promise<AuthSession | null> {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) throw fromAuthError(error);
    return toSession(data.session);
  }

  /**
   * A valid access token, refreshed if needed.
   *
   * Every API call goes through this rather than caching a token, because a
   * token cached at app start is expired by the time someone comes back to the
   * app an hour later.
   */
  async getAccessToken(): Promise<string | null> {
    const session = await this.getSession();
    return session?.accessToken ?? null;
  }

  onAuthStateChange(listener: AuthListener): () => void {
    const { data } = this.supabase.auth.onAuthStateChange((event, session) => {
      listener(toSession(session), event);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string): Promise<{ needsVerification: boolean }> {
    const { data, error } = await this.supabase.auth.signUp({
      email: email.trim(),
      password,
      ...(this.redirectTo ? { options: { emailRedirectTo: this.redirectTo } } : {}),
    });
    if (error) throw fromAuthError(error);

    // Supabase returns a user with an empty identities array when the address
    // is already registered — it does not error, to avoid telling an attacker
    // which addresses exist. We honour that: the UI says "check your email"
    // either way, and only the real owner can act on it.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      return { needsVerification: true };
    }

    return { needsVerification: !data.session };
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw fromAuthError(error);

    const session = toSession(data.session);
    if (!session) throw new NikahMateError('unknown', { detail: 'Sign-in returned no session' });
    return session;
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut();
    // A failed sign-out must still clear local state, so this never throws.
    // The caller has already decided the session is over, and a network blip
    // must not strand someone in an account they asked to leave.
    void error;
  }

  /** Re-sends the verification email. Supabase applies its own cooldown. */
  async resendVerification(email: string): Promise<void> {
    const { error } = await this.supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      ...(this.redirectTo ? { options: { emailRedirectTo: this.redirectTo } } : {}),
    });
    if (error) throw fromAuthError(error);
  }

  /**
   * Starts a password reset.
   *
   * Never reveals whether the address exists — the screen says "if that
   * address has an account, we've sent a link" regardless.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email.trim(), {
      ...(this.redirectTo ? { redirectTo: this.redirectTo } : {}),
    });
    if (error) {
      const mapped = fromAuthError(error);
      // Rate limiting is worth surfacing; anything else would disclose whether
      // the address is registered.
      if (mapped.kind === 'rate_limited') throw mapped;
    }
  }

  /**
   * Completes an email link — verification, recovery or magic link.
   *
   * `detectSessionInUrl` is off because on mobile it would let any deep link
   * hand the app a session. That makes completing a link OUR job, and this is
   * where it happens. Supabase sends two shapes and both have to work:
   *
   *   - **PKCE** (`?code=…`), the current default, exchanged for a session
   *     against the verifier this client stored when it sent the email.
   *   - **Token hash** (`?token_hash=…&type=recovery`), used by older
   *     templates and by some providers that rewrite links.
   *
   * Returns the session when the link produced one. A recovery link produces a
   * short-lived session whose only purpose is to authorise a password change.
   */
  async completeAuthLink(
    url: string,
  ): Promise<{ session: AuthSession | null; type: string | null }> {
    let params: URLSearchParams;
    try {
      const parsed = new URL(url);
      // Supabase puts parameters in the query for PKCE and in the fragment for
      // the implicit flow. Reading both means one code path for either.
      const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
      params = new URLSearchParams(`${parsed.search.replace(/^\?/, '')}&${fragment}`);
    } catch {
      throw new NikahMateError('unknown', { detail: 'Unparseable auth link' });
    }

    // Supabase reports link failures in the URL rather than by refusing to
    // open it, so an expired link arrives looking like a success.
    const errorCode = params.get('error_code') ?? params.get('error');
    if (errorCode) {
      throw new NikahMateError(
        errorCode.includes('expired') || errorCode === 'otp_expired'
          ? 'session_expired'
          : 'unknown',
        { detail: params.get('error_description') ?? errorCode },
      );
    }

    const type = params.get('type');

    const code = params.get('code');
    if (code) {
      const { data, error } = await this.supabase.auth.exchangeCodeForSession(code);
      if (error) throw fromAuthError(error);
      return { session: toSession(data.session), type };
    }

    const tokenHash = params.get('token_hash');
    if (tokenHash && type) {
      const { data, error } = await this.supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as 'signup' | 'recovery' | 'email_change' | 'invite' | 'magiclink',
      });
      if (error) throw fromAuthError(error);
      return { session: toSession(data.session), type };
    }

    // Not an auth link at all. Not an error — the app is deep-linkable for
    // other reasons, and this must not hijack every incoming URL.
    return { session: null, type: null };
  }

  /**
   * Sets a new password for the CURRENT session.
   *
   * Requires the recovery session established by `completeAuthLink`. There is
   * no "reset with this token" call and there should not be: the token becomes
   * a session, and changing a password is then an authenticated action like
   * any other. We never handle or store the old password.
   */
  async updatePassword(password: string): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({ password });
    if (error) throw fromAuthError(error);
  }

  /** Re-reads the user from the server. Used to detect verification landing. */
  async refreshUser(): Promise<AuthUser | null> {
    const { data, error } = await this.supabase.auth.getUser();
    if (error) {
      const mapped = fromAuthError(error);
      if (mapped.kind === 'session_expired') return null;
      throw mapped;
    }
    if (!data.user) return null;
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      emailVerified: Boolean(data.user.email_confirmed_at),
    };
  }

  /**
   * Live message delivery for one conversation (Phase 7).
   *
   * Realtime applies RLS PER SUBSCRIBER, so this receives only rows that
   * `messages_select_member` already lets the caller read. The subscription
   * grants nothing a SELECT did not: a non-participant subscribing to another
   * thread's id receives silence rather than messages.
   *
   * The payload is NOT trusted as the message. It carries the row Postgres
   * wrote, but the app re-reads through the API so the shape, the `isMine`
   * flag and the sender's name all come from one place — a client that
   * rendered the raw row would be a second, divergent decoder of the same
   * data.
   *
   * Returns an unsubscribe function. Callers must invoke it on unmount: a
   * leaked channel keeps a websocket open per screen visit, which on a phone
   * is a battery bug that looks like nothing until it is many.
   */
  subscribeToMessages(conversationId: string, onInsert: () => void): () => void {
    const channel = this.supabase
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => onInsert(),
      )
      .subscribe();

    return () => {
      void this.supabase.removeChannel(channel);
    };
  }
}
