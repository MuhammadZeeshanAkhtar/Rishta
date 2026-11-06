import type { ProfilePhotos, VisiblePhoto } from '@nikahmate/domain';

/**
 * What another member's photo section shows (review L3).
 *
 * The server has already decided which object of which photo this viewer may
 * see — and the Storage policy enforces the same rule — so nothing here can
 * reveal more. This only turns that answer into what to draw and which single
 * action to offer. Kept free of React so it is tested directly.
 */

/** The one thing the viewer can do about photos they cannot fully see. */
export type PhotoRequestAction =
  /** Nothing is withheld, or nothing could be requested. */
  | 'none'
  /** Photos are withheld and a request may be sent. */
  | 'request'
  /** A request is waiting for the owner. */
  | 'pending'
  /** The owner declined recently; a new request is not possible yet. */
  | 'declined'
  /** The owner shared their photos with this viewer. */
  | 'granted';

/** Mirrors PHOTO_REQUEST_COOLDOWN_DAYS in services/api/src/routes/photo-access.ts. */
export const PHOTO_REQUEST_COOLDOWN_DAYS = 30;

export interface ShownPhoto {
  id: string;
  url: string;
  /** True when this is the server-generated blurred file, never the original. */
  blurred: boolean;
}

export interface GalleryView {
  shown: ShownPhoto[];
  /** Photos the viewer knows exist but cannot see at all yet (on request). */
  lockedCount: number;
  action: PhotoRequestAction;
}

export function galleryView(photos: ProfilePhotos | null, now: Date = new Date()): GalleryView {
  if (!photos) return { shown: [], lockedCount: 0, action: 'none' };

  const shown = photos.items
    .filter(
      (p): p is VisiblePhoto & { url: string } => typeof p.url === 'string' && p.url.length > 0,
    )
    .map((p) => ({ id: p.id, url: p.url, blurred: p.variant === 'blurred' }));
  const lockedCount = photos.items.filter((p) => p.url === null).length;
  const withheld = photos.items.some((p) => p.requiresRequest);

  return { shown, lockedCount, action: actionFor(photos, withheld, now) };
}

function actionFor(photos: ProfilePhotos, withheld: boolean, now: Date): PhotoRequestAction {
  if (photos.request?.status === 'pending') return 'pending';
  if (!withheld) return photos.granted ? 'granted' : 'none';
  if (photos.request?.status === 'declined' && photos.request.respondedAt) {
    const until =
      new Date(photos.request.respondedAt).getTime() + PHOTO_REQUEST_COOLDOWN_DAYS * 86_400_000;
    if (now.getTime() < until) return 'declined';
  }
  return 'request';
}
