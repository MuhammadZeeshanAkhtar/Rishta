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
  }
}

export interface AuthPluginOptions {
  verifier: TokenVerifier;
}

/**
 * Registers `fastify.requireAuth`, a preHandler that verifies the bearer token
 * and attaches the result to the request.
 *
 * Authentication is opt-in per route rather than global. A global hook with
 * per-route opt-OUT means a new public route is one forgotten line away from
 * leaking; this way a new route is closed until someone deliberately opens it,
 * and the mistake fails safe.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  fastify.decorateRequest('auth', undefined);

  fastify.decorate('requireAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerFrom(request.headers.authorization);
    if (!token) {
      throw unauthenticated('Authorization header missing');
    }
    request.auth = await options.verifier.verify(token);
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
