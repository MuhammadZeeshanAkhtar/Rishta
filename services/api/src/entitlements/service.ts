import { ENTITLEMENT_KEYS, FREE_PLAN_ENTITLEMENTS, type EntitlementKey } from '@nikahmate/domain';
import { entitlementRequired } from '../errors';
import type { Db, DbSession } from '../db/types';

/**
 * What a member may do.
 *
 * ADR 0005: the entitlement abstraction ships in v1 with money switched off,
 * so adding billing in 1.2 touches billing rather than feature code. The whole
 * discipline is one rule — **feature code asks `can(user, key)` and never asks
 * whether someone is premium.** A route that branches on a plan name has to be
 * rewritten when plans change; a route that asks `can()` does not.
 *
 * RESOLUTION ORDER. A row in `user_entitlements` wins; otherwise the free-plan
 * default. There is no third source, and a member with no rows is a correctly
 * provisioned free member rather than an error (migration 0013 explains why
 * the free plan is not materialised per user).
 *
 * FAILING CLOSED. Every path that cannot produce an answer produces `false`,
 * not an exception and not a permissive default:
 *
 *   * an unknown key — rejected before the database is touched;
 *   * a row whose `expires_at` has passed — ignored, so a lapsed promo stops
 *     applying without anything having to delete it;
 *   * a value of the wrong JSON shape — treated as absent.
 *
 * TRUSTING NOTHING FROM THE CLIENT. The resolver takes a `userId` the caller
 * has already established from a verified JWT. It never reads an entitlement,
 * a plan or a user id out of a request body, so there is no path by which a
 * client asserting `"premium": true` changes an answer.
 */

export type EntitlementValue = number | boolean;

/** Every effective entitlement for one member. */
export type EntitlementMap = Readonly<Record<EntitlementKey, EntitlementValue>>;

interface EntitlementRow {
  entitlement_key: string;
  value: unknown;
}

/** Narrow an arbitrary key to one the product defines. */
export function isEntitlementKey(key: string): key is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(key);
}

/**
 * A stored value is only usable if it is the shape the domain declares.
 *
 * jsonb can hold a string or an object, and the column constraint refuses
 * both — but a constraint added later than a row is not retroactive, and this
 * resolver runs against whatever is actually there.
 */
function usableValue(raw: unknown): EntitlementValue | undefined {
  if (typeof raw === 'boolean' || typeof raw === 'number') return raw;
  return undefined;
}

/**
 * Reads one member's overrides and layers them over the free plan.
 *
 * `db.asUser` rather than the service role: `user_entitlements` is owner-select
 * under RLS, so a member reading their own entitlements needs no elevation,
 * and the policy is what guarantees the read is confined to them. Reaching for
 * the service role here would move that guarantee from the database into this
 * function.
 */
export async function loadEntitlements(
  db: Db,
  authUserId: string,
  userId: string,
): Promise<EntitlementMap> {
  const rows = await db.asUser(authUserId, (session: DbSession) =>
    session.query<EntitlementRow>(
      `select entitlement_key, value
         from public.user_entitlements
        where user_id = $1::uuid
          and (expires_at is null or expires_at > now())`,
      [userId],
    ),
  );

  const resolved: Record<string, EntitlementValue> = { ...FREE_PLAN_ENTITLEMENTS };
  for (const row of rows) {
    if (!isEntitlementKey(row.entitlement_key)) continue;
    const value = usableValue(row.value);
    if (value !== undefined) resolved[row.entitlement_key] = value;
  }
  return resolved as EntitlementMap;
}

/**
 * Is this capability granted?
 *
 * A flag is granted when it is true. A limit is granted when it is above zero,
 * which is what makes `can(user, 'daily_interests')` mean "may send any at
 * all" rather than "has some left" — how many remain is a counter, and
 * counters are Phase 6.
 *
 * An unknown key is false. The signature keeps that unreachable from typed
 * callers; the check is for the string that arrives from somewhere else.
 */
export function can(entitlements: EntitlementMap, key: string): boolean {
  if (!isEntitlementKey(key)) return false;
  const value = entitlements[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return false;
}

/** The effective value, for a limit that a caller needs to compare against. */
export function valueOf(entitlements: EntitlementMap, key: EntitlementKey): EntitlementValue {
  return entitlements[key] ?? FREE_PLAN_ENTITLEMENTS[key];
}

/**
 * Guard for a route that needs an entitlement.
 *
 * Throws the existing `entitlement_required` problem (403) rather than a bare
 * forbidden, so the client can tell "you may not" from "you may not *yet*" and
 * offer the upgrade rather than an apology.
 */
export async function requireEntitlement(
  db: Db,
  authUserId: string,
  userId: string,
  key: EntitlementKey,
): Promise<EntitlementMap> {
  const entitlements = await loadEntitlements(db, authUserId, userId);
  if (!can(entitlements, key)) throw entitlementRequired(key);
  return entitlements;
}

/**
 * Grants or changes one entitlement. Operator action, service role only.
 *
 * Members hold SELECT on this table and nothing else, so this is the only way
 * a row is written. `source` defaults to `grant` because that is what a manual
 * change is; `plan` belongs to billing in 1.2.
 */
export async function grantEntitlement(
  db: Db,
  userId: string,
  key: EntitlementKey,
  value: EntitlementValue,
  options: { source?: 'plan' | 'grant' | 'promo'; expiresAt?: Date | null } = {},
): Promise<void> {
  await db.asService('entitlement.grant', (session: DbSession) =>
    session.query(
      `insert into public.user_entitlements (user_id, entitlement_key, value, source, expires_at)
       values ($1::uuid, $2::text, $3::jsonb, $4::text, $5::timestamptz)
       on conflict (user_id, entitlement_key) do update
         set value = excluded.value,
             source = excluded.source,
             expires_at = excluded.expires_at`,
      [userId, key, JSON.stringify(value), options.source ?? 'grant', options.expiresAt ?? null],
    ),
  );
}

/** Removes an override, returning the member to the plan default. */
export async function revokeEntitlement(
  db: Db,
  userId: string,
  key: EntitlementKey,
): Promise<void> {
  await db.asService('entitlement.grant', (session: DbSession) =>
    session.query(
      `delete from public.user_entitlements where user_id = $1::uuid and entitlement_key = $2::text`,
      [userId, key],
    ),
  );
}
