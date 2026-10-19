import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config';
import { ApiError, internalError } from './errors';
import authPlugin from './auth/plugin';
import type { TokenVerifier } from './auth/verify';
import type { Db } from './db/types';
import type { StorageClient } from './storage/client';
import { accountRoutes } from './routes/account';
import { conversationRoutes } from './routes/conversations';
import { discoveryRoutes } from './routes/discovery';
import { familyRoutes } from './routes/family';
import { interestRoutes } from './routes/interests';
import { matchRoutes } from './routes/matches';
import { notificationRoutes } from './routes/notifications';
import { photoRoutes } from './routes/photos';
import { profileRoutes } from './routes/profile';
import { referenceRoutes } from './routes/reference';
import { safetyRoutes } from './routes/safety';
import { captureException } from './observability/sentry';

export interface BuildAppOptions {
  config: Config;
  db: Db;
  verifier: TokenVerifier;
  /** Reached with the caller's own token; never a service-role key. */
  storage: StorageClient;
}

/**
 * Builds the Fastify instance without listening, so tests drive it through
 * `app.inject()` against a real database rather than a mocked one.
 */
export async function buildApp({
  config,
  db,
  verifier,
  storage,
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

  /**
   * CORS.
   *
   * Without this the API is unreachable from any browser — which includes the
   * Expo web build used to check the UI, and the future website the plan says
   * runs on this same API with "zero backend changes required". A native app
   * sends no Origin header and is unaffected either way.
   *
   * The allowlist is explicit and empty by default, so nothing is permitted
   * that was not named. Development additionally accepts localhost on any
   * port, because Metro and `expo export` pick a port per run and pinning one
   * would mean editing config to look at your own app.
   */
  const allowedOrigins = (config.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const isDevelopment = config.NODE_ENV !== 'production';

  await app.register(cors, {
    origin(origin, callback) {
      // No Origin: a native app, curl, or a server-to-server call. CORS does
      // not apply to these, and refusing them would break the mobile client.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      // Refused by omitting the header rather than by erroring: the browser
      // blocks the response, and the server stays quiet about what it allows.
      callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Accept-Language'],
    maxAge: 86_400,
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
  await app.register(profileRoutes, { db });
  await app.register(photoRoutes, { db, storage });
  await app.register(discoveryRoutes, { db });
  await app.register(interestRoutes, { db });
  await app.register(matchRoutes, { db });
  await app.register(notificationRoutes, { db });
  await app.register(safetyRoutes, { db });
  await app.register(familyRoutes, { db });
  await app.register(conversationRoutes, { db });

  return app;
}
