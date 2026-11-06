import { isAccountUsable, type Me } from '@nikahmate/domain';

/**
 * The routing decisions behind the session gates, free of React so they are
 * tested directly. Routing mirrors the server's decision and never makes it: the
 * API refuses a restricted account whatever screen the app is showing.
 *
 *   signed_out     no session
 *   unverified     session, email not confirmed
 *   onboarding     verified, profile incomplete
 *   restricted     suspended, banned, deactivated or pending deletion (review N7)
 *   ready          verified, profile complete
 */

export type SessionState =
  'loading' | 'misconfigured' | 'signed_out' | 'unverified' | 'onboarding' | 'restricted' | 'ready';

/** Restriction wins over profile completeness: onboarding could not fix it. */
export function sessionStateFor(
  session: { user: { emailVerified: boolean } } | null,
  me: Pick<Me, 'status' | 'profileCompleted'> | null,
): SessionState {
  if (!session) return 'signed_out';
  if (!session.user.emailVerified) return 'unverified';
  if (!me) return 'onboarding';
  if (!isAccountUsable(me.status)) return 'restricted';
  return me.profileCompleted && me.status === 'active' ? 'ready' : 'onboarding';
}

export type GateArea = 'index' | 'app' | 'onboarding' | 'admin' | 'restricted' | 'deletion';

/**
 * Where a screen group sends someone, or null to let it render. `loading` and
 * the misconfigured message are left to the group, which renders its own.
 */
export function redirectFor(area: GateArea, state: SessionState): string | null {
  if (state === 'loading') return null;
  if (state === 'signed_out' || state === 'misconfigured') {
    if (area === 'index' && state === 'misconfigured') return null;
    return area === 'admin' ? '/(auth)/sign-in' : '/(auth)/welcome';
  }
  if (state === 'unverified') return '/(auth)/verify-email';
  // A restricted account may still ask for deletion. The route sends anyone whose
  // request is already open on to the pending state.
  if (state === 'restricted') {
    return area === 'restricted' || area === 'deletion' ? null : '/restricted';
  }

  switch (area) {
    case 'index':
      return state === 'onboarding' ? '/(onboarding)/basics' : '/discover';
    case 'app':
      return state === 'onboarding' ? '/(onboarding)/basics' : null;
    case 'onboarding':
      return state === 'ready' ? '/discover' : null;
    case 'admin':
      // A staff account need not be a completed member profile.
      return null;
    case 'deletion':
      return null;
    case 'restricted':
      return '/';
  }
}
