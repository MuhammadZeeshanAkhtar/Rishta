import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The handover build configuration: every EAS profile produces an APK, and the
 * committed environment examples carry names only — never a value that could
 * be a secret. Also keeps each example in step with what the code reads.
 */

const ROOT = join(__dirname, '..');
const API = join(ROOT, '..', '..', 'services', 'api');

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

/** `NAME=value` lines of an env file, comments skipped. */
function entries(text: string): Array<[string, string]> {
  return text
    .split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    });
}

describe('eas.json', () => {
  const eas = JSON.parse(read(ROOT, 'eas.json')) as {
    build: Record<string, { android?: { buildType?: string } }>;
  };

  it('builds an APK in every profile, never an AAB', () => {
    expect(Object.keys(eas.build).sort()).toEqual(['base', 'preview', 'production-apk']);
    for (const profile of Object.values(eas.build)) expect(profile.android?.buildType).toBe('apk');
    expect(read(ROOT, 'eas.json')).not.toMatch(/app-bundle/);
  });

  it('holds no environment values: they come from the EAS project', () => {
    expect(read(ROOT, 'eas.json')).not.toMatch(/EXPO_PUBLIC_|supabase\.co|"env"/);
  });
});

describe('what every build carries', () => {
  it('app.json holds no address: it goes into the bundle whatever the environment says', () => {
    expect(read(ROOT, 'app.json')).not.toMatch(/localhost|127\.0\.0\.1|https?:\/\//);
  });

  it('the release export refuses local addresses, and only the local one may skip that', () => {
    const scripts = (JSON.parse(read(ROOT, 'package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['web:export']).toContain('apply-web-csp.mjs');
    expect(scripts['web:export']).not.toContain('--allow-local');
    expect(scripts['web:export:local']).toContain('--allow-local');
    // The same files Expo reads for a production bundle, or the policy would name
    // different addresses from the ones the bundle calls.
    for (const file of ['.env', '.env.production', '.env.local', '.env.production.local']) {
      expect(scripts['web:export']).toContain(`--env-file-if-exists=${file} `);
    }
  });
});

describe('apps/mobile/.env.example', () => {
  const list = entries(read(ROOT, '.env.example'));

  it('names exactly what the client reads, all public', () => {
    const client = read(ROOT, 'src', 'api', 'client.ts');
    const used = [
      ...new Set(
        [...client.matchAll(/^ {2}(EXPO_PUBLIC_[A-Z_]+): process\.env\./gm)].map((m) => m[1]!),
      ),
    ];
    expect(list.map(([name]) => name).sort()).toEqual([...used].sort());
  });

  it('carries no value except the localhost development default', () => {
    for (const [name, value] of list) {
      if (name === 'EXPO_PUBLIC_API_BASE_URL') expect(value).toBe('http://localhost:3000');
      else expect(value, name).toBe('');
    }
  });
});

describe('services/api/.env.example', () => {
  const list = entries(read(API, '.env.example'));

  it('names exactly what the config schema reads', () => {
    const config = read(API, 'src', 'config.ts');
    const schema = [...config.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
    expect(schema.length).toBeGreaterThan(5);
    expect(list.map(([name]) => name).sort()).toEqual([...new Set(schema)].sort());
  });

  it('leaves every credential blank', () => {
    const blank = [
      'DATABASE_URL',
      'SUPABASE_URL',
      'SUPABASE_JWT_SECRET',
      'SUPABASE_PUBLISHABLE_KEY',
      'SENTRY_DSN',
    ];
    for (const name of blank) expect(list.find(([n]) => n === name)?.[1], name).toBe('');
    expect(list.map(([name]) => name)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
