import type { ProfileCard } from '@nikahmate/domain';

/**
 * The last card seen for each member, kept for the session.
 *
 * WHY THIS EXISTS. There is no public profile-detail endpoint — by design. The
 * server exposes another member only as a `ProfileCard` built from an
 * enumerated allowlist, embedded inside discovery, interests and matches. So
 * the profile detail screen can fetch a compatibility score for a user id and
 * nothing else: no name, no age, no place, no photo.
 *
 * The lists already hold all of that. Rather than passing a serialised card
 * through navigation params — which puts personal data in a URL and breaks the
 * moment the shape changes — every card registers itself here as it renders,
 * and the detail screen reads it back.
 *
 * WHAT THIS IS NOT. Not a data layer, not a substitute for a fetch, and not
 * authoritative. A cold deep link finds nothing here and the detail screen
 * renders what it can without it. Nothing is written to disk: a card carries
 * another person's details, and the privacy rules that decided what the server
 * would send do not survive being cached past the session that was granted
 * them.
 *
 * It holds exactly what the server already chose to send. Reading it can never
 * reveal a field the allowlist withheld.
 */

const cards = new Map<string, ProfileCard>();

/** Last write wins: a fresher card reflects a fresher privacy decision. */
export function rememberCard(card: ProfileCard): void {
  cards.set(card.userId, card);
}

export function recallCard(userId: string | undefined): ProfileCard | null {
  if (!userId) return null;
  return cards.get(userId) ?? null;
}

/** Called on sign-out. Another person's details must not outlive the session. */
export function forgetCards(): void {
  cards.clear();
}
