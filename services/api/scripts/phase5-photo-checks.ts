import { normalise, type Queryable, type SecurityCheck } from './phase1-security-checks';

/**
 * The Phase 5 photo-access configuration (code review, 2026-11-05; migration
 * 0031, L3), checked against whatever database `db` reaches.
 *
 * Called by `verify-db.ts` against the live project and by
 * `test/verify-phase5-photos.test.ts` against PGlite, including databases
 * broken one way at a time. Read-only.
 *
 *   L3  photo_requests / photo_grants: RLS forced, members read only
 *   L3  the rule never reaches a private photo, and only members may ask it
 *   L3  the Storage viewer policy is present and uses the rule (Supabase only)
 */

const MEMBER_ROLES = ['anon', 'authenticated'] as const;
const TABLES = ['photo_requests', 'photo_grants'] as const;
const FUNCTIONS = [
  'app.has_photo_grant(uuid,uuid,uuid)',
  'app.photo_variant_readable(uuid,uuid,text)',
  'app.can_read_photo_object(text)',
] as const;

async function checks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  // --- tables ------------------------------------------------------------------
  {
    const label = 'L3 photo_requests and photo_grants: RLS forced, members read only';
    const problems: string[] = [];
    for (const table of TABLES) {
      const { rows } = await db.query<{ rls: boolean; forced: boolean }>(
        `select c.relrowsecurity as rls, c.relforcerowsecurity as forced
           from pg_class c where c.oid = to_regclass($1)`,
        [`public.${table}`],
      );
      const r = rows[0];
      if (!r) {
        problems.push(`${table} missing`);
        continue;
      }
      if (!r.rls || !r.forced) problems.push(`${table} RLS not enabled and forced`);
      const { rows: privs } = await db.query<{ role: string; priv: string; can: boolean }>(
        `select r as role, p as priv, has_table_privilege(r, $1, p) as can
           from unnest($2::text[]) as r, unnest(array['INSERT','UPDATE','DELETE','SELECT']) as p`,
        [`public.${table}`, MEMBER_ROLES],
      );
      for (const p of privs) {
        const allowed = p.role === 'authenticated' && p.priv === 'SELECT';
        if (p.can && !allowed) problems.push(`${p.role} holds ${p.priv} on ${table}`);
        if (!p.can && allowed) problems.push(`authenticated cannot SELECT ${table}`);
      }
    }
    out.push(
      problems.length === 0
        ? { name: label, ok: true }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- the rule ----------------------------------------------------------------
  {
    const label = 'L3 app.photo_variant_readable refuses private photos; anon cannot run the rule';
    const problems: string[] = [];
    for (const fn of FUNCTIONS) {
      const { rows } = await db.query<{ ok: boolean }>(
        `select to_regprocedure($1) is not null as ok`,
        [fn],
      );
      if (!rows[0]?.ok) {
        problems.push(`${fn} missing`);
        continue;
      }
      const { rows: anon } = await db.query<{ can: boolean }>(
        `select has_function_privilege('anon', $1, 'EXECUTE') as can`,
        [fn],
      );
      if (anon[0]?.can) problems.push(`anon may execute ${fn}`);
    }
    const { rows: body } = await db.query<{ body: string }>(
      `select p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'photo_variant_readable'`,
    );
    const text = normalise(body[0]?.body ?? '');
    for (const fragment of [
      "when p.visibility = 'private' then false",
      "when p.moderation_status <> 'approved' then false",
      'app.can_view_profile(viewer, p.user_id)',
    ]) {
      if (body[0] && !text.includes(normalise(fragment))) problems.push(`rule lost: ${fragment}`);
    }
    out.push(
      problems.length === 0
        ? { name: label, ok: true }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- Storage policy (Supabase only) -------------------------------------------
  {
    const label = 'L3 Storage policy photos_bucket_select_authorised_viewer uses the rule';
    const { rows: storage } = await db.query<{ ok: boolean }>(
      `select to_regclass('storage.objects') is not null as ok`,
    );
    if (!storage[0]?.ok) {
      out.push({
        name: label,
        ok: true,
        detail: 'no storage schema (not a Supabase database) — verify on the hosted project',
      });
    } else {
      const { rows } = await db.query<{ qual: string | null; cmd: string }>(
        `select qual, cmd from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'photos_bucket_select_authorised_viewer'`,
      );
      const r = rows[0];
      const ok =
        r !== undefined && r.cmd === 'SELECT' && (r.qual ?? '').includes('can_read_photo_object');
      out.push(
        ok
          ? { name: label, ok: true }
          : { name: label, ok: false, detail: r ? 'present but not using the rule' : 'missing' },
      );
    }
  }
}

export async function phase5PhotoChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  try {
    await checks(db, out);
  } catch (error) {
    out.push({
      name: 'Phase 5 photo checks',
      ok: false,
      detail: `crashed: ${(error as Error).message}`,
    });
  }
  return out;
}
