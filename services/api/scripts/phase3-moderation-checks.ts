import {
  BEFORE,
  INSERT,
  ROW,
  UPDATE,
  checkTriggers,
  normalise,
  type ExpectedTrigger,
  type Queryable,
  type SecurityCheck,
  memberRoles,
} from './phase1-security-checks';

/**
 * The Phase 3 moderation configuration (code review, 2026-10-28; migration
 * 0029), checked against whatever database `db` reaches.
 *
 * Called by `verify-db.ts` against the live project and by
 * `test/verify-phase3-moderation.test.ts` against PGlite, including databases
 * broken one way at a time. Read-only.
 *
 *   B6   DOB lock; re-review on edited text and on rename; correction snapshot
 *   B13  only an approved photo can be primary
 *   L1   admin tables unreachable by members; audit append-only for every role
 *   B26  retention is service-role only
 */

const DELETE = 8;

const TRIGGERS: ExpectedTrigger[] = [
  {
    finding: 'B6',
    name: 'users_dob_locked',
    table: 'public.users',
    tgtype: ROW | BEFORE | UPDATE,
    timing: 'BEFORE UPDATE OF date_of_birth, FOR EACH ROW',
    columns: ['date_of_birth'],
    fn: 'app.enforce_dob_locked',
    bodyMustContain: ['old.profile_completed_at is not null', 'raise exception'],
  },
  {
    finding: 'B6',
    name: 'profiles_rereview_on_edit',
    table: 'public.profiles',
    tgtype: ROW | BEFORE | UPDATE,
    timing: 'BEFORE UPDATE, FOR EACH ROW',
    columns: [],
    fn: 'app.rereview_on_profile_edit',
    bodyMustContain: [
      "new.review_status := 'pending'",
      'new.about_me is distinct from old.about_me',
    ],
  },
  {
    finding: 'B6',
    name: 'users_rereview_on_name_change',
    table: 'public.users',
    tgtype: ROW | UPDATE,
    timing: 'AFTER UPDATE OF display_name, FOR EACH ROW',
    columns: ['display_name'],
    fn: 'app.rereview_on_name_change',
    bodyMustContain: ['send_own_profile_to_review()'],
  },
  {
    finding: 'B6',
    name: 'dob_correction_requests_snapshot',
    table: 'public.dob_correction_requests',
    tgtype: ROW | BEFORE | INSERT,
    timing: 'BEFORE INSERT, FOR EACH ROW',
    columns: [],
    fn: 'app.snapshot_current_dob',
    bodyMustContain: ['new.current_dob :='],
  },
  {
    finding: 'L1',
    name: 'admin_action_audit_append_only',
    table: 'public.admin_action_audit',
    tgtype: ROW | BEFORE | UPDATE | DELETE,
    timing: 'BEFORE UPDATE OR DELETE, FOR EACH ROW',
    columns: [],
    fn: 'app.audit_is_append_only',
    bodyMustContain: ['raise exception'],
  },
];

const ADMIN_TABLES = [
  'admin_users',
  'admin_role_assignments',
  'admin_action_audit',
  'moderation_actions',
] as const;

async function otherChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  // --- B13 ------------------------------------------------------------------
  {
    const label = 'B13 photos_primary_approved';
    const { rows } = await db.query<{ validated: boolean; def: string }>(
      `select convalidated as validated, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'public.photos'::regclass and conname = 'photos_primary_approved'`,
    );
    const def = normalise(rows[0]?.def ?? '');
    const ok = !!rows[0]?.validated && def.includes("moderation_status = 'approved'");
    out.push(
      ok
        ? { name: label, ok: true, detail: 'a primary photo must be approved' }
        : { name: label, ok: false, detail: rows[0] ? 'not validated or wrong rule' : 'missing' },
    );
  }

  // --- B6: the rename trigger must see the CALLER ---------------------------
  {
    const label = 'B6 rename re-review runs with the caller’s rights';
    const { rows } = await db.query<{ name: string; secdef: boolean; args: number }>(
      `select p.proname as name, p.prosecdef as secdef, p.pronargs::int as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
        where p.proname in ('rereview_on_name_change', 'send_own_profile_to_review')`,
    );
    const trigger = rows.find((r) => r.name === 'rereview_on_name_change');
    const helper = rows.find((r) => r.name === 'send_own_profile_to_review');
    const problems: string[] = [];
    // SECURITY DEFINER here makes current_user the owner, so a member's rename
    // looks like the server's and is never re-reviewed.
    if (!trigger) problems.push('trigger function missing');
    else if (trigger.secdef) problems.push('trigger function is SECURITY DEFINER');
    if (!helper) problems.push('helper missing');
    else if (helper.args !== 0)
      problems.push('helper takes arguments — it could target another member');
    out.push(
      problems.length === 0
        ? { name: label, ok: true, detail: 'invoker trigger; argument-free definer helper' }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- L1: admin tables are not a member surface ----------------------------
  {
    const label = 'L1 no member privilege on admin tables';
    const { rows } = await db.query<{ role: string; tbl: string; can: boolean }>(
      `select r as role, t as tbl,
              (has_table_privilege(r, 'public.' || t, 'SELECT')
               or has_table_privilege(r, 'public.' || t, 'INSERT')
               or has_table_privilege(r, 'public.' || t, 'UPDATE')
               or has_table_privilege(r, 'public.' || t, 'DELETE')) as can
         from unnest($1::text[]) as r, unnest($2::text[]) as t
        -- has_table_privilege throws on a missing table; an absent table is
        -- unreachable, which is the property this check asserts.
        where to_regclass('public.' || t) is not null`,
      [await memberRoles(db), ADMIN_TABLES],
    );
    const open = rows.filter((r) => r.can).map((r) => `${r.role}:${r.tbl}`);
    out.push(
      open.length === 0
        ? { name: label, ok: true, detail: ADMIN_TABLES.join(', ') }
        : { name: label, ok: false, detail: `reachable: ${open.join(', ')}` },
    );
  }

  // --- L1: moderator predicate requires MFA ---------------------------------
  {
    const label = 'L1 app.is_active_moderator requires aal2 when MFA is required';
    const { rows } = await db.query<{ body: string }>(
      `select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'is_active_moderator'`,
    );
    const body = normalise(rows[0]?.body ?? '');
    const ok = body.includes("'aal2'") && body.includes('a.mfa_required');
    out.push(
      ok
        ? { name: label, ok: true }
        : { name: label, ok: false, detail: rows[0] ? 'no longer checks aal2' : 'missing' },
    );
  }

  // --- B26: retention is the server's ----------------------------------------
  {
    const label = 'B26 app.purge_expired_notifications is service-role only';
    const { rows: exists } = await db.query<{ ok: boolean }>(
      `select to_regprocedure('app.purge_expired_notifications()') is not null as ok`,
    );
    if (!exists[0]?.ok) {
      out.push({ name: label, ok: false, detail: 'missing' });
    } else {
      const { rows } = await db.query<{ role: string; can: boolean }>(
        `select r as role,
                has_function_privilege(r, 'app.purge_expired_notifications()', 'EXECUTE') as can
           from unnest($1::text[]) as r`,
        [await memberRoles(db)],
      );
      const open = rows.filter((r) => r.can).map((r) => r.role);
      out.push(
        open.length === 0
          ? { name: label, ok: true }
          : { name: label, ok: false, detail: `EXECUTE held by: ${open.join(', ')}` },
      );
    }
  }
}

export async function phase3ModerationChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  const sections: Array<[string, (d: Queryable, o: SecurityCheck[]) => Promise<void>]> = [
    ['Phase 3 trigger checks', (d, o) => checkTriggers(d, o, TRIGGERS)],
    ['Phase 3 other checks', otherChecks],
  ];
  for (const [label, run] of sections) {
    try {
      await run(db, out);
    } catch (error) {
      out.push({ name: label, ok: false, detail: `crashed: ${(error as Error).message}` });
    }
  }
  return out;
}
