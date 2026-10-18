import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { NikahMateClient } from '@nikahmate/api-client';
import { secureStorage } from '../session/secureStorage';

/**
 * The app's single client instance.
 *
 * Configuration comes from `EXPO_PUBLIC_*` variables, which Metro inlines into
 * the bundle at build time. That is exactly why only public values live here:
 * the project URL and the publishable key, both of which are safe to ship
 * (docs/SUPABASE_SETUP.md §3). There is no such thing as a hidden value in a
 * mobile app — anything in the bundle can be extracted from the APK.
 */

/**
 * The env values, read STATICALLY.
 *
 * Metro inlines `EXPO_PUBLIC_*` by substituting the exact text
 * `process.env.EXPO_PUBLIC_NAME` at build time. It is a textual replacement,
 * not a runtime lookup — so `process.env[someVariable]` is never substituted
 * and always reads undefined in a bundle. That produced a build that insisted
 * it was unconfigured while the .env file sat right there, correctly filled in.
 *
 * Every name therefore appears here in full, exactly once.
 */
const INLINED: Record<string, string | undefined> = {
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
};

function readEnv(name: keyof typeof INLINED | string): string | undefined {
  const inlined = INLINED[name];
  if (typeof inlined === 'string' && inlined.trim().length > 0) return inlined.trim();

  // expo-constants carries values injected at runtime by EAS, which is the
  // path a store build without a bundled .env takes.
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const fromExtra = extra?.[name];
  return typeof fromExtra === 'string' && fromExtra.trim().length > 0
    ? fromExtra.trim()
    : undefined;
}

export interface ClientConfig {
  supabaseUrl: string;
  publishableKey: string;
  apiBaseUrl: string;
}

export class MissingConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Missing configuration: ${missing.join(', ')}`);
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

/**
 * Rewrites a localhost API URL to the machine Metro is served from.
 *
 * `http://localhost:3000` is correct in a web build and wrong everywhere else:
 * on a phone or an emulator, localhost is the DEVICE, so every API call fails
 * and the app looks broken in a way that points at the wrong layer — empty
 * dropdowns rather than "cannot reach the server".
 *
 * Expo already knows the right host: `hostUri` is the address the bundle was
 * downloaded from. Reusing it means a device build works without anyone
 * editing .env, and a real configured URL is never touched.
 */
function resolveApiBaseUrl(configured: string): string {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(configured)) return configured;
  // A browser genuinely is on the same machine.
  if (Platform.OS === 'web') return configured;

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = typeof hostUri === 'string' ? hostUri.split(':')[0] : undefined;
  if (!host || host === 'localhost' || host === '127.0.0.1') return configured;

  try {
    const url = new URL(configured);
    url.hostname = host;
    return url.toString().replace(/\/$/, '');
  } catch {
    return configured;
  }
}

export function readClientConfig(): ClientConfig {
  const supabaseUrl = readEnv('EXPO_PUBLIC_SUPABASE_URL');
  const publishableKey = readEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const apiBaseUrl = resolveApiBaseUrl(
    readEnv('EXPO_PUBLIC_API_BASE_URL') ?? 'http://localhost:3000',
  );

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (!publishableKey) missing.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  // Failing loudly at start-up beats every screen failing mysteriously later.
  if (missing.length > 0) throw new MissingConfigError(missing);

  return { supabaseUrl: supabaseUrl!, publishableKey: publishableKey!, apiBaseUrl };
}

let instance: NikahMateClient | null = null;
let localeReader: () => string = () => 'en';

/** Lets the client send Accept-Language without importing the locale provider. */
export function setLocaleReader(reader: () => string): void {
  localeReader = reader;
}

/**
 * Created once, lazily.
 *
 * A second Supabase client would keep its own copy of the session and its own
 * refresh timer — two timers racing to refresh one token is how a session ends
 * up revoked mid-use.
 */
export function getClient(): NikahMateClient {
  if (!instance) {
    const config = readClientConfig();
    instance = new NikahMateClient({
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.publishableKey,
      apiBaseUrl: config.apiBaseUrl,
      storage: secureStorage,
      // Matches `scheme` in app.json, and must be registered under
      // Authentication -> URL Configuration in the Supabase dashboard.
      redirectTo: 'nikahmate://auth/callback',
      getLocale: () => localeReader(),
    });
  }
  return instance;
}
