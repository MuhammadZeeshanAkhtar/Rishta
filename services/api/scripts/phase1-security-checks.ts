/**
 * The Phase 1 security configuration (code review, 2026-10-28), checked
 * against whatever database `db` reaches.
 *
 * Called by `verify-db.ts` against the live project, and by
 * `test/verify-phase1-security.test.ts` against PGlite — including databases
 * deliberately broken in each way below, so a check that cannot fail is
 * caught. Read-only: nothing here writes.
 *
 * Every check asks the catalog what IS there, rather than trusting that a
 * migration ran. A trigger that exists but is disabled, fires at the wrong
 * time, watches the wrong column, or calls a function whose body no longer
 * refuses anything, fails the same as a trigger that is missing.
 *
 *   B1  matches_guard_family_approval       migration 0026
 *   B3  user_settings_guard_incognito       migration 0026
 *   B7  messages insert policy + non-blank  migration 0026
 *   B7  no member INSERT on interests       migration 0026
 *   B7  no member INSERT on messages.kind   migration 0027
 */

export interface SecurityCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The slice of `pg.Client` / PGlite this needs. */
export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Member-facing roles. `anon` holds the key shipped inside the app. */
const MEMBER_ROLES = ['anon', 'authenticated'] as const;

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h). AFTER is the
// absence of BEFORE.
export const ROW = 1;
export const BEFORE = 2;
export const INSERT = 4;
export const UPDATE = 16;

export interface ExpectedTrigger {
  finding: string;
  name: string;
  table: string;
  /** Exact tgtype: timing, level and events together. */
  tgtype: number;
  timing: string;
  /** The `UPDATE OF` column list, exactly. */
  columns: string[];
  fn: string;
  /**
   * Fragments the function body must still contain. Catches a guard whose
   * body was replaced by `return new;` — present, enabled, and useless.
   */
  bodyMustContain: string[];
}

const TRIGGERS: ExpectedTrigger[] = [
  {
    finding: 'B1',
    name: 'matches_guard_family_approval',
    table: 'public.matches',
    tgtype: ROW | BEFORE | UPDATE,
    timing: 'BEFORE UPDATE OF communication_state, FOR EACH ROW',
    columns: ['communication_state'],
    fn: 'app.guard_family_approval',
    bodyMustContain: ['family_reviews', "decision <> 'approved'", 'raise exception'],
  },
  {
    finding: 'B3',
    name: 'user_settings_guard_incognito',
    table: 'public.user_settings',
    tgtype: ROW | BEFORE | INSERT | UPDATE,
    timing: 'BEFORE INSERT OR UPDATE OF incognito, FOR EACH ROW',
    columns: ['incognito'],
    fn: 'app.guard_incognito_entitlement',
    bodyMustContain: ["has_entitlement_flag(new.user_id, 'incognito')", 'raise exception'],
  },
];

/** Lower-cased, whitespace collapsed — so formatting never decides a check. */
export const normalise = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

async function triggerChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  await checkTriggers(db, out, TRIGGERS);
}

/**
 * Checks each expected trigger against the catalog: present on its table,
 * enabled, firing at the exact timing/level/events, watching exactly its
 * columns, calling its function, and that function's body still containing
 * the fragments that make it do its job. Shared with the Phase 2 checks.
 */
export async function checkTriggers(
  db: Queryable,
  out: SecurityCheck[],
  triggers: readonly ExpectedTrigger[],
): Promise<void> {
  const { rows } = await db.query<{
    name: string;
    tbl: string;
    enabled: string;
    tgtype: number;
    fn: string;
    body: string;
    columns: string[] | null;
  }>(
    `select t.tgname as name,
            n.nspname || '.' || c.relname as tbl,
            t.tgenabled::text as enabled,
            t.tgtype::int as tgtype,
            pn.nspname || '.' || p.proname as fn,
            p.prosrc as body,
            array(select a.attname::text
                    from unnest(t.tgattr::int2[]) as k(attnum)
                    join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum
                   order by 1) as columns
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       join pg_namespace pn on pn.oid = p.pronamespace
      where not t.tgisinternal and t.tgname = any($1::text[])`,
    [triggers.map((t) => t.name)],
  );

  for (const want of triggers) {
    const label = `${want.finding} trigger ${want.name}`;
    const found = rows.filter((r) => r.name === want.name && r.tbl === want.table);
    const row = found[0];
    if (!row) {
      out.push({ name: label, ok: false, detail: `missing on ${want.table}` });
      continue;
    }
    const problems: string[] = [];
    // 'O' fires normally, 'A' always. 'D' is disabled; 'R' fires only on a
    // replica, which is never where members write.
    if (row.enabled !== 'O' && row.enabled !== 'A') {
      problems.push(`not enabled (tgenabled=${row.enabled})`);
    }
    if (row.tgtype !== want.tgtype) {
      problems.push(`fires wrongly (tgtype=${row.tgtype}, want ${want.timing})`);
    }
    const columns = row.columns ?? [];
    if (columns.join(',') !== want.columns.join(',')) {
      problems.push(`watches [${columns.join(', ')}], want [${want.columns.join(', ')}]`);
    }
    if (row.fn !== want.fn) {
      problems.push(`calls ${row.fn}, want ${want.fn}`);
    }
    const body = normalise(row.body);
    const lost = want.bodyMustContain.filter((frag) => !body.includes(normalise(frag)));
    if (lost.length > 0) {
      problems.push(`${want.fn}() no longer contains: ${lost.join(' | ')}`);
    }
    if (problems.length === 0) {
      out.push({ name: label, ok: true, detail: `${want.timing} -> ${want.fn}()` });
    } else {
      out.push({ name: label, ok: false, detail: problems.join('; ') });
    }
  }
}

async function messageChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  // --- messages.kind: no member can name it (0027) --------------------------
  // has_column_privilege also answers true for a TABLE-level INSERT and for a
  // grant to PUBLIC, so a broader grant cannot hide behind the column list.
  const { rows: kind } = await db.query<{ role: string; can: boolean }>(
    `select r as role, has_column_privilege(r, 'public.messages', 'kind', 'INSERT') as can
       from unnest($1::text[]) as r`,
    [MEMBER_ROLES],
  );
  const kindOpen = kind.filter((r) => r.can).map((r) => r.role);
  out.push(
    kindOpen.length === 0
      ? {
          name: 'B7 no member INSERT on messages.kind',
          ok: true,
          detail: 'a member insert takes the default, text',
        }
      : {
          name: 'B7 no member INSERT on messages.kind',
          ok: false,
          detail: `INSERT on kind held by: ${kindOpen.join(', ')} — apply 0027 (after the Phase 1 API is live)`,
        },
  );

  // --- ...without breaking the send ----------------------------------------
  // The other direction: a revoke that went too far would stop members
  // sending at all. These three are exactly what the API's insert names.
  const sendColumns = ['conversation_id', 'sender_user_id', 'body'];
  const { rows: send } = await db.query<{ col: string; can: boolean }>(
    `select col, has_column_privilege('authenticated', 'public.messages', col, 'INSERT') as can
       from unnest($1::text[]) as col`,
    [sendColumns],
  );
  const sendLost = send.filter((r) => !r.can).map((r) => r.col);
  out.push(
    sendLost.length === 0
      ? {
          name: 'B7 members can still insert a message',
          ok: true,
          detail: sendColumns.join(', '),
        }
      : {
          name: 'B7 members can still insert a message',
          ok: false,
          detail: `authenticated lacks INSERT on: ${sendLost.join(', ')} — every send will fail`,
        },
  );

  // --- the insert policy pins kind and body (0026) --------------------------
  // Policies are OR-ed: a second permissive INSERT policy would let through
  // whatever this one refuses. So the policy must be the ONLY one.
  const { rows: policies } = await db.query<{
    policyname: string;
    with_check: string | null;
  }>(
    `select policyname, with_check
       from pg_policies
      where schemaname = 'public' and tablename = 'messages'
        and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL')
        and roles && array['authenticated', 'anon', 'public']::name[]
      order by policyname`,
  );
  const policyProblems: string[] = [];
  const names = policies.map((p) => p.policyname);
  if (names.join(',') !== 'messages_insert_when_permitted') {
    policyProblems.push(
      `permissive insert policies are [${names.join(', ')}], want only messages_insert_when_permitted`,
    );
  }
  const insertPolicy = policies.find((p) => p.policyname === 'messages_insert_when_permitted');
  const check = normalise(insertPolicy?.with_check ?? '');
  for (const frag of ["kind = 'text'", "body ~ '[^[:space:]]'", 'can_write_message']) {
    if (insertPolicy && !check.includes(frag)) policyProblems.push(`check lacks ${frag}`);
  }
  out.push(
    policyProblems.length === 0
      ? {
          name: 'B7 message insert policy pins text and a non-blank body',
          ok: true,
          detail: 'messages_insert_when_permitted is the only permissive insert policy',
        }
      : {
          name: 'B7 message insert policy pins text and a non-blank body',
          ok: false,
          detail: policyProblems.join('; '),
        },
  );

  // --- non-blank for every role (0026) --------------------------------------
  const { rows: cons } = await db.query<{ validated: boolean; def: string }>(
    `select c.convalidated as validated, pg_get_constraintdef(c.oid) as def
       from pg_constraint c
      where c.conrelid = 'public.messages'::regclass
        and c.conname = 'messages_body_not_blank' and c.contype = 'c'`,
  );
  const con = cons[0];
  let conProblem: string | null = null;
  if (!con) conProblem = 'missing';
  else if (!con.validated) conProblem = 'NOT VALID — existing rows were never checked';
  else if (!normalise(con.def).includes('[^[:space:]]')) conProblem = `wrong rule: ${con.def}`;
  out.push(
    conProblem === null
      ? { name: 'B7 messages_body_not_blank', ok: true, detail: 'applies to every role' }
      : { name: 'B7 messages_body_not_blank', ok: false, detail: conProblem },
  );
}

async function interestChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  // has_any_column_privilege covers a table-level grant, a grant on any single
  // column, and a grant to PUBLIC. Any of them reopens quota-free interests.
  const { rows } = await db.query<{ role: string; can: boolean }>(
    `select r as role, has_any_column_privilege(r, 'public.interests', 'INSERT') as can
       from unnest($1::text[]) as r`,
    [MEMBER_ROLES],
  );
  const open = rows.filter((r) => r.can).map((r) => r.role);
  out.push(
    open.length === 0
      ? {
          name: 'B7 no member INSERT on interests',
          ok: true,
          detail: 'sending goes through the API, which consumes the quota',
        }
      : {
          name: 'B7 no member INSERT on interests',
          ok: false,
          detail: `INSERT on interests held by: ${open.join(', ')} — quota can be bypassed`,
        },
  );
}

/**
 * Runs every Phase 1 check. A section that crashes is reported as a failed
 * check rather than thrown, so the others still report.
 */
export async function phase1SecurityChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  const sections: Array<[string, (d: Queryable, o: SecurityCheck[]) => Promise<void>]> = [
    ['Phase 1 trigger checks', triggerChecks],
    ['Phase 1 message checks', messageChecks],
    ['Phase 1 interest checks', interestChecks],
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
