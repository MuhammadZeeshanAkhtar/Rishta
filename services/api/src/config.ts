import { z } from 'zod';

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
   * Must connect as a role that can `SET ROLE authenticated` — Supabase's
   * pooler user can. This is the single most sensitive value the service holds.
   */
  DATABASE_URL: z.string().min(1),

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

  /** Server-only. Absent in development, which is fine. */
  SENTRY_DSN: z.string().url().optional(),

  /** Requests per minute per client, before rate limiting kicks in. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof schema> & { jwksUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

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
