import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A release build must never quietly talk to localhost. On a phone that is the phone,
 * so every request fails in a way that looks like the server is down. Missing
 * configuration has to stop the app at start-up, where the app already says what is wrong.
 */

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-linking', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('../session/secureStorage', () => ({ secureStorage: {} }));
vi.mock('@nikahmate/api-client', () => ({ NikahMateClient: class {} }));

const NAMES = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_API_BASE_URL',
];

const load = async (dev: boolean, env: Record<string, string>) => {
  vi.stubGlobal('__DEV__', dev);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return import('./client');
};

const SUPABASE = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
};

describe('readClientConfig', () => {
  beforeEach(() => {
    for (const name of NAMES) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('a release build with no API address says so, rather than using localhost', async () => {
    const { readClientConfig, MissingConfigError } = await load(false, SUPABASE);
    expect(() => readClientConfig()).toThrow(MissingConfigError);
    try {
      readClientConfig();
    } catch (error) {
      expect((error as InstanceType<typeof MissingConfigError>).missing).toEqual([
        'EXPO_PUBLIC_API_BASE_URL',
      ]);
    }
  });

  it('a development build may still assume a local API', async () => {
    const { readClientConfig } = await load(true, SUPABASE);
    expect(readClientConfig().apiBaseUrl).toBe('http://localhost:3000');
  });

  it('a configured address is used as given, in either kind of build', async () => {
    const env = { ...SUPABASE, EXPO_PUBLIC_API_BASE_URL: 'https://api.nikahmate.pk' };
    for (const dev of [true, false]) {
      const { readClientConfig } = await load(dev, env);
      expect(readClientConfig().apiBaseUrl).toBe('https://api.nikahmate.pk');
    }
  });

  it('reports everything missing at once', async () => {
    const { readClientConfig, MissingConfigError } = await load(false, {});
    try {
      readClientConfig();
      expect.unreachable('it should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigError);
      expect((error as InstanceType<typeof MissingConfigError>).missing).toEqual(NAMES);
    }
  });
});
