import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { FamilyInviteRef } from '@nikahmate/domain';
import { createPendingInviteStore, type InviteStorage } from './pendingInviteStore';

/**
 * Where a pending family invitation waits (review B2): SecureStore on a
 * device, because the token is a credential; sessionStorage on web, so it
 * lives no longer than the tab it was opened in. The logic is in
 * `pendingInviteStore.ts`, which is unit-tested.
 */

const sessionStore = (): Storage | null => {
  try {
    return typeof globalThis !== 'undefined' && globalThis.sessionStorage
      ? globalThis.sessionStorage
      : null;
  } catch {
    // Private browsing and blocked site data both throw on access.
    return null;
  }
};

const storage: InviteStorage =
  Platform.OS === 'web'
    ? {
        get: async (key) => sessionStore()?.getItem(key) ?? null,
        set: async (key, value) => sessionStore()?.setItem(key, value),
        remove: async (key) => sessionStore()?.removeItem(key),
      }
    : {
        get: (key) => SecureStore.getItemAsync(key),
        set: (key, value) => SecureStore.setItemAsync(key, value),
        remove: (key) => SecureStore.deleteItemAsync(key),
      };

export const pendingInvite = createPendingInviteStore(storage);

export function usePendingInvite(): FamilyInviteRef | null {
  return useSyncExternalStore(pendingInvite.subscribe, pendingInvite.get, pendingInvite.get);
}
