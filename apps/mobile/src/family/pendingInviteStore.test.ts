import { describe, expect, it, vi } from 'vitest';
import {
  PENDING_INVITE_KEY,
  PENDING_INVITE_TTL_MS,
  createPendingInviteStore,
  type InviteStorage,
} from './pendingInviteStore';

/**
 * The pending family invitation (review B2): kept across sign-in and
 * onboarding, and never longer or looser than it should be.
 */

const REF = {
  invitationId: '3f1c2a4e-9b7d-4c1e-8a2f-6d5e4c3b2a10',
  token: 'q1W2e3R4t5Y6u7I8o9P0aSdFgHjKlZxC',
};

function memory(
  initial: Record<string, string> = {},
): InviteStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get: async (key) => data[key] ?? null,
    set: async (key, value) => {
      data[key] = value;
    },
    remove: async (key) => {
      delete data[key];
    },
  };
}

describe('pending family invitation store', () => {
  it('keeps an invitation and persists it with the time it was saved', async () => {
    const storage = memory();
    const store = createPendingInviteStore(storage, () => 1_000);
    await store.set(REF);
    expect(store.get()).toEqual(REF);
    expect(JSON.parse(storage.data[PENDING_INVITE_KEY]!)).toEqual({ ...REF, savedAt: 1_000 });
  });

  it('restores what a previous launch saved', async () => {
    const storage = memory({ [PENDING_INVITE_KEY]: JSON.stringify({ ...REF, savedAt: 1_000 }) });
    const store = createPendingInviteStore(storage, () => 2_000);
    expect(await store.load()).toEqual(REF);
    expect(store.get()).toEqual(REF);
  });

  it('discards and deletes an invitation older than an invitation can live', async () => {
    const storage = memory({ [PENDING_INVITE_KEY]: JSON.stringify({ ...REF, savedAt: 0 }) });
    const store = createPendingInviteStore(storage, () => PENDING_INVITE_TTL_MS + 1);
    expect(await store.load()).toBeNull();
    expect(storage.data[PENDING_INVITE_KEY]).toBeUndefined();
  });

  it.each([
    ['not JSON', 'nope'],
    ['a malformed id', JSON.stringify({ ...REF, invitationId: 'x', savedAt: 1 })],
    ['a missing token', JSON.stringify({ invitationId: REF.invitationId, savedAt: 1 })],
    ['no saved time', JSON.stringify(REF)],
  ])('discards and deletes stored data that is %s', async (_label, raw) => {
    const storage = memory({ [PENDING_INVITE_KEY]: raw });
    const store = createPendingInviteStore(storage, () => 2);
    expect(await store.load()).toBeNull();
    expect(storage.data[PENDING_INVITE_KEY]).toBeUndefined();
  });

  it('clears on null, from memory and from storage, and tells subscribers', async () => {
    const storage = memory();
    const store = createPendingInviteStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.set(REF);
    await store.set(null);
    expect(store.get()).toBeNull();
    expect(storage.data[PENDING_INVITE_KEY]).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when nothing changed, and stops after unsubscribe', async () => {
    const store = createPendingInviteStore(memory());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.set(REF);
    await store.set({ ...REF });
    unsubscribe();
    await store.set(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('still works in memory when storage throws', async () => {
    const broken: InviteStorage = {
      get: () => Promise.reject(new Error('blocked')),
      set: () => Promise.reject(new Error('blocked')),
      remove: () => Promise.reject(new Error('blocked')),
    };
    const store = createPendingInviteStore(broken);
    await store.set(REF);
    expect(store.get()).toEqual(REF);
    expect(await store.load()).toEqual(REF);
    await store.set(null);
    expect(store.get()).toBeNull();
  });
});
