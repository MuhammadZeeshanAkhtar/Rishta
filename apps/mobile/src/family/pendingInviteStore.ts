import { INVITATION_TTL_DAYS, toFamilyInviteRef, type FamilyInviteRef } from '@nikahmate/domain';

/**
 * The family invitation a person opened before they could accept it (review B2).
 *
 * Accepting needs a verified, fully onboarded account — delegates are full
 * members (decision 2026-11-01). Someone who taps an invitation link while
 * signed out, unverified or mid-onboarding is sent through those gates first,
 * and the link they tapped would be lost on the way. This keeps it until they
 * arrive, then the Join screen offers it.
 *
 * No platform imports, so it is unit-tested: the storage is injected
 * (`pendingInvite.ts` supplies SecureStore on a device, sessionStorage on web).
 *
 * The token is a credential — whoever holds it joins that family — so it is
 * kept only as long as the invitation could be valid, and cleared the moment
 * it is used or dismissed.
 */

export interface InviteStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const PENDING_INVITE_KEY = 'nikahmate.pendingFamilyInvite';
/** No longer than the server keeps an invitation open. */
export const PENDING_INVITE_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface PendingInviteStore {
  /** The current value, synchronously — for useSyncExternalStore. */
  get(): FamilyInviteRef | null;
  /** Reads what a previous launch left, discarding anything stale or malformed. */
  load(): Promise<FamilyInviteRef | null>;
  /** Saves `ref`, or clears with null. */
  set(ref: FamilyInviteRef | null): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createPendingInviteStore(
  storage: InviteStorage,
  now: () => number = Date.now,
): PendingInviteStore {
  let current: FamilyInviteRef | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: FamilyInviteRef | null): void => {
    const changed = next?.invitationId !== current?.invitationId || next?.token !== current?.token;
    current = next;
    if (changed) for (const listener of listeners) listener();
  };

  const clear = async (): Promise<void> => {
    publish(null);
    try {
      await storage.remove(PENDING_INVITE_KEY);
    } catch {
      // Storage that cannot be cleared holds nothing we will read back as
      // valid for long: the TTL below expires it.
    }
  };

  return {
    get: () => current,

    async load() {
      let raw: string | null = null;
      try {
        raw = await storage.get(PENDING_INVITE_KEY);
      } catch {
        return current;
      }
      if (raw === null) return current;

      try {
        const parsed = JSON.parse(raw) as {
          invitationId?: unknown;
          token?: unknown;
          savedAt?: unknown;
        };
        const ref = toFamilyInviteRef(parsed.invitationId, parsed.token);
        const fresh =
          typeof parsed.savedAt === 'number' && now() - parsed.savedAt < PENDING_INVITE_TTL_MS;
        if (ref && fresh) {
          publish(ref);
          return ref;
        }
      } catch {
        // Fall through: not ours, or damaged. Either way it must not linger.
      }
      await clear();
      return null;
    },

    async set(ref) {
      if (ref === null) {
        await clear();
        return;
      }
      publish(ref);
      try {
        await storage.set(PENDING_INVITE_KEY, JSON.stringify({ ...ref, savedAt: now() }));
      } catch {
        // In memory it still works for this session; only a restart loses it,
        // and the invitee can paste the link again.
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
