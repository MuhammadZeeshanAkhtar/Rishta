import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { parseTrustProxy, type Config } from './config';
import { ApiError, internalError } from './errors';
import { mapDatabaseError, problemCodeForStatus } from './http/problems';
import authPlugin from './auth/plugin';
import type { TokenVerifier } from './auth/verify';
import type { Db } from './db/types';
import type { StorageClient } from './storage/client';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { meRoutes } from './routes/me';
import { conversationRoutes } from './routes/conversations';
import { discoveryRoutes } from './routes/discovery';
import { familyRoutes } from './routes/family';
import { interestRoutes } from './routes/interests';
import { matchRoutes } from './routes/matches';
import { notificationRoutes } from './routes/notifications';
import { photoRoutes } from './routes/photos';
import { photoAccessRoutes } from './routes/photo-access';
import { profileRoutes } from './routes/profile';
import { publicProfileRoutes } from './routes/public-profile';
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
    // Limit it in production: see TRUST_PROXY in config.ts.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    logController: new LogController({ disableRequestLogging: config.NODE_ENV === 'test' }),
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

  // Auth is registered BEFORE the limiter (review B9). The limiter keys on
  // `app.authSubject()`, which must exist when its hooks are installed.
  // Authentication itself stays opt-in per route: `authSubject` never rejects
  // a request, it only tells the limiter who is asking.
  await app.register(authPlugin, { verifier, db });

  // The tighter ceiling for the routes that send something to another person.
  // An onRoute hook rather than a `config` block on each route, so the list
  // is in one place — and registered BEFORE the limiter, because the limiter
  // reads `config.rateLimit` in its own onRoute hook and hooks run in
  // registration order.
  const sendRoutes = new Set([
    'POST /conversations/:id/messages',
    'POST /interests',
    'POST /reports',
    'POST /family/invitations',
    'POST /profiles/:userId/photo-request',
  ]);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.some((method) => sendRoutes.has(`${method} ${route.url}`))) {
      route.config = {
        ...route.config,
        rateLimit: { max: config.RATE_LIMIT_SENDS_PER_MINUTE, timeWindow: '1 minute' },
      };
    }
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // REVIEW B9. Keyed by the VERIFIED member where there is one, so a shared
    // NAT — a mobile carrier, an office, a campus — does not put everyone
    // behind it in one bucket. This used to read `request.auth`, which is not
    // set until `requireAuth` runs in the route's preHandler, long after this
    // runs in onRequest: every caller was keyed by IP, and the comment here
    // claimed the opposite. Prefixed so a user id can never collide with an
    // address.
    keyGenerator: async (request) => {
      const subject = await app.authSubject(request);
      return subject ? `user:${subject}` : `ip:${request.ip}`;
    },
  });

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
      if (error.status >= 500) {
        // Ours, not theirs: log the detail (review B15 — it may carry an
        // upstream response) and report it. The body below carries none of it.
        request.log.error({ err: error, cause: error.cause }, 'Internal error');
        captureException(error);
      }
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

    // REVIEW B21. Every Fastify 4xx used to come back as `validation_failed`,
    // so a client could not tell "photo too large" from "bad field". The
    // status is kept; the code now says which.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        code: problemCodeForStatus(error.statusCode, error.code),
        message: error.message,
      });
    }

    // REVIEW B14. A database error the CALLER caused — a malformed id, a
    // duplicate, a violated invariant, a write the row policy refuses — is a
    // 4xx, not a 500 and a Sentry alert. Logged at warn, never reported as an
    // exception, and the Postgres text is never returned.
    const mapped = mapDatabaseError(error);
    if (mapped) {
      request.log.warn({ pgCode: (error as { code?: string }).code }, 'database refused request');
      return reply.code(mapped.status).send(mapped.toBody());
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
  // Review L4: another member's profile, permission-filtered.
  await app.register(publicProfileRoutes, { db });
  // Review L10: account self-service (entitlements, quotas, devices, lifecycle,
  // notification preferences, push tokens).
  await app.register(meRoutes, { db });
  await app.register(photoRoutes, { db, storage });
  // Review L3: another member's photos and photo requests (0031).
  await app.register(photoAccessRoutes, { db, storage });
  await app.register(discoveryRoutes, { db });
  await app.register(interestRoutes, { db });
  await app.register(matchRoutes, { db });
  await app.register(notificationRoutes, { db });
  await app.register(safetyRoutes, { db });
  // Review L1: the moderation backend. Staff only; see routes/admin.ts.
  await app.register(adminRoutes, { db, storage });
  await app.register(familyRoutes, { db });
  await app.register(conversationRoutes, { db });

  return app;
}
