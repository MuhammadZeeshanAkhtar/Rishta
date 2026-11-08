import { describe, expect, it } from 'vitest';
import {
  FAMILY_JOIN_PATH,
  familyInviteQueryParams,
  parseFamilyInviteLink,
} from '@nikahmate/domain';
import { redirectSystemPath } from '../../app/+native-intent';
import { MAX_DEEP_LINK_LENGTH, safeSystemPath } from './safeDeepLink';

/**
 * The deep-link guard in front of Expo Router's query parser, which decodes with a
 * version of decode-uri-component that is exponential on malformed input.
 */
describe('safeSystemPath', () => {
  it.each([
    [
      'the email sign-in callback',
      'nikahmate://auth/callback?code=4f1c7a2e-1b9d-4c43-9e0a-8d2b6f3a1c55',
    ],
    [
      'Supabase reporting an expired link, properly encoded',
      'nikahmate://auth/callback?error=access_denied&error_code=otp_expired&error_description=Email%20link%20is%20invalid%20or%20has%20expired',
    ],
    [
      'Supabase reporting an expired link, properly encoded',
      'nikahmate://auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired%21',
    ],
    ['a path with no query', 'nikahmate://matches'],
    ['a fragment after the query', 'nikahmate://auth/callback?code=abc#type=signup'],
  ])('lets %s through unchanged', (_label, link) => {
    expect(safeSystemPath(link)).toBe(link);
  });

  it('lets a family invitation, built as the app builds it, through and still parseable', () => {
    const ref = {
      invitationId: '9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b',
      token: 'Q2xhaW1lZC1ieS10aGUtcmlnaHQtcGVyc29uLW9ubHk',
    };
    const query = new URLSearchParams(familyInviteQueryParams(ref)).toString();
    const link = `nikahmate://${FAMILY_JOIN_PATH}?${query}`;
    expect(safeSystemPath(link)).toBe(link);
    expect(parseFamilyInviteLink(safeSystemPath(link))).toEqual(ref);
  });

  it.each([
    ['a lone percent sign', 'nikahmate://matches?q=100%'],
    ['an invalid escape', 'nikahmate://matches?q=%ZZ'],
    ['a malformed sequence in a key', 'nikahmate://matches?%E0%A4%A=1'],
  ])('sends %s to the home screen', (_label, link) => {
    expect(safeSystemPath(link)).toBe('/');
  });

  it('sends a link longer than any real one to the home screen', () => {
    const long = `nikahmate://matches?q=${'a'.repeat(MAX_DEEP_LINK_LENGTH)}`;
    expect(safeSystemPath(long)).toBe('/');
  });

  it('refuses the input that freezes the vulnerable decoder, and does so at once', () => {
    // 64 runs of an invalid surrogate: the vulnerable decoder needs over 5 seconds.
    const attack = `nikahmate://matches?q=${'%ED%A0%80'.repeat(64)}`;
    const started = performance.now();
    expect(safeSystemPath(attack)).toBe('/');
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('is what Expo Router calls for every incoming link', () => {
    expect(redirectSystemPath({ path: 'nikahmate://matches?q=%ZZ', initial: true })).toBe('/');
    expect(redirectSystemPath({ path: 'nikahmate://matches', initial: false })).toBe(
      'nikahmate://matches',
    );
  });
});
