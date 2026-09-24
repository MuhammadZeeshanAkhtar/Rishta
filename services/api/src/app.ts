import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import { ApiError, internalError } from './errors.js';
import authPlugin from './auth/plugin.js';
import type { TokenVerifier } from './auth/verify.js';
import type { Db } from './db/types.js';
import { accountRoutes } from './routes/account.js';
import { referenceRoutes } from './routes/reference.js';
import { captureException } from './observability/sentry.js';

export interface BuildAppOptions {
  config: Config;
  db: Db;
  verifier: TokenVerifier;
}

/**
 * Builds the Fastify instance without listening, so tests drive it through
 * `app.inject()` against a real database rather than a mocked one.
 */
export async function buildApp({
  config,
  db,
  verifier,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Structured logs, with the obvious footguns removed. An access log that
      // records bearer tokens is a credential store nobody meant to create.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
        ],
        remove: true,
      },
      serializers: {
        req(request) {
          return { method: request.method, url: request.url, id: request.id };
        },
      },
    },
    // Trust the proxy so rate limiting keys on the real client address rather
    // than on the load balancer, which would make one bucket for everybody.
    trustProxy: true,
    disableRequestLogging: config.NODE_ENV === 'test',
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Keyed by authenticated subject where available, so one shared NAT does
    // not throttle an entire office or campus.
    keyGenerator: (request) => request.auth?.authUserId ?? request.ip,
  });

  await app.register(authPlugin, { verifier });

  // ---------------------------------------------------------------------------
  // Error handling is installed BEFORE any route.
  //
  // `await app.register(...)` boots a plugin immediately, and a plugin captures
  // the error handler present at the moment it is created. Registering routes
  // first left them on Fastify's default handler, which silently dropped the
  // `fields` of a validation Problem and emitted Fastify's own error shape
  // instead of ours. Ordering is load-bearing here, not stylistic.
  // ---------------------------------------------------------------------------

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ code: 'not_found', message: 'Not found' });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        void reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply.code(error.status).send(error.toBody());
    }

    // Fastify's own rate limiter throws with a 429 statusCode.
    if (typeof error.statusCode === 'number' && error.statusCode === 429) {
      return reply
        .code(429)
        .send({ code: 'rate_limited', message: 'Too many requests. Please slow down.' });
    }

    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        code: 'validation_failed',
        message: error.message,
      });
    }

    // Unexpected. Log and report the detail; return none of it. An error
    // message is a description of internals, and internals are not the
    // caller's business.
    request.log.error({ err: error }, 'Unhandled error');
    captureException(error);
    const problem = internalError();
    return reply.code(problem.status).send(problem.toBody());
  });

  // Routes last, so every one of them inherits the handlers above.

  app.get('/health', async () => {
    const rows = await db.asAnon((session) => session.query<{ ok: number }>('select 1 as ok'));
    return { status: 'ok', database: rows[0]?.ok === 1 ? 'ok' : 'degraded' };
  });

  await app.register(accountRoutes, { db });
  await app.register(referenceRoutes, { db });

  return app;
}
