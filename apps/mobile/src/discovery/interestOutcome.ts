import { isNikahMateError } from '@nikahmate/api-client';

/**
 * Whether an Express Interest failure means it was already sent.
 *
 * Discover is not reloaded when someone comes back to it, because a reload would lose
 * their place in the feed. So a member who expressed interest from a profile could
 * press it again on the card and be told it had failed. The only conflict that route
 * returns is "already sent", so the card simply leaves the feed instead.
 */
export function interestAlreadySent(error: unknown): boolean {
  return isNikahMateError(error) && error.kind === 'conflict';
}
