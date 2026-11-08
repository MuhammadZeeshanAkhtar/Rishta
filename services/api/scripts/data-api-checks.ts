import type { Queryable, SecurityCheck } from './phase1-security-checks';

/**
 * What a member's JWT can reach directly (migrations 0033 and 0034), checked
 * against whatever database `db` reaches. Read-only. Called by `verify-db.ts` and
 * `test/verify-data-api.test.ts`.
 *
 *   B7  `authenticated` can write nothing and read nothing in `public`, except the
 *       three `messages` columns Realtime needs
 *   B7  the API's role exists, holds the privileges, and is out of PostgREST's reach
 *   P6  the staff access log is out of everyone's direct reach
 */

export const NO_DIRECT_ACCESS_CHECK = 'B7 a member JWT used directly can read and write nothing';
export const API_ROLE_CHECK = 'B7 only the API can use api_member';
export const ACCESS_LOG_CHECK = 'Staff access log: restricted, append-only, RLS forced';

/** Exactly what Realtime needs to tell a participant a message arrived. */
export const REALTIME_MESSAGE_COLUMNS = ['conversation_id', 'created_at', 'id'] as const;

/** PostgREST and GraphQL switch from these to the role in a member's JWT. */
const CONNECTION_ROLES = ['authenticator', 'anon', 'authenticated', 'service_role'] as const;

const result = (name: string, problems: string[], detail?: string): SecurityCheck =>
  problems.length === 0
    ? { name, ok: true, ...(detail ? { detail } : {}) }
    : { name, ok: false, detail: problems.join('; ') };

async function noDirectAccess(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const { rows: tables } = await db.query<{ table_name: string; priv: string }>(
    `select c.relname as table_name, p.priv
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p (priv)
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
        and has_table_privilege('authenticated', c.oid, p.priv)
      order by 1, 2`,
  );
  for (const t of tables) problems.push(`${t.priv} on ${t.table_name}`);

  const { rows: open } = await db.query<{ signature: string }>(
    `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname <> 'current_user_id'
        and has_function_privilege('anon', p.oid, 'EXECUTE')`,
  );
  for (const fn of open) problems.push(`anon may run ${fn.signature}`);

  // Column grants are invisible to has_table_privilege, so asked separately.
  const { rows: columns } = await db.query<{ col: string; priv: string }>(
    `select c.relname || '.' || att.attname as col, p.priv
       from pg_attribute att
       join pg_class c on c.oid = att.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) as p (priv)
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
        and att.attnum > 0 and not att.attisdropped
        and has_column_privilege('authenticated', c.oid, att.attnum, p.priv)
      order by 1, 2`,
  );
  const realtime = new Set(REALTIME_MESSAGE_COLUMNS.map((c) => `messages.${c}`));
  const seen = new Set<string>();
  for (const c of columns) {
    if (c.priv === 'SELECT' && realtime.has(c.col)) {
      seen.add(c.col);
      continue;
    }
    // A table-level grant shows up on every column too, and is reported above.
    if (!tables.some((t) => c.col.startsWith(`${t.table_name}.`) && t.priv === c.priv)) {
      problems.push(`${c.priv} on ${c.col}`);
    }
  }
  for (const col of realtime) {
    if (!seen.has(col) && !tables.some((t) => t.table_name === 'messages')) {
      problems.push(`Realtime needs SELECT on ${col}`);
    }
  }
  return problems;
}

async function apiRole(db: Queryable): Promise<string[]> {
  const { rows: role } = await db.query<{ login: boolean; bypass: boolean; superuser: boolean }>(
    `select rolcanlogin as login, rolbypassrls as bypass, rolsuper as superuser
       from pg_roles where rolname = 'api_member'`,
  );
  if (!role[0]) return ['api_member does not exist: apply 0033'];

  const problems: string[] = [];
  if (role[0].login) problems.push('api_member can log in');
  if (role[0].bypass) problems.push('api_member bypasses RLS');
  if (role[0].superuser) problems.push('api_member is a superuser');

  const { rows: policies } = await db.query<{ ok: boolean }>(
    `select pg_has_role('api_member', 'authenticated', 'USAGE') as ok`,
  );
  if (!policies[0]?.ok) {
    problems.push('api_member does not inherit authenticated, so no RLS policy applies to it');
  }

  // The property everything else rests on. A role that can reach api_member could
  // SET ROLE to it, and a forged `role` claim would then get the API's privileges.
  const { rows: reach } = await db.query<{ rolname: string; member: boolean }>(
    `select r.rolname, pg_has_role(r.rolname, 'api_member', 'MEMBER') as member
       from pg_roles r where r.rolname = any($1::text[])`,
    [CONNECTION_ROLES],
  );
  for (const r of reach) {
    if (r.member) problems.push(`${r.rolname} can become api_member`);
  }

  const { rows: privileges } = await db.query<{ ok: boolean }>(
    `select has_table_privilege('api_member', 'public.profiles', 'SELECT')
        and has_column_privilege('api_member', 'public.profiles', 'about_me', 'UPDATE')
        and has_column_privilege('api_member', 'public.messages', 'body', 'INSERT') as ok`,
  );
  if (!privileges[0]?.ok) problems.push('api_member lacks the privileges the API needs');
  return problems;
}

async function accessLog(db: Queryable): Promise<string[]> {
  const { rows: table } = await db.query<{ rls: boolean; forced: boolean }>(
    `select c.relrowsecurity as rls, c.relforcerowsecurity as forced
       from pg_class c where c.oid = to_regclass('public.pii_access_log')`,
  );
  if (!table[0]) return ['pii_access_log does not exist: apply 0033'];

  const problems: string[] = [];
  if (!table[0].rls || !table[0].forced) problems.push('RLS not enabled and forced');

  const { rows: reach } = await db.query<{ rolname: string; priv: string }>(
    `select r.rolname, p.priv
       from pg_roles r
       cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p (priv)
      where r.rolname in ('anon', 'authenticated', 'api_member')
        and has_table_privilege(r.rolname, 'public.pii_access_log', p.priv)`,
  );
  for (const r of reach) problems.push(`${r.rolname} holds ${r.priv}`);

  const { rows: policies } = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'pii_access_log'`,
  );
  if ((policies[0]?.n ?? 0) !== 0) problems.push('has a policy; it should have none');

  const { rows: trigger } = await db.query<{ enabled: string }>(
    `select tgenabled as enabled from pg_trigger
      where tgname = 'pii_access_log_append_only'
        and tgrelid = 'public.pii_access_log'::regclass`,
  );
  if (!trigger[0] || trigger[0].enabled === 'D') {
    problems.push('append-only trigger missing or disabled');
  }
  return problems;
}

export async function dataApiChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  for (const [name, run] of [
    [NO_DIRECT_ACCESS_CHECK, noDirectAccess],
    [API_ROLE_CHECK, apiRole],
    [ACCESS_LOG_CHECK, accessLog],
  ] as const) {
    try {
      out.push(result(name, await run(db)));
    } catch (error) {
      out.push({ name, ok: false, detail: `crashed: ${(error as Error).message}` });
    }
  }
  return out;
}
