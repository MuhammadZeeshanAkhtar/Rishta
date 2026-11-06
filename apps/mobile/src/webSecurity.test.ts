import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCsp,
  injectCsp,
  releaseAddressProblems,
  securityHeadersFile,
} from '../scripts/web-csp.mjs';
import { secureStorage, WEB_SESSION_KEY_SUFFIXES_KEPT_ACROSS_TABS } from './session/secureStorage';

/**
 * Stage 2, Priority 7: the web build's Content-Security-Policy, and where a web
 * session is kept. The policy was also loaded in a real browser against a local
 * build, with no violations. That check is manual; these guard what it was checked
 * against.
 */

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const CONFIG = {
  supabaseUrl: 'https://abc.supabase.co',
  apiBaseUrl: 'https://api.example.test/v1',
};

const directive = (csp: string, name: string): string =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))!
    .slice(name.length + 1);

describe('buildCsp', () => {
  const csp = buildCsp(CONFIG);

  it('runs script only from this site: no inline, no eval, no other origin', () => {
    expect(directive(csp, 'script-src')).toBe("'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'script-src')).not.toContain('unsafe-inline');
  });

  it('talks only to the API and Supabase, with Realtime over a secure socket', () => {
    expect(directive(csp, 'connect-src')).toBe(
      "'self' https://api.example.test https://abc.supabase.co wss://abc.supabase.co",
    );
  });

  it('shows images only from this site and Supabase Storage', () => {
    expect(directive(csp, 'img-src')).toBe("'self' data: blob: https://abc.supabase.co");
  });

  it('closes plugins, base-tag and form-target tricks', () => {
    expect(directive(csp, 'object-src')).toBe("'none'");
    expect(directive(csp, 'base-uri')).toBe("'self'");
    expect(directive(csp, 'form-action')).toBe("'self'");
  });

  it('has no wildcard anywhere', () => {
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toMatch(/https:(\s|;|$)/);
  });

  it('a local build uses plain sockets, for local development only', () => {
    const local = buildCsp({
      supabaseUrl: 'http://localhost:54321',
      apiBaseUrl: 'http://127.0.0.1:3000',
    });
    expect(directive(local, 'connect-src')).toContain('ws://localhost:54321');
  });

  it.each([
    ['not a URL', { supabaseUrl: 'nope', apiBaseUrl: CONFIG.apiBaseUrl }],
    ['an API that is not a URL', { supabaseUrl: CONFIG.supabaseUrl, apiBaseUrl: '' }],
    ['another scheme', { supabaseUrl: 'ftp://x.test', apiBaseUrl: CONFIG.apiBaseUrl }],
  ])('refuses %s rather than writing a broken policy', (_label, config) => {
    expect(() => buildCsp(config)).toThrow();
  });
});

describe('releaseAddressProblems', () => {
  const GOOD = { supabaseUrl: 'https://abc.supabase.co', apiBaseUrl: 'https://api.nikahmate.pk' };

  it('accepts real https addresses', () => {
    expect(releaseAddressProblems(GOOD)).toEqual([]);
  });

  it.each([
    'http://localhost:3000',
    'https://localhost',
    'http://127.0.0.1:3000',
    'http://127.1:3000',
    'http://[::1]:3000',
    'http://10.0.2.2:3000',
    'http://192.168.1.20:3000',
    'http://172.16.0.5:3000',
    'https://api.example.test',
    'https://nikahmate.local',
    'https://app.localhost',
  ])('refuses the API at %s', (apiBaseUrl) => {
    expect(releaseAddressProblems({ ...GOOD, apiBaseUrl })).toEqual([
      'EXPO_PUBLIC_API_BASE_URL is a local or test address',
    ]);
  });

  it('refuses plain http, naming which address', () => {
    expect(releaseAddressProblems({ ...GOOD, apiBaseUrl: 'http://api.nikahmate.pk' })).toEqual([
      'EXPO_PUBLIC_API_BASE_URL is not https',
    ]);
    expect(releaseAddressProblems({ ...GOOD, supabaseUrl: 'http://abc.supabase.co' })).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL is not https',
    ]);
  });

  it('does not mistake a public address for a local one', () => {
    for (const apiBaseUrl of [
      'https://172.15.0.1',
      'https://localhost.nikahmate.pk',
      'https://test.nikahmate.pk',
    ]) {
      expect(releaseAddressProblems({ ...GOOD, apiBaseUrl })).toEqual([]);
    }
  });
});

describe('injectCsp', () => {
  const page = '<!DOCTYPE html><html><head>\n<meta charset="utf-8" /></head><body></body></html>';

  it('puts the policy first in the head, before anything it should govern', () => {
    const html = injectCsp(page, "script-src 'self'");
    const policy = html.indexOf('Content-Security-Policy');
    expect(policy).toBeGreaterThan(html.indexOf('<head>'));
    expect(policy).toBeLessThan(html.indexOf('charset'));
  });

  it('escapes what could break out of the attribute', () => {
    const html = injectCsp(page, 'a" onload="alert(1)');
    expect(html).not.toContain('" onload="');
    expect(html).toContain('&quot;');
  });

  it('stops the build rather than publishing a page without one', () => {
    expect(() => injectCsp('<html><body></body></html>', 'x')).toThrow(/no <head>/);
  });

  it('will not stack two policies', () => {
    expect(() => injectCsp(injectCsp(page, 'x'), 'y')).toThrow(/already has/);
  });
});

describe('securityHeadersFile', () => {
  const file = securityHeadersFile(buildCsp(CONFIG));

  it('adds what only a real header can do', () => {
    expect(file).toContain("frame-ancestors 'none'");
    expect(file).toContain('Strict-Transport-Security: max-age=31536000');
    expect(file).toContain('X-Content-Type-Options: nosniff');
    expect(file).toContain('Referrer-Policy: no-referrer');
  });
});

describe('where a web session is kept', () => {
  const memory = () => {
    const store = new Map<string, string>();
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
  };
  const TOKEN = 'sb-abc-auth-token';
  const VERIFIER = 'sb-abc-auth-token-code-verifier';
  let local: ReturnType<typeof memory>;
  let session: ReturnType<typeof memory>;

  beforeEach(() => {
    local = memory();
    session = memory();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
  });

  it('the session token goes in tab storage, gone when the tab closes', async () => {
    await secureStorage.setItem(TOKEN, 'a-token');
    expect(session.store.get(TOKEN)).toBe('a-token');
    expect(local.store.has(TOKEN)).toBe(false);
    expect(await secureStorage.getItem(TOKEN)).toBe('a-token');
  });

  it('a token an older build left behind is removed, not reused', async () => {
    local.store.set(TOKEN, 'an-old-token');
    expect(await secureStorage.getItem(TOKEN)).toBeNull();
    expect(local.store.has(TOKEN)).toBe(false);
  });

  it('the email-link verifier stays across tabs: the link opens a new one', async () => {
    expect(WEB_SESSION_KEY_SUFFIXES_KEPT_ACROSS_TABS).toContain('-code-verifier');
    await secureStorage.setItem(VERIFIER, 'a-verifier');
    expect(local.store.get(VERIFIER)).toBe('a-verifier');
    expect(await secureStorage.getItem(VERIFIER)).toBe('a-verifier');
  });

  it('signing out removes it from both', async () => {
    await secureStorage.setItem(TOKEN, 'a-token');
    local.store.set(TOKEN, 'an-old-token');
    await secureStorage.removeItem(TOKEN);
    expect(session.store.has(TOKEN)).toBe(false);
    expect(local.store.has(TOKEN)).toBe(false);
  });

  it('blocked storage does not stop the app from starting', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(await secureStorage.getItem(TOKEN)).toBeNull();
    await expect(secureStorage.setItem(TOKEN, 'x')).resolves.toBeUndefined();
  });
});
