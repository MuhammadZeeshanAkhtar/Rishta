/**
 * The two access paths, as types.
 *
 * README §9.3 says service-role usage must be "a short, explicitly enumerated,
 * code-reviewed list". `ServiceRoleUse` is that list, and because `asService`
 * only accepts a member of it, a new privileged operation cannot be added
 * without editing this file — which is the thing a reviewer looks at.
 *
 * `asUser` is the default for almost everything. It runs as `authenticated`
 * with the caller's JWT claims set, so RLS still applies: a bug in a route
 * handler does not become a data breach.
 */

export interface DbSession {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Every legitimate reason to bypass RLS in Phase 1.
 *
 * Each entry is justified in docs/SERVICE_ROLE_USAGE.md. Adding one without
 * updating that document is caught in review, not by the compiler — but the
 * compiler at least guarantees the list is the only way in.
 */
export const SERVICE_ROLE_USES = [
  /**
   * Creating the users row after the JWT has been verified.
   * `users` deliberately has no INSERT policy: a client that could insert its
   * own row could choose its own `status`.
   */
  'account.bootstrap',

  /** Registering or revoking a device record on the owner's behalf. */
  'account.register_device',

  /**
   * Appending to security_events. Clients have no INSERT policy — an audit a
   * client can write is not an audit.
   */
  'security.record_event',

  /** Writing versioned consent records, including the Article 9 consent. */
  'consent.record',
] as const;

export type ServiceRoleUse = (typeof SERVICE_ROLE_USES)[number];

export interface Db {
  /**
   * Runs as `authenticated` with the caller's claims. RLS applies.
   * This is the default path — reach for it unless there is a listed reason not to.
   */
  asUser<T>(authUserId: string, fn: (session: DbSession) => Promise<T>): Promise<T>;

  /** Runs as `anon`. For genuinely public reads such as reference data. */
  asAnon<T>(fn: (session: DbSession) => Promise<T>): Promise<T>;

  /**
   * Runs as `service_role`, bypassing RLS.
   *
   * `use` is required and must be one of the enumerated reasons. It is logged
   * with every call, so the audit trail answers "why did the server read this?"
   * rather than only "the server read this".
   */
  asService<T>(use: ServiceRoleUse, fn: (session: DbSession) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** Called on every asService invocation. Wired to the logger at startup. */
export type ServiceUseRecorder = (use: ServiceRoleUse) => void;
