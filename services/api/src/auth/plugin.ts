import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { isAccountUsable } from '@nikahmate/domain';
import type { Db } from '../db/types';
import { accountRestricted, unauthenticated } from '../errors';
import { bearerFrom, type AuthContext, type TokenVerifier } from './verify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after `requireAuth` has run. */
    auth?: AuthContext;
  }
  interface FastifyInstance {
    /**
     * A verified token AND an account allowed to use the product (review N1).
     * The default for every protected route: a new route is closed to a
     * restricted account until someone deliberately opens it.
     */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * A verified token only. For the short list of routes a restricted account
     * still needs: exactly RESTRICTED_ACCOUNT_ROUTES below, enforced by a test.
     */
    requireIdentity: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * The VERIFIED subject of this request's bearer token, or null.
     *
     * For the rate limiter, which runs before any route's preHandler and so
     * before `requireAuth`. It never throws and never sets `request.auth`: a
     * request that is not authenticated is simply keyed by IP, and the route
     * still decides for itself whether authentication is required.
     */
    authSubject: (request: FastifyRequest) => Promise<string | null>;
  }
}

export interface AuthPluginOptions {
  verifier: TokenVerifier;
  db: Db;
}

/**
 * Every route a restricted account may still reach (review N1), and why. Each
 * handler keeps its own rules: being on this list only means the request gets as
 * far as them. Anything else answers 403 `account_restricted`.
 *
 * Sign-out itself is a Supabase Auth call and never reaches this API. Moderator
 * notes, appeals and data export are not here: no such member route exists.
 */
export const RESTRICTED_ACCOUNT_ROUTES = [
  // Learning where the account stands. The app explains from this answer.
  'POST /account/bootstrap',
  'GET /me',
  // Lifecycle. Each handler allows only its one transition: only a deactivated
  // account reactivates, only an active one deactivates (review-phase4 tests), so
  // a suspended or banned member cannot pass through these to lift a restriction.
  'POST /me/deactivate',
  'POST /me/reactivate',
  // Existing rule R4: a restricted member may ask for erasure, and the request is
  // held. Cancelling returns to the exact previous status.
  'POST /me/delete',
  'DELETE /me/delete',
  // Part of signing out: stops pushes reaching a device no longer in use.
  'DELETE /me/push-tokens/:deviceId',
] as const;

/** One verification per request, whichever caller asks first. */
type Verification = { ok: true; context: AuthContext } | { ok: false; error: unknown };

/**
 * Registers `fastify.requireAuth`, a preHandler that verifies the bearer token
 * and attaches the result to the request.
 *
 * Authentication is opt-in per route rather than global. A global hook with
 * per-route opt-OUT means a new public route is one forgotten line away from
 * leaking; this way a new route is closed until someone deliberately opens it,
 * and the mistake fails safe.
 *
 * REVIEW B9. The rate limiter needs the caller's identity, and it runs in
 * `onRequest` — before any route preHandler, so before `requireAuth`. It used
 * to read `request.auth`, which is always undefined at that point, so every
 * caller was keyed by IP: a mobile carrier's NAT put hundreds of members in
 * one 120-a-minute bucket. `authSubject` gives the limiter the VERIFIED
 * subject without changing the opt-in design above:
 *
 *   * it never rejects — an absent or invalid token just yields null;
 *   * it never sets `request.auth`, so `requireAuthContext` still catches a
 *     route that forgot `requireAuth`;
 *   * the verification is memoised per request, so `requireAuth` reuses it
 *     and a token is verified once, not twice.
 *
 * Verified, not decoded. Keying on an unverified `sub` would let anyone spread
 * requests across buckets by forging subjects; a forged token fails here and
 * falls back to its IP.
 *
 * REVIEW N1. Nothing checked `users.status` on a request, so a suspended, banned,
 * deactivated or pending-deletion member could keep messaging, sending interests
 * and reading feeds. The check sits in `requireAuth` itself, so every route that
 * was already protected is covered, and the exceptions must be asked for by name.
 * It is read fresh on every request: a ban takes effect on the next call, not
 * when a cache or token expires.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  fastify.decorateRequest('auth', undefined);

  const verifications = new WeakMap<FastifyRequest, Promise<Verification | null>>();

  /** Null when there is no bearer token at all. */
  const verifyOnce = (request: FastifyRequest): Promise<Verification | null> => {
    const existing = verifications.get(request);
    if (existing) return existing;

    const token = bearerFrom(request.headers.authorization);
    const pending: Promise<Verification | null> = token
      ? options.verifier.verify(token).then(
          (context): Verification => ({ ok: true, context }),
          (error: unknown): Verification => ({ ok: false, error }),
        )
      : Promise.resolve(null);

    verifications.set(request, pending);
    return pending;
  };

  fastify.decorate('authSubject', async (request: FastifyRequest): Promise<string | null> => {
    const result = await verifyOnce(request);
    return result?.ok ? result.context.authUserId : null;
  });

  const authenticate = async (request: FastifyRequest): Promise<AuthContext> => {
    const result = await verifyOnce(request);
    if (!result) {
      throw unauthenticated('Authorization header missing');
    }
    // The verifier's own error, unchanged — an expired token and a malformed
    // one still say different things to the client.
    if (!result.ok) throw result.error;
    request.auth = result.context;
    return result.context;
  };

  const readAccount = async (authUserId: string) => {
    const rows = await options.db.asUser(authUserId, (session) =>
      session.query<{ user_id: string | null; status: string | null }>(
        `select app.current_user_id() as user_id,
                (select u.status from public.users u
                  where u.id = app.current_user_id()) as status`,
      ),
    );
    return rows[0] ?? { user_id: null, status: null };
  };

  /**
   * Whether this caller's account may use the product. True when there is no
   * account yet: bootstrap creates it, and every other route answers 404 for it.
   *
   * A suspension whose end date has passed ends here, before the answer, so the
   * member is not locked out until a maintenance run happens to come along. If
   * lifting fails the account stays restricted: an error must never let someone
   * through, and it must not turn a refusal into a 500 either.
   */
  const accountMayAct = async (request: FastifyRequest, authUserId: string): Promise<boolean> => {
    let account = await readAccount(authUserId);
    if (!account.user_id) return true;
    if (account.status === 'suspended') {
      const userId = account.user_id;
      try {
        await options.db.asService('account.lift_expired_suspension', (session) =>
          session.query(`select app.lift_expired_suspensions($1::uuid)`, [userId]),
        );
        account = await readAccount(authUserId);
      } catch (error) {
        request.log.error({ err: error }, 'could not check for an expired suspension');
      }
    }
    // A link whose user row is hidden is a soft-deleted account: status is null.
    return account.status !== null && isAccountUsable(account.status);
  };

  fastify.decorate('requireAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = await authenticate(request);
    if (!(await accountMayAct(request, auth.authUserId))) throw accountRestricted();
  });

  fastify.decorate('requireIdentity', async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = await authenticate(request);
    // The answer does not matter here, but an expired suspension must still end:
    // these are the routes the app calls to find out where it stands.
    await accountMayAct(request, auth.authUserId);
  });
};

export default fp(authPlugin, { name: 'auth' });

/** Narrows an authenticated request. Throws rather than returning undefined. */
export function requireAuthContext(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    // Reaching here means a route asked for the auth context without listing
    // requireAuth as a preHandler — a wiring bug, not a client error.
    throw unauthenticated('Route is not protected by requireAuth');
  }
  return request.auth;
}
