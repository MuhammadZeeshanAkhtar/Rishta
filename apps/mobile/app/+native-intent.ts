import { safeSystemPath } from '../src/navigation/safeDeepLink';

/**
 * Expo Router calls this with every link that opens the app, before it parses the link.
 * A malformed or oversized one goes to the home screen (src/navigation/safeDeepLink.ts).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return safeSystemPath(path);
}
