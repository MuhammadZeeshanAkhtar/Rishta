import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, type TestDb } from './harness';

/**
 * Migration-level tests: does the schema apply, and does it enforce the
 * invariants the ERD claims it does?
 *
 * These run against a real Postgres (PGlite), applying the migration files
 * exactly as written. A migration that cannot apply here will not apply in
 * production either.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('migrations apply', () => {
  it('creates every table through Phase 7, including conversations', async () => {
    const rows = await db.admin<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      // Sorted, because the query is. Phases 1-6 Slice 2.
      // Review Phase 4 (0030): account deletion requests (L7/L10).
      'account_deletion_requests',
      // Review Phase 3 (0029): the L1 admin/moderation backend.
      'admin_action_audit',
      'admin_role_assignments',
      'admin_users',
      'blocks',
      'compatibility_factors',
      'compatibility_scores',
      'conversation_participants',
      'conversation_stages',
      'conversations',
      'discovery_generation_runs',
      'dismissed_profiles',
      // Review B6 (0029): date-of-birth corrections, company decision 4.
      'dob_correction_requests',
      'family_access_log',
      'family_invitations',
      'family_permissions',
      'family_relationships',
      'family_reviews',
      'interest_events',
      'interests',
      'match_candidates',
      'match_events',
      'matches',
      'media_moderation_results',
      'message_reads',
      'messages',
      'moderation_actions',
      // Review Phase 4 (0030): notification preferences (L10).
      'notification_preferences',
      'notifications',
      'partner_preferences',
      // Review Phase 5 (0031): photo grants and requests (L3).
      'photo_grants',
      'photo_requests',
      'photo_variants',
      'photos',
      'pii_access_log',
      'preference_rules',
      'profile_field_visibility',
      'profile_sensitive',
      // Review Phase 4 (0030): profile views (L10).
      'profile_views',
      'profiles',
      // Review Phase 4 (0030): push tokens (L10).
      'push_tokens',
      'reference_items',
      'reference_translations',
      'reports',
      'security_events',
      'shortlists',
      'stage_transitions',
      'system_flags',
      'usage_counters',
      'user_auth_links',
      'user_consents',
      'user_devices',
      'user_entitlements',
      'user_locations',
      'user_settings',
      'users',
      'verification_status',
    ]);
  });

  it('enables AND forces RLS on every table', async () => {
    // FORCE matters: without it the table owner bypasses policies, which would
    // silently defeat every test that runs as the owner.
    const rows = await db.admin<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    // 45 through Phase 7; +5 in 0029 (review L1/B6); +4 in 0030 (review L10);
    // +2 in 0031 (review L3).
    expect(rows.length).toBe(57);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it('leaves restricted tables with zero policies — the absence is the control', async () => {
    const rows = await db.admin<{ tablename: string; n: number }>(
      `select t.tablename, count(p.policyname)::int as n
       from pg_tables t
       left join pg_policies p on p.tablename = t.tablename and p.schemaname = 'public'
       where t.schemaname = 'public'
         and t.tablename in (
           'user_auth_links', 'user_consents', 'profile_sensitive',
           'media_moderation_results',
           -- Scheduling state and operator switches. Neither is member data,
           -- and discovery_generation_runs had been left out of this
           -- assertion since 0023 - a zero-policy table nothing checks is one
           -- policy away from being readable by accident.
           'discovery_generation_runs', 'system_flags'
         )
       group by t.tablename order by t.tablename`,
    );
    expect(rows).toEqual([
      { tablename: 'discovery_generation_runs', n: 0 },
      { tablename: 'media_moderation_results', n: 0 },
      { tablename: 'profile_sensitive', n: 0 },
      { tablename: 'system_flags', n: 0 },
      { tablename: 'user_auth_links', n: 0 },
      { tablename: 'user_consents', n: 0 },
    ]);
  });

  it('defines app.current_user_id() as STABLE', async () => {
    // STABLE lets Postgres evaluate it once per statement rather than once per
    // row. Marked VOLATILE, discovery degrades from fast to unusable.
    const rows = await db.admin<{ provolatile: string; prosecdef: boolean }>(
      `select provolatile, prosecdef from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'current_user_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.prosecdef).toBe(true);
  });

  it('gates every match period through one trigger, on matches', async () => {
    // Migration 0021. The gate being a trigger rather than a line in a route
    // is what makes "a new match period starts at the gate the current policy
    // requires" true for paths that have not been written yet. A second
    // trigger doing the same job, or this one firing on the wrong events,
    // would be the hole reopening.
    const rows = await db.admin<{ tgname: string; timing: string; events: string }>(
      `select t.tgname,
              case when (t.tgtype & 2) <> 0 then 'before' else 'after' end as timing,
              concat_ws(',',
                case when (t.tgtype &  4) <> 0 then 'insert' end,
                case when (t.tgtype &  8) <> 0 then 'delete' end,
                case when (t.tgtype & 16) <> 0 then 'update' end
              ) as events
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relname = 'matches' and not t.tgisinternal
       order by t.tgname`,
    );
    expect(rows).toEqual([
      // Review B16 (0028). AFTER, and it writes only stage_transitions — it
      // never changes communication_state, so the gate below is still the one
      // trigger that decides a period's state.
      { tgname: 'matches_cancel_stage_proposals', timing: 'after', events: 'update' },
      { tgname: 'matches_gate_new_period', timing: 'before', events: 'insert,update' },
      // Review B1 (0026). Refuses entry into family_approved while any review
      // for the match is not approved. It never SETS the state, so the gate
      // above is still the only trigger that decides a period's starting
      // state — this one only refuses an illegal transition into approval.
      { tgname: 'matches_guard_family_approval', timing: 'before', events: 'update' },
      // Phase 7. Runs AFTER, and only on the state column, so it observes the
      // gate the one above has already decided rather than racing it. It
      // creates the thread; it never changes communication_state, so the
      // "one trigger gates the period" property is intact.
      { tgname: 'matches_open_conversation', timing: 'after', events: 'insert,update' },
      { tgname: 'matches_touch', timing: 'before', events: 'update' },
    ]);
  });

  it('keeps the gate predicate out of every member role', async () => {
    // `app.required_communication_state` answers "does either of these two
    // require family review?". Reachable by `authenticated` it would answer
    // that about anybody, and ADR 0011 is explicit that a counterpart never
    // learns what the other household expects.
    //
    // Asked with has_function_privilege rather than by reading proacl: a
    // function with default privileges has a NULL acl, so aclexplode would
    // return nothing and the assertion would pass for a function that is in
    // fact world-executable.
    const rows = await db.admin<{ role: string; allowed: boolean }>(
      `select r.rolname as role,
              has_function_privilege(
                r.rolname, 'app.required_communication_state(uuid,uuid)', 'execute'
              ) as allowed
       from pg_roles r
       where r.rolname in ('anon', 'authenticated', 'service_role')
       order by r.rolname`,
    );
    expect(rows).toEqual([
      { role: 'anon', allowed: false },
      { role: 'authenticated', allowed: false },
      { role: 'service_role', allowed: true },
    ]);
  });
});

/**
 * The Data API turns every privilege below into something callable directly:
 * `anon` by anyone holding the publishable key (which ships in the app), and
 * `authenticated` by any member holding their own JWT. These lists are the
 * complete reachable surface, pinned. A new grant has to be added here on
 * purpose, in the same change that needs it.
 *
 * Sorted in JS rather than SQL so the order does not depend on collation.
 */
describe('grants — the surface the Data API exposes', () => {
  it('grants anon and api_member exactly these table privileges', async () => {
    const rows = await db.admin<{ g: string }>(
      `select c.relname || ' ' || r.rolname || ' ' || a.privilege_type as g
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(c.relacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relkind = 'r' and r.rolname in ('anon', 'api_member')`,
    );
    expect(rows.map((r) => r.g).sort()).toEqual([
      // Sorted, because the assertion sorts. Writes are the exception and
      // each one is deliberate: blocks, the owner actions, and interests.
      'blocks api_member DELETE',
      'blocks api_member INSERT',
      'blocks api_member SELECT',
      'compatibility_factors api_member SELECT',
      'compatibility_scores api_member SELECT',
      // Phase 7. SELECT on the thread is membership; INSERT on `messages` is
      // a COLUMN grant additionally gated by `app.can_write_message()` — the
      // one table where a member holds both, and the two policies answer
      // different questions on purpose. No UPDATE or DELETE: edits and
      // deletions are server state that report evidence depends on.
      'conversation_participants api_member SELECT',
      'conversation_stages api_member SELECT',
      'conversations api_member SELECT',
      'dismissed_profiles api_member DELETE',
      'dismissed_profiles api_member INSERT',
      'dismissed_profiles api_member SELECT',
      // 0029 (review B6): a member reads their own DOB correction requests.
      'dob_correction_requests api_member SELECT',
      // Phase 6b. SELECT only, every one of them: an invitation must hash a
      // token, a grant must be refused if its phase has not arrived, a review
      // must be the first for its side, and an audit a delegate can write is
      // not an audit. `system_flags` is absent on purpose — no member grant at
      // all, because a flag a member can read is a roadmap.
      'family_access_log api_member SELECT',
      'family_invitations api_member SELECT',
      'family_permissions api_member SELECT',
      'family_relationships api_member SELECT',
      'family_reviews api_member SELECT',
      // `interests authenticated INSERT` was revoked by 0026 (review B7). The
      // API has always sent through `interest.send`, which consumes the daily
      // quota in the same transaction; the member grant only let the Data API
      // skip the quota.
      'interests api_member SELECT',
      'match_candidates api_member SELECT',
      'matches api_member SELECT',
      'message_reads api_member SELECT',
      'messages api_member SELECT',
      // 0030 (review L10): a member manages their own notification preferences.
      'notification_preferences api_member DELETE',
      'notification_preferences api_member INSERT',
      'notification_preferences api_member SELECT',
      'notifications api_member SELECT',
      'partner_preferences api_member SELECT',
      // 0031 (review L3): each party reads its own requests and grants; the
      // server writes them.
      'photo_grants api_member SELECT',
      'photo_requests api_member SELECT',
      'photo_variants api_member SELECT',
      'photos api_member SELECT',
      'preference_rules api_member DELETE',
      'preference_rules api_member SELECT',
      'profile_field_visibility api_member DELETE',
      'profile_field_visibility api_member SELECT',
      'profiles api_member SELECT',
      'reference_items anon SELECT',
      'reference_items api_member SELECT',
      'reference_translations anon SELECT',
      'reference_translations api_member SELECT',
      // Reports: SELECT only. The reporter is promised the outcome (ERD §14);
      // writes belong to the moderation pipeline, so there is no member path.
      'reports api_member SELECT',
      'security_events api_member SELECT',
      'shortlists api_member DELETE',
      'shortlists api_member INSERT',
      'shortlists api_member SELECT',
      'usage_counters api_member SELECT',
      'user_devices api_member SELECT',
      'user_entitlements api_member SELECT',
      'user_locations api_member SELECT',
      'user_settings api_member SELECT',
      'users api_member SELECT',
      'verification_status api_member SELECT',
    ]);
    // profile_sensitive is absent, and that absence is the whole control.
    expect(rows.some((r) => r.g.startsWith('profile_sensitive'))).toBe(false);
  });

  it('never exposes a system-owned column to a member', async () => {
    // Phase 2 enumerated the twelve writable columns literally. With Phase 3
    // that list is 135 entries, which is unreadable and would be updated by
    // reflex rather than by thought — the failure mode where a test stops
    // being a control and becomes a chore.
    //
    // Stated instead as the property that actually matters: these columns are
    // server-owned, and a member who could write any one of them could make
    // themselves discoverable, un-suspend themselves, or rewrite history.
    const forbidden = [
      // Identity state
      'users.status',
      'users.deleted_at',
      'users.profile_completed_at',
      'users.created_at',
      // Review state — writing this means discoverable without passing review
      'profiles.review_status',
      'profiles.user_id',
      'profiles.completion_score',
      'profiles.submitted_at',
      'profiles.reviewed_at',
      'profiles.rejection_reason_key',
      'profiles.deleted_at',
      // Ownership. INSERT on user_id is legitimate — a new row must name its
      // owner, and the insert policy pins it to app.current_user_id(). UPDATE
      // is not: it would move an existing row to another account.
      'partner_preferences.user_id',
      'user_locations.user_id',
      'profile_field_visibility.user_id',
      'preference_rules.user_id',
      // Audit
      'security_events.event_type',
      // Phase 4 — moderation and deletion are the server's. A member who could
      // write moderation_status would publish an unchecked photo; deleted_at
      // cannot be member-written at all under FORCE RLS (migration 0008).
      'photos.moderation_status',
      'photos.rejection_reason_key',
      'photos.deleted_at',
      'photos.user_id',
      'photos.storage_path',
      'verification_status.email_verified_at',
      'verification_status.phone_verified_at',
      // `user_settings.communication_policy` WAS on this list, placed here by
      // migration 0021 with the note that it "joins the grant in the slice
      // that can honour it". Migration 0024 is that slice, so it is now
      // member-writable and no longer belongs among server-owned columns.
      // The property it was protecting — nobody picks a gate that cannot be
      // opened — is now covered where it can actually be acted on, by
      // `familyReviewersCount` on the account read.
      //
      // Phase 6b — the family layer is entirely server-owned. A member who
      // could write any of these could grant themselves a right over someone
      // else, decide their own review, or edit the audit of what they did.
      'family_relationships.status',
      'family_relationships.owner_user_id',
      'family_relationships.delegate_user_id',
      'family_permissions.permission',
      'family_permissions.granted',
      'family_permissions.relationship_id',
      'family_invitations.token_hash',
      'family_invitations.status',
      'family_invitations.expires_at',
      'family_reviews.decision',
      'family_reviews.decided_by_user_id',
      'family_reviews.sla_notified_at',
      'family_access_log.action',
      'family_access_log.permission',
      'system_flags.enabled',
    ];

    // UPDATE only. INSERT on an ownership column is safe because the insert
    // policy pins the value; UPDATE on one is not.
    const rows = await db.admin<{ g: string }>(
      `select c.relname || '.' || att.attname as g
       from pg_attribute att
       join pg_class c on c.oid = att.attrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(att.attacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relkind = 'r' and att.attnum > 0 and not att.attisdropped
         and r.rolname in ('anon', 'api_member')
         and a.privilege_type = 'UPDATE'`,
    );
    const granted = new Set(rows.map((r) => r.g));
    expect(forbidden.filter((f) => granted.has(f))).toEqual([]);
  });

  it('confines column grants to the tables that are meant to have them', async () => {
    // The companion to the check above: it catches a NEW table becoming
    // member-writable, which a denylist of known columns cannot see.
    const rows = await db.admin<{ relname: string }>(
      `select distinct c.relname
       from pg_attribute att
       join pg_class c on c.oid = att.attrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(att.attacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relkind = 'r' and att.attnum > 0 and not att.attisdropped
         and r.rolname in ('anon', 'api_member')
       order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      // 0029 (review B6): `insert (user_id, requested_dob, reason)` only; the
      // status and the decision are the server's.
      'dob_correction_requests',
      // Phase 7: `insert (conversation_id, sender_user_id, body, kind)` only.
      // `moderation_status`, `edited_at` and `deleted_at` are server state
      // that report evidence depends on, and a member who could set
      // `acted_by_user_id` could attribute their own words to a delegate.
      'messages',
      // Phase 6 Slice 5: `update (read_at)` only, so marking a notification
      // read cannot become rewriting its type or payload.
      'notifications',
      'partner_preferences',
      'photos',
      'preference_rules',
      'profile_field_visibility',
      'profiles',
      'user_devices',
      'user_locations',
      'user_settings',
      'users',
    ]);
  });

  it('gives anon no write access anywhere', async () => {
    // anon holds the publishable key, which ships inside the app.
    const rows = await db.admin<{ g: string }>(
      `select c.relname || ' ' || a.privilege_type as g
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(c.relacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relkind = 'r' and r.rolname = 'anon' and a.privilege_type <> 'SELECT'
       union all
       select c.relname || '.' || att.attname || ' ' || a.privilege_type
       from pg_attribute att
       join pg_class c on c.oid = att.attrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(att.attacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relkind = 'r' and att.attnum > 0 and r.rolname = 'anon'`,
    );
    expect(rows.map((r) => r.g)).toEqual([]);
  });

  it('leaves no automatic grants for tables that later migrations create', async () => {
    // The forward guard. Supabase's platform defaults would otherwise hand
    // anon and authenticated full access to every table Phase 2 onwards adds,
    // the moment it is created — before anyone has written its policies.
    //
    // Asked by creating a table and looking at what it got, not by reading
    // pg_default_acl. Default privileges apply per GRANTOR, so a catalog row
    // may be entirely irrelevant to the role that actually runs migrations —
    // reading it directly invites a confident wrong answer in both directions.
    await db.admin(`create table public.zz_grant_probe (id int)`);
    try {
      const rows = await db.admin<{ grantee: string; privs: string }>(
        `select r.rolname as grantee,
                string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         cross join lateral aclexplode(c.relacl) a
         join pg_roles r on r.oid = a.grantee
         where c.relname = 'zz_grant_probe'
           and r.rolname in ('anon', 'api_member')
         group by 1`,
      );
      expect(rows).toEqual([]);
    } finally {
      await db.admin(`drop table public.zz_grant_probe`);
    }
  });
});

describe('users constraints', () => {
  it('rejects a gender outside the closed set', async () => {
    await expect(
      db.admin(
        `insert into public.users (display_name, gender, date_of_birth, country_code)
         values ('X', 'other', date '1990-01-01', 'pk')`,
      ),
    ).rejects.toThrow(/users_gender_valid/);
  });

  it('rejects a country code that is not in reference data', async () => {
    // The composite FK is what stops a profile field pointing at the wrong
    // reference type (ERD E2).
    await expect(
      db.admin(
        `insert into public.users (display_name, gender, date_of_birth, country_code)
         values ('X', 'female', date '1990-01-01', 'zz')`,
      ),
    ).rejects.toThrow(/users_country_fk/);
  });

  it('rejects someone under 18', async () => {
    await expect(
      db.admin(
        `insert into public.users (display_name, gender, date_of_birth, country_code)
         values ('X', 'female', current_date - interval '17 years', 'pk')`,
      ),
    ).rejects.toThrow(/at least 18/);
  });

  it('accepts someone who turned 18 today', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code)
       values ('Exactly18', 'male', current_date - interval '18 years', 'pk')
       returning id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to change gender once the profile is complete', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, profile_completed_at)
       values ('Locked', 'female', date '1995-01-01', 'pk', now())
       returning id`,
    );
    await expect(
      db.admin(`update public.users set gender = 'male' where id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/gender is immutable/);
  });

  it('allows gender to change while onboarding is still in progress', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code)
       values ('StillOnboarding', 'female', date '1995-01-01', 'pk')
       returning id`,
    );
    await expect(
      db.admin(`update public.users set gender = 'male' where id = $1`, [rows[0]!.id]),
    ).resolves.toBeDefined();
  });

  it('maintains updated_at on write', async () => {
    const rows = await db.admin<{ id: string; updated_at: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code)
       values ('Touch', 'female', date '1995-01-01', 'pk')
       returning id, updated_at`,
    );
    const after = await db.admin<{ updated_at: string }>(
      `update public.users set display_name = 'Touched' where id = $1 returning updated_at`,
      [rows[0]!.id],
    );
    expect(new Date(after[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(rows[0]!.updated_at).getTime(),
    );
  });
});

describe('progressive onboarding', () => {
  it('allows an account row with no identity while onboarding', async () => {
    // Bootstrap creates this row the moment the JWT is verified, before the
    // person has told us anything about themselves.
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (status) values ('onboarding') returning id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to activate an account with incomplete identity', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (status) values ('onboarding') returning id`,
    );
    await expect(
      db.admin(`update public.users set status = 'active' where id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/users_identity_complete/);
  });

  it('activates once identity is complete', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (status) values ('onboarding') returning id`,
    );
    await expect(
      db.admin(
        `update public.users
         set display_name = 'Complete', gender = 'female',
             date_of_birth = date '1994-03-02', country_code = 'pk',
             status = 'active'
         where id = $1`,
        [rows[0]!.id],
      ),
    ).resolves.toBeDefined();
  });

  it('still rejects an under-18 date of birth supplied later', async () => {
    const rows = await db.admin<{ id: string }>(
      `insert into public.users (status) values ('onboarding') returning id`,
    );
    await expect(
      db.admin(
        `update public.users set date_of_birth = current_date - interval '16 years' where id = $1`,
        [rows[0]!.id],
      ),
    ).rejects.toThrow(/at least 18/);
  });
});

describe('reference data constraints', () => {
  it('rejects a display string where a code belongs', async () => {
    await expect(
      db.admin(
        `insert into public.reference_items (type, code) values ('education_level', 'Bachelor''s Degree')`,
      ),
    ).rejects.toThrow(/reference_items_code_shape/);
  });

  it('accepts a lower_snake_case code', async () => {
    // A code the 0005 seed does not already contain — the point is the shape
    // constraint, and reusing a seeded code would test the unique index instead.
    await expect(
      db.admin(
        `insert into public.reference_items (type, code) values ('education_level', 'edu_test_shape')`,
      ),
    ).resolves.toBeDefined();
    // Removed again: an untranslated item left behind would fail the
    // translation-completeness check below, which is a genuine assertion about
    // seeded data rather than about this fixture.
    await db.admin(`delete from public.reference_items where code = 'edu_test_shape'`);
  });

  it('seeds reference data for every type onboarding needs', async () => {
    const rows = await db.admin<{ type: string; n: number }>(
      `select type, count(*)::int as n from public.reference_items group by type order by type`,
    );
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.n]));

    // Every reference-backed field the Phase 3 screens offer. An empty list
    // here is a dropdown a user cannot answer, which blocks onboarding.
    for (const type of [
      'country',
      'language',
      'education_level',
      'field_of_study',
      'profession',
      'industry',
      'employment_status',
      'marital_status',
      'religious_practice',
      'sect',
      'prayer_frequency',
      'quran_level',
      'marriage_timeline',
      'relocation_option',
      'hobby',
      'lifestyle_attribute',
      'personality_trait',
      'dress_practice',
      'diet',
      'smoking',
    ]) {
      expect(byType[type], `${type} has no reference items`).toBeGreaterThan(0);
    }
  });

  it('translates every seeded item into English', async () => {
    // A missing translation renders as the raw code — `edu_bachelors` in a
    // dropdown — which is the kind of thing that ships unnoticed.
    const rows = await db.admin<{ locale: string; missing: number }>(
      `select l.locale, count(*)::int as missing
       from public.reference_items i
       cross join (values ('en')) as l(locale)
       left join public.reference_translations t
         on t.reference_item_id = i.id and t.locale = l.locale
       where t.id is null
       group by l.locale`,
    );
    expect(rows).toEqual([]);
  });

  it('carries no locale other than English', async () => {
    // 0005 seeds Urdu and 0009 removes it. Running both must leave a
    // single-locale catalog, or a fresh database and an existing one disagree.
    const rows = await db.admin<{ locale: string }>(
      `select distinct locale from public.reference_translations order by locale`,
    );
    expect(rows.map((r) => r.locale)).toEqual(['en']);
  });

  it('refuses to store a translation in a removed locale', async () => {
    const item = await db.admin<{ id: string }>(`select id from public.reference_items limit 1`);
    await expect(
      db.admin(
        `insert into public.reference_translations (reference_item_id, locale, label)
         values ($1::uuid, 'ur', 'test')`,
        [item[0]!.id],
      ),
    ).rejects.toThrow(/reference_translations_locale_supported/);
  });

  it('keeps country codes lower-case so they satisfy the reference FK', async () => {
    // reference_items_code_shape forbids upper case, and users.country_code
    // carries a composite FK to (type, code). An upper-case 'PK' anywhere in
    // this chain fails at insert time, not at validation time.
    const rows = await db.admin<{ code: string }>(
      `select code from public.reference_items where type = 'country' and code <> lower(code)`,
    );
    expect(rows).toEqual([]);
  });

  it('rejects an unknown reference type', async () => {
    await expect(
      db.admin(
        `insert into public.reference_items (type, code) values ('favourite_colour', 'blue')`,
      ),
    ).rejects.toThrow(/reference_items_type_valid/);
  });

  it('enforces one translation per item per locale', async () => {
    const item = await db.admin<{ id: string }>(
      `insert into public.reference_items (type, code) values ('diet', 'halal_only') returning id`,
    );
    await db.admin(
      `insert into public.reference_translations (reference_item_id, locale, label)
       values ($1, 'en', 'Halal only')`,
      [item[0]!.id],
    );
    await expect(
      db.admin(
        `insert into public.reference_translations (reference_item_id, locale, label)
         values ($1, 'en', 'Duplicate')`,
        [item[0]!.id],
      ),
    ).rejects.toThrow(/reference_translations_item_locale_key/);
  });
});
