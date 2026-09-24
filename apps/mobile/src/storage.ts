import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Small key/value storage.
 *
 * Deliberately NOT AsyncStorage — it writes unencrypted plain text, and this
 * app will hold a session token. ESLint blocks importing it (README §9.1).
 *
 * SecureStore is the native implementation. It has no web backend, so web
 * falls back to localStorage, which is fine for the only thing stored today
 * (the chosen locale) but must NOT be used for tokens on web. When the web
 * client arrives it uses cookie-based SSR sessions instead (README §19).
 */

const webAvailable = (): boolean =>
  typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined';

export async function getItem(key: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return webAvailable() ? globalThis.localStorage.getItem(key) : null;
    }
    return await SecureStore.getItemAsync(key);
  } catch {
    // Storage can be unavailable: private browsing, cleared site data, a
    // locked keystore. Returning null is correct — the caller falls back to a
    // default rather than crashing someone out of the app.
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (webAvailable()) globalThis.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch {
    // A preference that fails to persist is a small annoyance; a crash is not.
  }
}

export async function removeItem(key: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (webAvailable()) globalThis.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Ignore.
  }
}
