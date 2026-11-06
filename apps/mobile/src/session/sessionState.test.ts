import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_STATUSES } from '@nikahmate/domain';
import { redirectFor, sessionStateFor, type GateArea, type SessionState } from './sessionState';

/**
 * Review N7. Before this, a suspended, banned, deactivated or pending-deletion
 * member was sent to onboarding, told to finish a profile they had finished, and
 * given no explanation and no way back.
 */

const verified = { user: { emailVerified: true } };
const me = (status: string, profileCompleted = true) =>
  ({ status, profileCompleted }) as Parameters<typeof sessionStateFor>[1];

const RESTRICTED = ['suspended', 'banned', 'deactivated', 'pending_deletion'] as const;

describe('sessionStateFor', () => {
  it.each(RESTRICTED)('%s is restricted, not onboarding', (status) => {
    expect(sessionStateFor(verified, me(status))).toBe('restricted');
  });

  it.each(RESTRICTED)('%s is restricted even with an incomplete profile', (status) => {
    expect(sessionStateFor(verified, me(status, false))).toBe('restricted');
  });

  it('a status it has never heard of fails closed, like the API', () => {
    expect(sessionStateFor(verified, me('something_new'))).toBe('restricted');
  });

  it('every status in the domain has a defined outcome', () => {
    for (const status of USER_STATUSES) {
      const state = sessionStateFor(verified, me(status));
      expect(['ready', 'onboarding', 'restricted']).toContain(state);
    }
  });

  it('leaves the existing paths as they were', () => {
    expect(sessionStateFor(null, null)).toBe('signed_out');
    expect(sessionStateFor({ user: { emailVerified: false } }, me('banned'))).toBe('unverified');
    expect(sessionStateFor(verified, null)).toBe('onboarding');
    expect(sessionStateFor(verified, me('onboarding', false))).toBe('onboarding');
    expect(sessionStateFor(verified, me('active', false))).toBe('onboarding');
    expect(sessionStateFor(verified, me('active'))).toBe('ready');
  });
});

describe('redirectFor', () => {
  it.each<GateArea>(['index', 'app', 'onboarding', 'admin'])(
    'a restricted account is sent from %s to the explanation',
    (area) => {
      expect(redirectFor(area, 'restricted')).toBe('/restricted');
    },
  );

  it('a restricted account stays on the explanation', () => {
    expect(redirectFor('restricted', 'restricted')).toBeNull();
  });

  it.each<[SessionState, string]>([
    ['ready', '/'],
    ['onboarding', '/'],
    ['signed_out', '/(auth)/welcome'],
    ['unverified', '/(auth)/verify-email'],
  ])('nobody else can sit on the explanation: %s goes to %s', (state, target) => {
    expect(redirectFor('restricted', state)).toBe(target);
  });

  it('keeps the routes every other state already had', () => {
    expect(redirectFor('index', 'signed_out')).toBe('/(auth)/welcome');
    expect(redirectFor('index', 'unverified')).toBe('/(auth)/verify-email');
    expect(redirectFor('index', 'onboarding')).toBe('/(onboarding)/basics');
    expect(redirectFor('index', 'ready')).toBe('/discover');
    expect(redirectFor('app', 'signed_out')).toBe('/(auth)/welcome');
    expect(redirectFor('app', 'misconfigured')).toBe('/(auth)/welcome');
    expect(redirectFor('app', 'onboarding')).toBe('/(onboarding)/basics');
    expect(redirectFor('app', 'ready')).toBeNull();
    expect(redirectFor('onboarding', 'ready')).toBe('/discover');
    expect(redirectFor('onboarding', 'onboarding')).toBeNull();
    expect(redirectFor('admin', 'signed_out')).toBe('/(auth)/sign-in');
    expect(redirectFor('admin', 'misconfigured')).toBe('/(auth)/sign-in');
    expect(redirectFor('admin', 'onboarding')).toBeNull();
    expect(redirectFor('admin', 'ready')).toBeNull();
  });

  it('anyone with an account can reach account deletion: Google Play expects it', () => {
    expect(redirectFor('deletion', 'ready')).toBeNull();
    expect(redirectFor('deletion', 'onboarding')).toBeNull();
    expect(redirectFor('deletion', 'restricted')).toBeNull();
  });

  it('nobody without an account can', () => {
    expect(redirectFor('deletion', 'signed_out')).toBe('/(auth)/welcome');
    expect(redirectFor('deletion', 'misconfigured')).toBe('/(auth)/welcome');
    expect(redirectFor('deletion', 'unverified')).toBe('/(auth)/verify-email');
  });

  it('never redirects while the session is still loading', () => {
    for (const area of ['index', 'app', 'onboarding', 'admin', 'restricted', 'deletion'] as const) {
      expect(redirectFor(area, 'loading')).toBeNull();
    }
  });
});

describe('the screens actually use these gates', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  it('the route exists, outside the groups that would redirect it away', () => {
    expect(existsSync(join(ROOT, 'app/restricted.tsx'))).toBe(true);
  });

  it.each([
    ['app/index.tsx', 'index'],
    ['app/(app)/_layout.tsx', 'app'],
    ['app/(onboarding)/_layout.tsx', 'onboarding'],
    ['app/admin/_layout.tsx', 'admin'],
    ['app/restricted.tsx', 'restricted'],
    ['app/delete-account.tsx', 'deletion'],
  ])('%s asks redirectFor', (path, area) => {
    expect(read(path)).toContain(`redirectFor('${area}', state)`);
  });

  it('the email check screen moves on for a restricted account too', () => {
    expect(read('app/(auth)/verify-email.tsx')).toMatch(/state === 'restricted'/);
  });
});
