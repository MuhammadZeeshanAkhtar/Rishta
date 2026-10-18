/**
 * SQL fragments shared by the route handlers.
 */

/**
 * Renders a `timestamptz` as an RFC 3339 string in UTC.
 *
 * The API contract says every timestamp is RFC 3339 (`timestampSchema` in
 * @nikahmate/domain, which the mobile client parses every response against).
 * Postgres does not render one that way on its own, and there are three ways
 * to get a timestamp out of a query — only one of which is safe:
 *
 *   - `column::text` renders in Postgres's own style, `2026-10-01 09:59:13+00`:
 *     a space instead of `T` and a two-digit offset. It is not RFC 3339, and
 *     it is what this function exists to replace.
 *   - Letting node-postgres parse the column hands back a JS `Date`, which
 *     serializes correctly — but only under node-postgres. The tests run on
 *     PGlite, so a format bug introduced this way passes every test and fails
 *     only against the real database. That is precisely the failure this
 *     project already hit.
 *   - Formatting in SQL, as below, produces the same bytes on both engines,
 *     so a test that parses the response proves the production shape too.
 *
 * `at time zone 'utc'` makes the output independent of the session TimeZone,
 * which is a server setting no part of this code controls.
 *
 * `expression` is always a column reference written in our own source. It is
 * never built from request data, so it carries no injection surface.
 */
export function isoTimestamp(expression: string): string {
  return `to_char(${expression} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}
