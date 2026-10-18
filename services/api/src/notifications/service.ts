import type { DbSession } from '../db/types';

/**
 * Writing notifications.
 *
 * ALWAYS INSIDE THE ORIGINATING TRANSACTION. These functions take a
 * `DbSession` rather than a `Db` precisely so they cannot open one of their
 * own: a notification that survives a rolled-back interest would tell someone
 * about a thing that did not happen, and one that is lost when the interest
 * commits would be worse. They land together or not at all.
 *
 * WHAT GOES IN THE PAYLOAD. Identifiers, never rendered content about a
 * person. A notification is written once and read later — possibly much
 * later — so a display name or a photo copied in here would outlive the
 * permission that allowed it, and would still be sitting in the inbox after a
 * block. The client resolves the actor through the normal reads, which
 * re-apply `app.can_view_profile()` at the moment of reading.
 *
 * WHAT IS NOT HERE. No push, no email, no job queue. The contract calls the
 * inbox "the source of truth; push is one delivery channel", so a later
 * channel reads these rows rather than replacing them.
 */

/** The three types Phase 6 can actually produce. */
export type Phase6NotificationType = 'interest_received' | 'interest_accepted' | 'new_match';

interface NotificationInput {
  userId: string;
  type: Phase6NotificationType;
  /**
   * Identifies the EVENT, not the entity.
   *
   * `new_match` keys on the match AND the interest that created the period,
   * because a rematched pair reuses its `matches` row — keying on the match
   * alone would swallow the second match entirely.
   */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Inserts notifications, skipping any that already exist.
 *
 * `on conflict do nothing` rather than letting the unique constraint raise:
 * a duplicate is a no-op, not a failure, and it must never abort the interest
 * or match transaction it is riding along with.
 */
export async function notify(
  session: DbSession,
  notifications: readonly NotificationInput[],
): Promise<void> {
  for (const item of notifications) {
    await session.query(
      `insert into public.notifications (user_id, type, dedupe_key, payload)
       values ($1::uuid, $2::text, $3::text, $4::jsonb)
       on conflict (user_id, type, dedupe_key) do nothing`,
      [item.userId, item.type, item.dedupeKey, JSON.stringify(item.payload)],
    );
  }
}

/** Someone expressed interest. Goes to the recipient. */
export function interestReceived(
  recipientUserId: string,
  senderUserId: string,
  interestId: string,
): NotificationInput {
  return {
    userId: recipientUserId,
    type: 'interest_received',
    dedupeKey: interestId,
    payload: { interestId, actorUserId: senderUserId },
  };
}

/**
 * An interest was accepted. Goes to the SENDER.
 *
 * There is deliberately no counterpart for a decline: the contract's type enum
 * has none, and "a decline tells the sender it was declined and nothing more".
 * The sender learns it from their own interest list rather than from a push
 * that arrives the moment someone says no.
 */
export function interestAccepted(
  senderUserId: string,
  recipientUserId: string,
  interestId: string,
): NotificationInput {
  return {
    userId: senderUserId,
    type: 'interest_accepted',
    dedupeKey: interestId,
    payload: { interestId, actorUserId: recipientUserId },
  };
}

/**
 * A match was made. Goes to BOTH participants.
 *
 * Only called when a match row was actually created or revived — never when an
 * acceptance finds an existing active match, which is what happens when two
 * people accept crossing interests at the same moment.
 */
export function newMatch(
  matchId: string,
  interestId: string,
  userA: string,
  userB: string,
): NotificationInput[] {
  const dedupeKey = `${matchId}:${interestId}`;
  return [
    {
      userId: userA,
      type: 'new_match',
      dedupeKey,
      payload: { matchId, interestId, counterpartUserId: userB },
    },
    {
      userId: userB,
      type: 'new_match',
      dedupeKey,
      payload: { matchId, interestId, counterpartUserId: userA },
    },
  ];
}
