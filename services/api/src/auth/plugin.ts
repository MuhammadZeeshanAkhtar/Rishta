import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthenticated } from '../errors';
import { bearerFrom, type AuthContext, type TokenVerifier } from './verify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after `requireAuth` has run. */
    auth?: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
}

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

  fastify.decorate('requireAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    const result = await verifyOnce(request);
    if (!result) {
      throw unauthenticated('Authorization header missing');
    }
    // The verifier's own error, unchanged — an expired token and a malformed
    // one still say different things to the client.
    if (!result.ok) throw result.error;
    request.auth = result.context;
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
