import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { SupportedStorage } from '@nikahmate/api-client';

/**
 * Where the Supabase session lives on this device.
 *
 * SecureStore (Keychain / Keystore) rather than AsyncStorage, which is
 * unencrypted plain text — README §9.1, and ESLint blocks the import.
 *
 * **The chunking is not optional.** Android's Keystore rejects values over
 * 2048 bytes, and a Supabase session — access token plus refresh token plus
 * user metadata — routinely exceeds that. Storing it whole fails only on
 * Android, only for users whose token happens to be long, and presents as
 * "signed out again every launch": a bug that is invisible in development and
 * infuriating in the field. So every value is split across numbered keys.
 *
 * Web falls back to localStorage, which is correct for the future website
 * (cookie-based SSR sessions, README §19) and fine for the dev web preview.
 */

/** Under Android's 2048-byte ceiling with room for key overhead and UTF-8. */
const CHUNK_SIZE = 1800;

/** Records how many chunks a key was split into. */
const countKey = (key: string): string => `${key}__chunks`;
const chunkKey = (key: string, index: number): string => `${key}__${index}`;

const isWeb = Platform.OS === 'web';

const webStorage = (): Storage | null => {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    // Private browsing and blocked site data both throw on access.
    return null;
  }
};

async function removeChunks(key: string): Promise<void> {
  const stored = await SecureStore.getItemAsync(countKey(key));
  const count = stored ? Number(stored) : 0;
  const deletions: Promise<void>[] = [SecureStore.deleteItemAsync(countKey(key))];
  for (let i = 0; i < count; i += 1) {
    deletions.push(SecureStore.deleteItemAsync(chunkKey(key, i)));
  }
  // Also clear any unchunked value written by an older build.
  deletions.push(SecureStore.deleteItemAsync(key));
  await Promise.all(deletions);
}

export const secureStorage: SupportedStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      if (isWeb) return webStorage()?.getItem(key) ?? null;

      const stored = await SecureStore.getItemAsync(countKey(key));
      if (!stored) {
        // No chunk marker: either nothing is stored, or it was written by a
        // build that predates chunking. Read it directly so an upgrade does
        // not sign everybody out.
        return await SecureStore.getItemAsync(key);
      }

      const count = Number(stored);
      if (!Number.isInteger(count) || count < 0) return null;

      const parts = await Promise.all(
        Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(chunkKey(key, i))),
      );
      // A missing chunk means a partial write — a torn session is worse than
      // no session, because it fails at an unpredictable moment later.
      if (parts.some((part) => part === null)) {
        await removeChunks(key);
        return null;
      }
      return parts.join('');
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      if (isWeb) {
        webStorage()?.setItem(key, value);
        return;
      }

      // Clear first: a shorter value would otherwise leave stale trailing
      // chunks that a later read would happily concatenate.
      await removeChunks(key);

      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += CHUNK_SIZE) {
        chunks.push(value.slice(i, i + CHUNK_SIZE));
      }

      await Promise.all(
        chunks.map((chunk, i) => SecureStore.setItemAsync(chunkKey(key, i), chunk)),
      );
      // Written last, so a crash mid-write leaves no marker and the read path
      // reports "nothing stored" rather than reassembling half a session.
      await SecureStore.setItemAsync(countKey(key), String(chunks.length));
    } catch {
      // A session that fails to persist means signing in again — annoying.
      // A crash here means the app will not start at all.
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      if (isWeb) {
        webStorage()?.removeItem(key);
        return;
      }
      await removeChunks(key);
    } catch {
      // Ignore.
    }
  },
};
