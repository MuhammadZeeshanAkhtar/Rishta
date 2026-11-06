/**
 * Keyset cursors — review B10.
 *
 * The chat endpoints paged by `row_number()` over newest-first rows. Every new
 * message shifted every position by one, so "load earlier" in an active chat
 * repeated messages, and the conversation list repeated or skipped threads.
 *
 * A keyset cursor names the last row seen by its sort key and id, and the next
 * page is "strictly after that row" — which does not move when rows are added
 * in front of it. Opaque (base64url) per the contract; the `k:` prefix keeps
 * it distinct from the position cursors other lists still use, so one can
 * never be mistaken for the other.
 *
 * The timestamp is carried as text with microsecond precision — exactly
 * Postgres's resolution — so the comparison is exact rather than rounded to
 * JavaScript's milliseconds.
 */

export interface Keyset {
  /** ISO-8601 UTC with microseconds, as produced by KEYSET_TIME below. */
  at: string;
  id: string;
}

/** SQL for a timestamptz column as the cursor's text form. */
export const keysetTime = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeKeyset(keyset: Keyset): string {
  return Buffer.from(`k:${keyset.at}|${keyset.id}`, 'utf8').toString('base64url');
}

/** The keyset, or null for anything that is not one of ours. */
export function decodeKeyset(cursor: string | undefined): Keyset | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^k:([^|]+)\|(.+)$/.exec(decoded);
    if (!match || !AT.test(match[1]!) || !ID.test(match[2]!)) return null;
    return { at: match[1]!, id: match[2]! };
  } catch {
    return null;
  }
}
