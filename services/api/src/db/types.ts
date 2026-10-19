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

  /**
   * Reading the owner's OWN contact details from profile_sensitive.
   * That table has zero policies by design — the absence is what makes
   * "hide my workplace" structurally true — so even the owner's own read
   * has to come through here, scoped by user_id in the query.
   */
  'profile.read_own_sensitive',

  /**
   * Writing profiles.completion_score. The column carries no grant precisely
   * so a member cannot inflate their own score.
   */
  'profile.update_completion',

  /**
   * Moving a profile to review_status = 'pending'. Ungranted for the same
   * reason: a member who could write it would be discoverable without ever
   * passing review.
   */
  'profile.submit_for_review',

  /**
   * Writing photo variants and the moderation verdict.
   *
   * Members hold no grant on `photo_variants` or on `photos.moderation_status`
   * — a member who could write either could point the blurred variant at the
   * unblurred original, or approve their own photo without it being checked.
   */
  'photo.record_moderation',

  /**
   * Soft-deleting a photo.
   *
   * Not a field edit: under FORCE RLS the new row would be invisible to its
   * own owner under `photos_select_own`, so the member-run UPDATE is refused
   * outright (migration 0008). The row survives for abuse investigation while
   * the bytes are purged from the bucket.
   */
  'photo.soft_delete',

  /**
   * Granting, changing or revoking an entitlement.
   *
   * `authenticated` holds SELECT on `user_entitlements` and nothing else, so
   * there is no member-level write path to govern — a member who could write
   * this table would grant themselves `who_viewed_me` or raise their own
   * `daily_interests`. Every write is an operator action.
   */
  'entitlement.grant',

  /**
   * Writing compatibility scores and their factors.
   *
   * `compatibility_scores` and `compatibility_factors` carry no member write
   * privilege at all. A member who could write a factor could author an
   * "explanation" the engine never produced, which would destroy the one
   * property the deterministic design exists to guarantee (ADR 0001).
   */
  'compatibility.write_scores',

  /**
   * Replacing a viewer's precomputed candidate sets.
   *
   * Writes the new batch and deletes the previous one in one transaction, so a
   * section is never read half-built. A member who could write here would
   * place themselves in someone else's Discover feed.
   */
  'discovery.write_candidates',

  /**
   * Building a discovery card for another member.
   *
   * `users` is owner-only and must stay that way: it holds `date_of_birth`,
   * and the product promises only the AGE is ever shown to anyone else, plus
   * `status` and `onboarding_step`, which are nobody else's business. A card
   * needs the display name and the derived age, so the row is read here and
   * the date never leaves this service.
   *
   * The confinement is explicit rather than inherited: every query under this
   * key filters on the caller's own `match_candidates` rows and re-applies
   * `app.can_view_profile()`, which is the same predicate the member's own
   * reads go through.
   */
  'discovery.read_cards',

  /**
   * Sending or withdrawing an interest.
   *
   * ONE TRANSACTION, and that is the whole reason this is a service-role path
   * rather than a member one. The contract requires the daily quota to be
   * consumed in the same transaction as the insert — "otherwise two concurrent
   * requests both read 4 and both succeed, and the quota is advisory rather
   * than real" (ERD §16). `usage_counters` is service-role-write by design (a
   * member who could write their own counter could zero it), and
   * `interest_events` has no member write path at all, so the counter, the
   * interest and its event cannot land together under `asUser`.
   *
   * Ownership is not lost by doing this: `sender_user_id` comes from
   * `app.current_user_id()` resolved under the caller's own session before the
   * transaction opens, never from the request body, and the RLS policy on
   * `interests` independently refuses a direct insert naming anyone else.
   */
  'interest.send',

  /**
   * Responding to an interest, and the match an acceptance produces.
   *
   * One transaction covering `interests.status`, its `interest_events` row,
   * and — on acceptance — the `matches` row and its `match_events` row. None
   * of those four is member-writable: status is server state, both event
   * tables are append-only with no member grant, and a member who could insert
   * a match would manufacture a relationship the other person never agreed to.
   *
   * Ownership is established before the transaction opens: only the RECIPIENT
   * of an interest may respond, checked against `app.current_user_id()`
   * resolved under the caller's own session.
   */
  'interest.respond',

  /**
   * Ending a match.
   *
   * `matches` carries no member write grant — a member who could update it
   * could clear someone else's ending, or move `communication_state` past the
   * Family Safety gate — and `match_events` has no member path at all.
   * Participation is established before the transaction opens, from
   * `app.current_user_id()` under the caller's own session.
   */
  'match.end',

  /**
   * Filing a report.
   *
   * `reports` has no member INSERT grant (migration 0022): `status` and
   * `outcome_key` are the moderation pipeline's state, and a member able to
   * write them directly could file a report pre-dismissed or edit one a
   * moderator had already triaged. The route is also where self-reports, an
   * invisible target and the one-open-report-per-pair rule are refused, so the
   * insert belongs on the same side as those checks.
   *
   * `reporter_user_id` comes from `app.current_user_id()` resolved under the
   * caller's own session before this opens, never from the request body.
   */
  'report.file',

  /**
   * Display names for the people the caller has blocked.
   *
   * `users` is owner-only, so a block list cannot name anyone without a
   * service-role read — and `discovery.read_cards` cannot serve it, because
   * that path re-applies `app.can_view_profile()` and a blocked member fails
   * it by definition. Reusing it would return an empty list and make the
   * blocks unmanageable: you must be able to see whom you blocked in order to
   * unblock them.
   *
   * Confined by construction: the query joins FROM the caller's own `blocks`
   * rows and selects nothing but `id` and `display_name`. The birth date, the
   * status and every other owner-only column stay in this service.
   */
  'safety.read_blocked_identities',

  /**
   * Creating, re-offering and answering a family invitation.
   *
   * `family_invitations` is SELECT-only for members, and the write carries
   * three rules no policy can express: the token is hashed before it is
   * stored and returned raw exactly once, expiry is set from the invitation
   * TTL rather than the client, and accepting one creates the relationship
   * and its tier-preset grants in the SAME transaction. A half-accepted
   * invitation — relationship written, permissions not — is a delegate who
   * exists and can do nothing, which looks to the owner like a granted right
   * that silently fails.
   *
   * The owner id comes from `app.current_user_id()` under the caller's own
   * session; the invitee is identified by presenting the token, never by
   * naming themselves in the body.
   */
  'family.invite',

  /**
   * Changing or revoking what a delegate holds.
   *
   * A member who could write `family_permissions` could grant themselves
   * `approve_communication` over someone else and then decide that person's
   * review. The route is also the only place that can refuse a permission
   * whose phase has not arrived (ERD §12: rejected with 400, never accepted
   * and ignored), and revocation must clear the relationship and its grants
   * together or a revoked delegate keeps rights the owner believes are gone.
   *
   * Ownership is established before the transaction opens: only the OWNER of
   * the relationship may change it, checked against `app.current_user_id()`.
   */
  'family.manage_relationship',

  /**
   * Building the review packet for one match.
   *
   * `users` is owner-only and holds `date_of_birth`; the packet shows an AGE.
   * The counterpart's profile is not readable by the delegate under any
   * member policy — `app.can_view_profile()` answers no, because a delegate
   * is not a participant in their principal's match.
   *
   * CONFINED BY `app.can_review_match()`, which is re-applied inside every
   * query under this key. That predicate takes ONE match id and returns a
   * boolean, so this path can confirm a specific pairing and can never
   * enumerate: there is no form of the question that returns a set of people.
   * A delegate holding `approve_communication` gets no directory.
   */
  'family.read_review_packet',

  /**
   * Recording a review decision, and the match transition it causes.
   *
   * ONE TRANSACTION covering `family_reviews`, `matches.communication_state`
   * and the `match_events` row. None of the three is member-writable: a
   * member who could write the match could move it past the Family Safety
   * gate directly, and a decision recorded without its transition would leave
   * the gate and the review disagreeing about whether anyone may speak.
   *
   * The decider is established before the transaction opens, from
   * `app.can_review_match()` under the caller's own session. The database
   * independently refuses a decision by the owner
   * (`family_reviews_decider_not_owner`), so D12 row 2 does not depend on
   * this route being correct.
   */
  'family.decide_review',

  /**
   * Appending to `family_access_log`.
   *
   * The anti-coercion control. Members hold SELECT and nothing else — an
   * audit a delegate can write is not an audit, and a delegate who could
   * delete a row could act unobserved, which is the precise harm R16
   * describes.
   */
  'family.record_access',

  /**
   * Warning an owner that a review has stalled past the SLA.
   *
   * D12-g: 72 hours, NOTIFY ONLY. `notifications` has no member INSERT path,
   * and `family_reviews.sla_notified_at` is server state — a member who could
   * write it could clear their own marker and warn the owner repeatedly, or
   * set it and suppress the warning entirely, which would disable the control
   * that exists to surface a stalling delegate.
   *
   * The sweep deliberately changes no decision. There is no `expired` value
   * to move a review into, because silence must not become consent.
   */
  'family.notify_stalled',

  /**
   * Claiming and releasing a discovery generation run.
   *
   * `discovery_generation_runs` has no member grant and no policy: it is
   * scheduling state, not member data. A member able to write it could claim
   * another member's run and starve their feed, or clear their own cooldown
   * and make a 500-candidate scoring pass runnable on every request.
   *
   * The viewer id comes from `app.current_user_id()` resolved under the
   * caller's own session before this opens, never from the request.
   */
  'discovery.claim_generation',
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
