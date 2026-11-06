import { describe, expect, it } from 'vitest';
import type { DobCorrection } from '@nikahmate/domain';
import { correctionState, validateCorrection } from './dobCorrection';

/** Review B6: the member's correction request, validated and tracked. */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const REASON = 'I entered my birth year wrongly during sign-up.';

const item = (
  status: DobCorrection['status'],
  over: Partial<DobCorrection> = {},
): DobCorrection => ({
  requestId: '11111111-1111-4111-8111-111111111111',
  status,
  requestedDob: '1994-03-02',
  decisionNote: null,
  decidedAt: status === 'pending' ? null : NOW.toISOString(),
  createdAt: NOW.toISOString(),
  ...over,
});

describe('validateCorrection', () => {
  it('accepts a real, adult, different date with a reason', () => {
    expect(
      validateCorrection(
        { requestedDob: '1994-03-02', reason: REASON, currentDob: '1995-06-15' },
        NOW,
      ),
    ).toEqual({});
  });

  it.each([
    ['', 'validation.required'],
    ['02/03/1994', 'validation.dateInvalid'],
    ['1994-02-30', 'validation.dateInvalid'],
    ['2030-01-01', 'validation.dateInFuture'],
    ['2015-01-01', 'validation.tooYoung'],
    ['1995-06-15', 'dobCorrection.sameAsCurrent'],
  ])('refuses the date %j with %s', (requestedDob, key) => {
    expect(
      validateCorrection({ requestedDob, reason: REASON, currentDob: '1995-06-15' }, NOW)
        .requestedDob,
    ).toBe(key);
  });

  it('needs a reason support can act on', () => {
    expect(
      validateCorrection({ requestedDob: '1994-03-02', reason: '  short  ', currentDob: null }, NOW)
        .reason,
    ).toBe('dobCorrection.reasonTooShort');
    expect(
      validateCorrection(
        { requestedDob: '1994-03-02', reason: 'x'.repeat(1001), currentDob: null },
        NOW,
      ).reason,
    ).toBe('dobCorrection.reasonTooLong');
  });
});

describe('correctionState', () => {
  it('an open request blocks a new one', () => {
    const state = correctionState([item('pending'), item('rejected')]);
    expect(state.canRequest).toBe(false);
    expect(state.open?.status).toBe('pending');
    expect(state.lastDecided?.status).toBe('rejected');
  });

  it('after a rejection the member may ask again, and sees the reason', () => {
    const state = correctionState([item('rejected', { decisionNote: 'Document did not match.' })]);
    expect(state.canRequest).toBe(true);
    expect(state.open).toBeNull();
    expect(state.lastDecided?.decisionNote).toBe('Document did not match.');
  });

  it('nothing filed yet', () => {
    expect(correctionState([])).toEqual({ open: null, lastDecided: null, canRequest: true });
  });
});
