import { describe, expect, it } from 'vitest';
import {
  areasFor,
  decisionProblems,
  expiresAtFromDate,
  gateFor,
  userActionProblems,
  validTotpCode,
} from './adminAccess';

/**
 * Review L1: which admin screen to show for what the API said, and which
 * forms may be sent. None of this authorises — the API does, on every call.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');

describe('gateFor', () => {
  it.each([
    ['unauthenticated', null, false, 'signed_out'],
    ['session_expired', null, true, 'signed_out'],
    ['not_found', { current: 'aal2', next: 'aal2' }, true, 'not_staff'],
    ['forbidden', { current: 'aal1', next: 'aal2' }, true, 'verify_mfa'],
    ['forbidden', { current: 'aal1', next: 'aal1' }, false, 'enroll_mfa'],
    ['forbidden', { current: 'aal2', next: 'aal2' }, true, 'forbidden'],
    ['network', null, false, 'error'],
    ['server', null, false, 'error'],
  ] as const)('%s (assurance %j, factor %s) → %s', (kind, assurance, factor, gate) => {
    expect(gateFor(kind, assurance, factor)).toBe(gate);
  });
});

describe('areasFor', () => {
  it('offers moderators the moderation areas and the audit trail, not DOB corrections', () => {
    expect(areasFor(['moderator'])).toEqual(['photos', 'profiles', 'reports', 'users', 'audit']);
  });
  it('offers support DOB corrections and the audit trail only', () => {
    expect(areasFor(['support'])).toEqual(['dobCorrections', 'audit']);
  });
  it('offers an admin everything, and nobody anything without a role', () => {
    expect(areasFor(['admin'])).toHaveLength(6);
    expect(areasFor([])).toEqual([]);
  });
});

describe('decisionProblems', () => {
  it('needs a decision and a note on every decision', () => {
    expect(decisionProblems({ area: 'photos', decision: null, reasonKey: null, note: '' })).toEqual(
      {
        decision: 'admin.decision.chooseOne',
        note: 'admin.decision.noteRequired',
      },
    );
    expect(
      decisionProblems({
        area: 'photos',
        decision: 'approve',
        reasonKey: null,
        note: 'Clear face photo.',
      }),
    ).toEqual({});
  });

  it('a photo or profile rejection needs the reason the member sees', () => {
    for (const area of ['photos', 'profiles'] as const) {
      expect(
        decisionProblems({ area, decision: 'reject', reasonKey: null, note: 'Not acceptable.' }),
      ).toEqual({
        reasonKey: 'admin.decision.reasonRequired',
      });
      expect(
        decisionProblems({
          area,
          decision: 'reject',
          reasonKey: 'errors.photoRejected',
          note: 'Not acceptable.',
        }),
      ).toEqual({});
    }
  });

  it('a DOB rejection is explained by its note, which the member sees', () => {
    expect(
      decisionProblems({
        area: 'dobCorrections',
        decision: 'reject',
        reasonKey: null,
        note: 'Document did not match.',
      }),
    ).toEqual({});
    expect(
      decisionProblems({ area: 'dobCorrections', decision: 'reject', reasonKey: null, note: 'no' }),
    ).toEqual({
      note: 'admin.decision.noteRequired',
    });
  });

  it('refuses an over-long note', () => {
    expect(
      decisionProblems({
        area: 'photos',
        decision: 'approve',
        reasonKey: null,
        note: 'x'.repeat(1001),
      }).note,
    ).toBe('admin.decision.noteTooLong');
  });
});

describe('userActionProblems', () => {
  it('needs an action and a reason', () => {
    expect(userActionProblems({ action: null, reason: '', expiresAt: '' }, NOW)).toEqual({
      action: 'admin.users.chooseAction',
      reason: 'admin.decision.noteRequired',
    });
    expect(
      userActionProblems(
        { action: 'ban', reason: 'Repeated abuse in messages.', expiresAt: '' },
        NOW,
      ),
    ).toEqual({});
  });

  it('an end date only for a suspension, and only in the future', () => {
    const reason = 'Abusive messages reported twice.';
    expect(
      userActionProblems({ action: 'ban', reason, expiresAt: '2026-12-01' }, NOW).expiresAt,
    ).toBe('admin.users.endOnlyForSuspend');
    expect(
      userActionProblems({ action: 'suspend', reason, expiresAt: '2026-11-01' }, NOW).expiresAt,
    ).toBe('admin.users.endInPast');
    expect(
      userActionProblems({ action: 'suspend', reason, expiresAt: 'soon' }, NOW).expiresAt,
    ).toBe('validation.dateInvalid');
    expect(userActionProblems({ action: 'suspend', reason, expiresAt: '2026-12-01' }, NOW)).toEqual(
      {},
    );
  });

  it('turns a day into the end of that day, UTC', () => {
    expect(expiresAtFromDate('2026-12-01')).toBe('2026-12-01T23:59:59.000Z');
    expect(expiresAtFromDate('  ')).toBeUndefined();
  });
});

describe('validTotpCode', () => {
  it('accepts six digits only', () => {
    expect(validTotpCode('123456')).toBe(true);
    expect(validTotpCode(' 123456 ')).toBe(true);
    expect(validTotpCode('12345')).toBe(false);
    expect(validTotpCode('12345a')).toBe(false);
  });
});
