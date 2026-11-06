import { z } from 'zod';
import { DATABASE_SSL_MODES } from './db/tls';

/**
 * Environment configuration, validated at boot.
 *
 * The process refuses to start on a bad or missing value rather than failing
 * on the first request that needs it. A server that starts with no JWT
 * verification key configured is worse than one that does not start.
 *
 * Note which names are ABSENT here: no Gemini key (not used in v1 at all), and
 * no Supabase service-role key — this service reaches Postgres directly over
 * DATABASE_URL, so the service-role key is not needed and is therefore not
 * accepted. The fewer secrets a process can hold, the fewer it can leak.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Server-only. Full Postgres connection string.
   *
   * Must connect as a role that can `SET ROLE api_member` (migration 0033 grants
   * it to whoever ran the migration). This is the single most sensitive value the service holds.
   */
  DATABASE_URL: z.string().min(1),

  /**
   * How the database connection is secured; see db/tls.ts. Defaults to
   * `verify-full`, or `disable` for localhost. `require` and `disable` are refused
   * for a remote database when NODE_ENV=production.
   */
  DATABASE_SSL_MODE: z.enum(DATABASE_SSL_MODES).optional(),

  /** The database's CA, as PEM text or a file path. Supabase needs this. */
  DATABASE_SSL_CA: z.string().optional(),

  /** Public. Also the issuer used to locate the JWKS endpoint. */
  SUPABASE_URL: z.string().url(),

  /**
   * Legacy HS256 JWT secret. Server-only.
   *
   * Optional: projects using asymmetric signing keys verify through JWKS
   * instead. Exactly one of the two paths must be available, which is checked
   * below rather than discovered at the first request.
   */
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),

  /** Defaults to the project's standard JWKS endpoint. */
  SUPABASE_JWKS_URL: z.string().url().optional(),

  /**
   * The project's PUBLISHABLE key, sent as `apikey` on Storage calls.
   *
   * Public by design — it identifies the project and grants nothing on its
   * own, which is why the same value ships inside the mobile app. Storage
   * authorises on the forwarded member JWT and its RLS policies, never on
   * this. It is NOT the service-role key, which this service refuses to hold.
   */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  /** Server-only. Absent in development, which is fine. */
  SENTRY_DSN: z.string().url().optional(),

  /**
   * Requests per minute per MEMBER (per IP when unauthenticated), before rate
   * limiting kicks in. Review B9: this was always per IP in practice.
   */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

  /**
   * The tighter per-member ceiling on the four routes that create something
   * another person receives: messages, interests, reports and family
   * invitations (review B9). A spammer is limited by this, not by the general
   * budget a member spends scrolling Discover.
   */
  RATE_LIMIT_SENDS_PER_MINUTE: z.coerce.number().int().positive().default(30),

  /**
   * Browser origins allowed to call this API, comma-separated.
   *
   * Empty by default, which is the safe direction: a native app sends no
   * Origin header and is unaffected, so nothing is permitted that was not
   * named. The future website (README §19) adds its origin here rather than
   * needing a backend change — which is the promise the plan makes.
   *
   * Development additionally allows localhost on any port; see app.ts.
   */
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  /**
   * Which proxies may say who the client is, through X-Forwarded-For.
   *
   * Unset means every proxy, which is what this service has always done and what a
   * deployment behind a load balancer relies on. Anyone who can reach the API directly
   * could then pick their own IP address, and with it a fresh rate-limit bucket for
   * signed-out requests. Set it for production: the number of proxies in front of the
   * API (usually `1`), their addresses, or `false` when there are none.
   */
  TRUST_PROXY: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { jwksUrl: string };

/** `TRUST_PROXY` as Fastify wants it. See the setting above. */
export function parseTrustProxy(
  value: string | undefined,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  const text = value?.trim();
  if (!text || text === 'true') return true;
  if (text === 'false') return false;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return (_address, hop) => hop < hops;
  }
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An .env file has no way to say "absent" other than an empty value, and
  // docs/SUPABASE_SETUP.md tells you to leave SUPABASE_JWT_SECRET,
  // SUPABASE_JWKS_URL and SENTRY_DSN blank. Zod's .optional() only covers a
  // MISSING key, so an empty string reaches .min(16) or .url() and fails —
  // meaning the documented setup produced a service that could not boot.
  //
  // Empty and unset mean the same thing here, so make that true before parsing.
  const present: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim().length === 0) continue;
    present[key] = value;
  }

  const parsed = schema.safeParse(present);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const config = parsed.data;
  const jwksUrl =
    config.SUPABASE_JWKS_URL ??
    `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;

  return { ...config, jwksUrl };
}

/**
 * Names that must never appear in this service's environment.
 *
 * Checked at boot so a key added "just to try something" fails loudly instead
 * of quietly becoming a dependency. v1 uses no AI provider at all (ADR 0006).
 */
export const FORBIDDEN_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

export function assertNoForbiddenSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const present = FORBIDDEN_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });

  if (present.length > 0) {
    throw new Error(
      `Refusing to start: ${present.join(', ')} present in the environment. ` +
        `v1 uses no AI provider (ADR 0006), and this service reaches Postgres ` +
        `directly rather than through the service-role key. Remove them.`,
    );
  }
}
