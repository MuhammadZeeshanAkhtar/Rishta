import {
  BEFORE,
  INSERT,
  ROW,
  checkTriggers,
  type ExpectedTrigger,
  type Queryable,
  type SecurityCheck,
} from './phase1-security-checks';

/**
 * The Phase 4 account configuration (code review, 2026-11-04; migration
 * 0030), checked against whatever database `db` reaches.
 *
 * Called by `verify-db.ts` against the live project and by
 * `test/verify-phase4-account.test.ts` against PGlite, including databases
 * broken one way at a time. Read-only.
 *
 *   L10  in-app OFF suppresses the inbox row at the table, for every writer
 *   L10  push tokens, profile views and deletion requests: no member access
 *   L10  a member's preferences are theirs alone (RLS forced)
 *   L11  retention and expiry functions are service-role only
 */

const MEMBER_ROLES = ['anon', 'authenticated'] as const;

export const PHASE4_RESTRICTED_TABLES = [
  'push_tokens',
  'profile_views',
  'account_deletion_requests',
] as const;

export const PHASE4_MAINTENANCE_FUNCTIONS = [
  'app.purge_expired_security_events()',
  'app.purge_expired_profile_views()',
  'app.expire_family_invitations()',
] as const;

const TRIGGERS: ExpectedTrigger[] = [
  {
    finding: 'L10',
    name: 'notifications_respect_preferences',
    table: 'public.notifications',
    tgtype: ROW | BEFORE | INSERT,
    timing: 'BEFORE INSERT, FOR EACH ROW',
    columns: [],
    fn: 'app.respect_notification_preferences',
    bodyMustContain: ['not np.inapp_enabled', 'return null'],
  },
];

async function otherChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  // --- restricted tables ------------------------------------------------------
  {
    const label =
      'L10 no member privilege on push_tokens, profile_views, account_deletion_requests';
    const { rows: present } = await db.query<{ tbl: string }>(
      `select t as tbl from unnest($1::text[]) as t where to_regclass('public.' || t) is not null`,
      [PHASE4_RESTRICTED_TABLES],
    );
    // Unlike Phase 3's admin tables, absence here is a failure: the API reads
    // and writes these tables, so a database without them is not migrated.
    const missing = PHASE4_RESTRICTED_TABLES.filter((t) => !present.some((p) => p.tbl === t));
    const { rows } = await db.query<{ role: string; tbl: string; can: boolean }>(
      `select r as role, t as tbl,
              (has_table_privilege(r, 'public.' || t, 'SELECT')
               or has_table_privilege(r, 'public.' || t, 'INSERT')
               or has_table_privilege(r, 'public.' || t, 'UPDATE')
               or has_table_privilege(r, 'public.' || t, 'DELETE')) as can
         from unnest($1::text[]) as r, unnest($2::text[]) as t
        where to_regclass('public.' || t) is not null`,
      [MEMBER_ROLES, PHASE4_RESTRICTED_TABLES],
    );
    const open = rows.filter((r) => r.can).map((r) => `${r.role}:${r.tbl}`);
    const problems = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(open.length ? [`reachable: ${open.join(', ')}`] : []),
    ];
    out.push(
      problems.length === 0
        ? { name: label, ok: true }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- notification_preferences: RLS forced, owner-only ----------------------
  {
    const label = 'L10 notification_preferences RLS enabled and forced, owner-only policies';
    const { rows } = await db.query<{
      rls: boolean;
      forced: boolean;
      policies: number;
      foreign: number;
    }>(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'notification_preferences') as policies,
              (select count(*)::int from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'notification_preferences'
                  and coalesce(p.qual, '') || coalesce(p.with_check, '') not like '%current_user_id()%') as foreign
         from pg_class c
        where c.oid = to_regclass('public.notification_preferences')`,
    );
    const r = rows[0];
    const problems = !r
      ? ['missing']
      : [
          ...(r.rls ? [] : ['RLS disabled']),
          ...(r.forced ? [] : ['RLS not forced']),
          ...(r.policies > 0 ? [] : ['no policies']),
          ...(r.foreign === 0 ? [] : [`${r.foreign} policy not scoped to the owner`]),
        ];
    out.push(
      problems.length === 0
        ? { name: label, ok: true }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- L11: maintenance is the server's --------------------------------------
  {
    const label = 'L11 retention and expiry functions are service-role only';
    const problems: string[] = [];
    for (const fn of PHASE4_MAINTENANCE_FUNCTIONS) {
      const { rows: exists } = await db.query<{ ok: boolean }>(
        `select to_regprocedure($1) is not null as ok`,
        [fn],
      );
      if (!exists[0]?.ok) {
        problems.push(`${fn} missing`);
        continue;
      }
      const { rows } = await db.query<{ role: string; can: boolean }>(
        `select r as role, has_function_privilege(r, $2, 'EXECUTE') as can from unnest($1::text[]) as r`,
        [MEMBER_ROLES, fn],
      );
      const open = rows.filter((r) => r.can).map((r) => r.role);
      if (open.length) problems.push(`${fn} executable by ${open.join(', ')}`);
    }
    out.push(
      problems.length === 0
        ? { name: label, ok: true, detail: PHASE4_MAINTENANCE_FUNCTIONS.join(', ') }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }
}

export async function phase4AccountChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  const sections: Array<[string, (d: Queryable, o: SecurityCheck[]) => Promise<void>]> = [
    ['Phase 4 trigger checks', (d, o) => checkTriggers(d, o, TRIGGERS)],
    ['Phase 4 other checks', otherChecks],
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
