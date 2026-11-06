import { describe, expect, it } from 'vitest';
import type { ProfilePhotos } from '@nikahmate/domain';
import { galleryView, PHOTO_REQUEST_COOLDOWN_DAYS } from './photoAccess';

/** Review L3: what another member's photo section shows, and the one action it offers. */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const full = (id: string) => ({
  id,
  variant: 'full' as const,
  url: `https://s/${id}`,
  expiresAt: NOW.toISOString(),
  requiresRequest: false,
});
const blurred = (id: string) => ({
  id,
  variant: 'blurred' as const,
  url: `https://s/${id}-b`,
  expiresAt: NOW.toISOString(),
  requiresRequest: true,
});
const locked = (id: string) => ({
  id,
  variant: 'blurred' as const,
  url: null,
  expiresAt: null,
  requiresRequest: true,
});

function photos(over: Partial<ProfilePhotos>): ProfilePhotos {
  return { items: [], request: null, granted: false, ...over };
}

describe('galleryView', () => {
  it('shows only photos with a signed URL, marks blurred ones, and counts locked ones', () => {
    const view = galleryView(photos({ items: [full(A), blurred(B), locked(C)] }), NOW);
    expect(view.shown).toEqual([
      { id: A, url: `https://s/${A}`, blurred: false },
      { id: B, url: `https://s/${B}-b`, blurred: true },
    ]);
    expect(view.lockedCount).toBe(1);
    expect(view.action).toBe('request');
  });

  it('offers nothing when nothing is withheld, and "granted" after an approval', () => {
    expect(galleryView(photos({ items: [full(A)] }), NOW).action).toBe('none');
    expect(galleryView(photos({ items: [full(A)], granted: true }), NOW).action).toBe('granted');
    expect(galleryView(photos({}), NOW)).toEqual({ shown: [], lockedCount: 0, action: 'none' });
    expect(galleryView(null, NOW).action).toBe('none');
  });

  it('a pending request shows as pending, never as a second request', () => {
    const view = galleryView(
      photos({
        items: [locked(A)],
        request: { id: B, status: 'pending', createdAt: NOW.toISOString(), respondedAt: null },
      }),
      NOW,
    );
    expect(view.action).toBe('pending');
  });

  it('a decline blocks a new request for the cooldown, then allows one', () => {
    const declinedAt = (daysAgo: number) =>
      photos({
        items: [locked(A)],
        request: {
          id: B,
          status: 'declined',
          createdAt: NOW.toISOString(),
          respondedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
        },
      });
    expect(galleryView(declinedAt(1), NOW).action).toBe('declined');
    expect(galleryView(declinedAt(PHOTO_REQUEST_COOLDOWN_DAYS + 1), NOW).action).toBe('request');
  });

  it('never treats an empty URL as a photo', () => {
    const view = galleryView(photos({ items: [{ ...full(A), url: '' }] }), NOW);
    expect(view.shown).toEqual([]);
  });
});
