import { apiMemberRole, type Queryable, type SecurityCheck } from './phase1-security-checks';

/**
 * The post-merge security configuration (migration 0032), checked against
 * whatever database `db` reaches. Read-only. Called by `verify-db.ts` and by
 * `test/verify-account-security.test.ts`, including against databases broken one
 * way at a time.
 *
 *   N2  a member's direct read of profiles and photos is owner-only
 *   N1  every member-reachable table refuses a restricted account
 *   N1  only the server can end a suspension
 */

export const OWNER_ONLY_CHECK = 'N2 profiles, photos, photo_variants: members read only their own';
export const RESTRICTED_CHECK = 'N1 every member-reachable table refuses a restricted account';
export const LIFT_CHECK = 'N1 only the server can end a suspension';

const OWNER_ONLY_TABLES = ['profiles', 'photos', 'photo_variants'] as const;

/**
 * Member-readable tables deliberately open to a restricted account for READ:
 * `GET /me` reads the first five as the caller, and reference data is not member
 * data. Everything else a member can reach must carry a restrictive policy, so
 * a table added later fails this check until someone decides.
 */
export const READ_EXEMPT_TABLES = [
  'users',
  'user_settings',
  'verification_status',
  'family_relationships',
  'family_permissions',
  'reference_items',
  'reference_translations',
] as const;

const result = (name: string, problems: string[]): SecurityCheck =>
  problems.length === 0 ? { name, ok: true } : { name, ok: false, detail: problems.join('; ') };

async function ownerOnly(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const { rows } = await db.query<{ tablename: string; policyname: string; qual: string | null }>(
    `select tablename, policyname, qual from pg_policies
      where schemaname = 'public' and tablename = any($1::text[])
        and cmd in ('SELECT', 'ALL') and permissive = 'PERMISSIVE'`,
    [OWNER_ONLY_TABLES],
  );
  for (const table of OWNER_ONLY_TABLES) {
    const policies = rows.filter((r) => r.tablename === table);
    if (policies.length === 0) problems.push(`${table}: no SELECT policy`);
    for (const policy of policies) {
      const qual = policy.qual ?? '';
      // Permissive policies OR together, so each one must hold on its own.
      const scoped = qual.includes('current_user_id()');
      const widened = /visible_to|can_view_|family_grant|\bor\b/i.test(qual);
      if (!scoped || widened) {
        problems.push(`${table}: ${policy.policyname} is not owner-only: ${qual}`);
      }
    }
  }
  return problems;
}

async function restricted(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const { rows: fn } = await db.query<{ ok: boolean }>(
    `select to_regprocedure('app.current_account_can_act()') is not null as ok`,
  );
  if (!fn[0]?.ok) problems.push('app.current_account_can_act() missing');

  const { rows: tables } = await db.query<{
    table_name: string;
    can_write: boolean;
    guards: string[] | null;
  }>(
    `with reachable as (
       select c.relname as table_name,
              has_table_privilege($1, c.oid, 'INSERT')
                or has_table_privilege($1, c.oid, 'UPDATE')
                or has_table_privilege($1, c.oid, 'DELETE')
                or has_any_column_privilege($1, c.oid, 'INSERT')
                or has_any_column_privilege($1, c.oid, 'UPDATE') as can_write,
              has_table_privilege($1, c.oid, 'SELECT')
                or has_any_column_privilege($1, c.oid, 'SELECT') as can_read
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
     )
     select r.table_name, r.can_write,
            (select array_agg(p.cmd::text) from pg_policies p
              where p.schemaname = 'public' and p.tablename = r.table_name
                and p.permissive = 'RESTRICTIVE'
                and p.qual like '%current_account_can_act%') as guards
       from reachable r
      where r.can_read or r.can_write
      order by 1`,
    [await apiMemberRole(db)],
  );
  for (const table of tables) {
    const guards = table.guards ?? [];
    const exempt = (READ_EXEMPT_TABLES as readonly string[]).includes(table.table_name);
    if (!exempt && !guards.includes('ALL')) {
      problems.push(`${table.table_name}: no restrictive policy`);
    }
    if (exempt && table.can_write && !guards.includes('ALL') && !guards.includes('UPDATE')) {
      problems.push(`${table.table_name}: read-exempt but writable without a restrictive policy`);
    }
  }
  return problems;
}

async function lift(db: Queryable): Promise<string[]> {
  const signature = 'app.lift_expired_suspensions(uuid)';
  const { rows } = await db.query<{ ok: boolean }>(`select to_regprocedure($1) is not null as ok`, [
    signature,
  ]);
  if (!rows[0]?.ok) return [`${signature} missing`];
  const problems: string[] = [];
  const { rows: grants } = await db.query<{ role: string; can: boolean }>(
    `select r as role, has_function_privilege(r, $1, 'EXECUTE') as can
       from unnest(array['anon', 'authenticated', 'service_role']) as r`,
    [signature],
  );
  for (const grant of grants) {
    const allowed = grant.role === 'service_role';
    if (grant.can && !allowed) problems.push(`${grant.role} may run ${signature}`);
    if (!grant.can && allowed) problems.push(`service_role cannot run ${signature}`);
  }
  return problems;
}

export async function accountSecurityChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  for (const [name, run] of [
    [OWNER_ONLY_CHECK, ownerOnly],
    [RESTRICTED_CHECK, restricted],
    [LIFT_CHECK, lift],
  ] as const) {
    try {
      out.push(result(name, await run(db)));
    } catch (error) {
      out.push({ name, ok: false, detail: `crashed: ${(error as Error).message}` });
    }
  }
  return out;
}
