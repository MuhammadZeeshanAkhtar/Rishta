import { describe, expect, it, vi } from 'vitest';
import { AuthClient } from './auth';
import { NikahMateError } from './errors';

/**
 * Completing an email link.
 *
 * The happy path is the least interesting case here. What actually reaches
 * users is the other three: a link tapped a day late, a link already used, and
 * a link opened on a device that never requested it. Supabase reports the
 * first two *inside the URL* rather than by refusing to open it, so a naive
 * implementation treats an expired link as a success and then fails somewhere
 * further in with no explanation.
 */

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
};

function client(): AuthClient {
  return new AuthClient({
    supabaseUrl: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    storage: memoryStorage(),
    redirectTo: 'nikahmate://auth/callback',
  });
}

/** Replaces the two Supabase calls completeAuthLink can make. */
function stub(
  auth: AuthClient,
  impl: { exchange?: unknown; verify?: unknown } = {},
): { exchange: ReturnType<typeof vi.fn>; verifyOtp: ReturnType<typeof vi.fn> } {
  const exchange = vi.fn(async () => impl.exchange ?? { data: { session: null }, error: null });
  const verifyOtp = vi.fn(async () => impl.verify ?? { data: { session: null }, error: null });
  // @ts-expect-error — reaching into the private client is the point: these
  // are the only two calls this method makes, and stubbing them keeps the test
  // off the network without mocking the whole SDK.
  auth.supabase.auth.exchangeCodeForSession = exchange;
  // @ts-expect-error — same.
  auth.supabase.auth.verifyOtp = verifyOtp;
  return { exchange, verifyOtp };
}

const session = {
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 123,
  user: { id: 'u1', email: 'a@b.test', email_confirmed_at: '2026-01-01T00:00:00Z' },
};

describe('completeAuthLink', () => {
  it('exchanges a PKCE code and reports the link type', async () => {
    const auth = client();
    const { exchange } = stub(auth, { exchange: { data: { session }, error: null } });

    const result = await auth.completeAuthLink('nikahmate://auth/callback?code=abc123&type=signup');

    expect(exchange).toHaveBeenCalledWith('abc123');
    expect(result.type).toBe('signup');
    expect(result.session?.user.id).toBe('u1');
    expect(result.session?.user.emailVerified).toBe(true);
  });

  it('handles a token_hash link, which older templates still send', async () => {
    const auth = client();
    const { verifyOtp } = stub(auth, { verify: { data: { session }, error: null } });

    const result = await auth.completeAuthLink(
      'nikahmate://auth/callback?token_hash=xyz&type=recovery',
    );

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'xyz', type: 'recovery' });
    expect(result.type).toBe('recovery');
  });

  it('reads parameters from the fragment as well as the query', async () => {
    // The implicit flow puts them after the '#'. One code path has to cover
    // both or half the links silently do nothing.
    const auth = client();
    const { exchange } = stub(auth, { exchange: { data: { session }, error: null } });

    await auth.completeAuthLink('nikahmate://auth/callback#code=frag456&type=magiclink');
    expect(exchange).toHaveBeenCalledWith('frag456');
  });

  it('treats an expired link as expired, not as a success', async () => {
    const auth = client();
    stub(auth);

    await expect(
      auth.completeAuthLink(
        'nikahmate://auth/callback?error=access_denied&error_code=otp_expired' +
          '&error_description=Email+link+is+invalid+or+has+expired',
      ),
    ).rejects.toMatchObject({ kind: 'session_expired' });
  });

  it('surfaces a non-expiry link error rather than swallowing it', async () => {
    const auth = client();
    stub(auth);

    await expect(
      auth.completeAuthLink('nikahmate://auth/callback?error=server_error'),
    ).rejects.toBeInstanceOf(NikahMateError);
  });

  it('checks for an error before trying to redeem the code', async () => {
    // An errored URL can still carry a code. Redeeming it would burn a token
    // and report the wrong reason.
    const auth = client();
    const { exchange } = stub(auth);

    await expect(
      auth.completeAuthLink('nikahmate://auth/callback?code=abc&error_code=otp_expired'),
    ).rejects.toMatchObject({ kind: 'session_expired' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('ignores a deep link that is not an auth link', async () => {
    // The app is deep-linkable for other reasons. This must not claim every
    // incoming URL, and must not throw on one it does not recognise.
    const auth = client();
    const { exchange, verifyOtp } = stub(auth);

    const result = await auth.completeAuthLink('nikahmate://profile/123');

    expect(result).toEqual({ session: null, type: null });
    expect(exchange).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('maps a rejected exchange onto a known kind', async () => {
    const auth = client();
    stub(auth, {
      exchange: { data: { session: null }, error: { code: 'invalid_credentials', message: 'no' } },
    });

    await expect(
      auth.completeAuthLink('nikahmate://auth/callback?code=used-already'),
    ).rejects.toMatchObject({ kind: 'invalid_credentials' });
  });

  it('refuses an unparseable URL without throwing something raw', async () => {
    const auth = client();
    stub(auth);
    await expect(auth.completeAuthLink('not a url at all')).rejects.toBeInstanceOf(NikahMateError);
  });
});

describe('updatePassword', () => {
  it('sets the password on the current session', async () => {
    const auth = client();
    const updateUser = vi.fn(async () => ({ data: { user: null }, error: null }));
    // @ts-expect-error — stubbing the single call this method makes.
    auth.supabase.auth.updateUser = updateUser;

    await auth.updatePassword('a-new-password');
    expect(updateUser).toHaveBeenCalledWith({ password: 'a-new-password' });
  });

  it('maps a failure onto a known kind', async () => {
    const auth = client();
    // @ts-expect-error — same.
    auth.supabase.auth.updateUser = vi.fn(async () => ({
      data: { user: null },
      error: { code: 'weak_password', message: 'too short' },
    }));

    await expect(auth.updatePassword('short')).rejects.toMatchObject({ kind: 'weak_password' });
  });
});
