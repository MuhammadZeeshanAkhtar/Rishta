import { describe, expect, it } from 'vitest';
import {
  FAMILY_JOIN_PATH,
  familyInviteQueryParams,
  parseFamilyInviteLink,
  toFamilyInviteRef,
} from './family-invite';

/**
 * Family invitation links (review B2). The app builds the link's prefix with
 * expo-linking; these tests use the three prefixes it really produces.
 */

const ID = '3f1c2a4e-9b7d-4c1e-8a2f-6d5e4c3b2a10';
// 24 random bytes as base64url — the shape the API issues (TOKEN_BYTES = 24).
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0aSdFgHjKlZxC';

const link = (prefix: string): string => {
  const { i, t } = familyInviteQueryParams({ invitationId: ID, token: TOKEN });
  return `${prefix}${FAMILY_JOIN_PATH}?i=${i}&t=${t}`;
};

describe('parseFamilyInviteLink — the links the app builds', () => {
  it.each([
    ['standalone build', 'nikahmate://'],
    ['dev client', 'exp://192.168.1.20:8081/--/'],
    ['web', 'https://app.example.org/'],
  ])('round-trips a %s link', (_label, prefix) => {
    expect(parseFamilyInviteLink(link(prefix))).toEqual({ invitationId: ID, token: TOKEN });
  });
});

describe('parseFamilyInviteLink — links as people paste them', () => {
  it('finds the link inside a longer message', () => {
    const message = `Assalamu alaikum, please join my family on NikahMate: ${link('nikahmate://')} JazakAllah`;
    expect(parseFamilyInviteLink(message)).toEqual({ invitationId: ID, token: TOKEN });
  });

  it('drops a full stop the sentence added after the link', () => {
    expect(parseFamilyInviteLink(`${link('nikahmate://')}.`)).toEqual({
      invitationId: ID,
      token: TOKEN,
    });
  });

  it('accepts the parameters in either order, and extra ones', () => {
    const reordered = `nikahmate://family/join?utm=x&t=${TOKEN}&i=${ID}`;
    expect(parseFamilyInviteLink(reordered)).toEqual({ invitationId: ID, token: TOKEN });
  });

  it('accepts percent-encoding and an upper-case id', () => {
    const encoded = `nikahmate://family/join?i=${ID.toUpperCase()}&t=${encodeURIComponent(TOKEN)}`;
    expect(parseFamilyInviteLink(encoded)).toEqual({ invitationId: ID, token: TOKEN });
  });

  it('accepts surrounding whitespace and a trailing slash on the path', () => {
    expect(parseFamilyInviteLink(`  nikahmate://family/join/?i=${ID}&t=${TOKEN}\n`)).toEqual({
      invitationId: ID,
      token: TOKEN,
    });
  });
});

describe('parseFamilyInviteLink — refusals', () => {
  it.each([
    ['an empty string', ''],
    ['plain text', 'join my family please'],
    ['another route', `nikahmate://family/invite?i=${ID}&t=${TOKEN}`],
    ['a missing token', `nikahmate://family/join?i=${ID}`],
    ['a missing id', `nikahmate://family/join?t=${TOKEN}`],
    ['an id that is not a uuid', `nikahmate://family/join?i=12345&t=${TOKEN}`],
    ['a token that is too short', `nikahmate://family/join?i=${ID}&t=abc123`],
    ['a token outside base64url', `nikahmate://family/join?i=${ID}&t=${'%24'.repeat(20)}`],
    ['a malformed percent sequence', `nikahmate://family/join?i=${ID}&t=%E0%A4%A`],
  ])('returns null for %s', (_label, input) => {
    expect(parseFamilyInviteLink(input)).toBeNull();
  });
});

describe('toFamilyInviteRef', () => {
  it('accepts a well-formed pair and trims it', () => {
    expect(toFamilyInviteRef(` ${ID} `, ` ${TOKEN} `)).toEqual({ invitationId: ID, token: TOKEN });
  });

  it('refuses anything that is not two strings of the right shape', () => {
    expect(toFamilyInviteRef(undefined, TOKEN)).toBeNull();
    expect(toFamilyInviteRef(ID, ['array'])).toBeNull();
    expect(toFamilyInviteRef('not-a-uuid', TOKEN)).toBeNull();
    expect(toFamilyInviteRef(ID, 'x'.repeat(129))).toBeNull();
  });
});
