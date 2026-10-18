import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/**
 * Regression: a blank value in .env must mean "not set".
 *
 * docs/SUPABASE_SETUP.md instructs leaving SUPABASE_JWT_SECRET, SUPABASE_JWKS_URL
 * and SENTRY_DSN blank. Before this was handled, following those instructions
 * produced `Too small` / `Invalid URL` and the service refused to start — a
 * failure that only appeared once the .env file was actually loaded.
 */
describe('loadConfig — blank values mean absent', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@h:5432/postgres',
    SUPABASE_URL: 'https://example.supabase.co',
  };

  it('accepts blank optional values, as the setup guide tells you to leave them', () => {
    const config = loadConfig({
      ...base,
      SUPABASE_JWT_SECRET: '',
      SUPABASE_JWKS_URL: '',
      SENTRY_DSN: '   ',
    } as NodeJS.ProcessEnv);

    expect(config.SUPABASE_JWT_SECRET).toBeUndefined();
    expect(config.SENTRY_DSN).toBeUndefined();
    // Derived from SUPABASE_URL, which is why a blank JWKS URL is fine.
    expect(config.jwksUrl).toBe('https://example.supabase.co/auth/v1/.well-known/jwks.json');
  });

  it('still rejects a genuinely invalid value', () => {
    expect(() =>
      loadConfig({ ...base, SUPABASE_JWKS_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    ).toThrow(/SUPABASE_JWKS_URL/);
  });

  it('still requires DATABASE_URL', () => {
    expect(() => loadConfig({ SUPABASE_URL: base.SUPABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });
});
