import { normalise, type Queryable, type SecurityCheck } from './phase1-security-checks';

/**
 * The Storage policies on the `photos` bucket, checked against what migrations
 * 0007, 0031, 0032, 0033 and 0034 define (review N4).
 *
 * `verify:db` used to compare names against the four policies from 0007, so a
 * correctly migrated project failed it, and a policy with the right name doing
 * the wrong thing would have passed. This states what each policy must BE, and
 * treats anything else that can reach this bucket as a finding.
 *
 * Policies OR together, so one stray permissive policy defeats every careful one
 * beside it. A policy scoped only to some other bucket cannot touch `photos` and
 * is left alone, because this project may legitimately hold other buckets.
 *
 * Read-only. Called by `verify-db.ts` and `test/verify-storage-policies.test.ts`.
 */

export interface StoragePolicyRow {
  policyname: string;
  permissive: string;
  roles: string[] | string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

interface ExpectedPolicy {
  /** Migration that defines it, named in failures so they can be traced. */
  migration: string;
  cmd: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  /** Fragments the USING clause must contain. Null: it must have no USING. */
  using: readonly string[] | null;
  /** Fragments the WITH CHECK clause must contain. Null: it must have none. */
  check: readonly string[] | null;
}

const IN_BUCKET = "bucket_id = 'photos'";
const OWN_FOLDER = ['(storage.foldername(name))[1]', 'app.current_user_id()'];
const OWN_OBJECT = [IN_BUCKET, ...OWN_FOLDER];
const OWN_WRITABLE_OBJECT = [...OWN_OBJECT, 'app.member_may_write_photo_object(name)'];
const REFUSES_RESTRICTED = ["bucket_id <> 'photos'", 'app.current_account_can_act()'];

export const PHOTO_BUCKET_POLICIES: Readonly<Record<string, ExpectedPolicy>> = {
  photos_bucket_insert_own: {
    migration: '0033',
    cmd: 'INSERT',
    permissive: 'PERMISSIVE',
    using: null,
    check: OWN_WRITABLE_OBJECT,
  },
  photos_bucket_select_own: {
    migration: '0007',
    cmd: 'SELECT',
    permissive: 'PERMISSIVE',
    using: OWN_OBJECT,
    check: null,
  },
  photos_bucket_update_own: {
    migration: '0033',
    cmd: 'UPDATE',
    permissive: 'PERMISSIVE',
    using: OWN_WRITABLE_OBJECT,
    check: OWN_WRITABLE_OBJECT,
  },
  photos_bucket_delete_own: {
    migration: '0007',
    cmd: 'DELETE',
    permissive: 'PERMISSIVE',
    using: OWN_OBJECT,
    check: null,
  },
  photos_bucket_select_moderator: {
    migration: '0034',
    cmd: 'SELECT',
    permissive: 'PERMISSIVE',
    using: [IN_BUCKET, 'app.is_active_moderator()', 'app.staff_photo_access_open(name)'],
    check: null,
  },
  photos_bucket_select_authorised_viewer: {
    migration: '0031',
    cmd: 'SELECT',
    permissive: 'PERMISSIVE',
    using: [IN_BUCKET, 'app.can_read_photo_object(name)'],
    check: null,
  },
  photos_bucket_refuse_restricted_account: {
    migration: '0032',
    cmd: 'ALL',
    permissive: 'RESTRICTIVE',
    using: REFUSES_RESTRICTED,
    check: REFUSES_RESTRICTED,
  },
};

/** Postgres prints `'photos'::text` and extra parentheses; compare without them. */
function canonical(clause: string | null): string {
  return normalise(clause ?? '')
    .replace(/::[a-z_]+(\[\])?/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ');
}

const holds = (clause: string | null, fragment: string): boolean =>
  canonical(clause).includes(canonical(fragment));

const rolesOf = (roles: StoragePolicyRow['roles']): string[] =>
  Array.isArray(roles) ? roles : roles.replace(/[{}]/g, '').split(',').filter(Boolean);

/** Can this policy, not on the expected list, reach the photos bucket? */
function reachesPhotos(row: StoragePolicyRow): boolean {
  const text = `${canonical(row.qual)} ${canonical(row.with_check)}`;
  if (text.includes('photos')) return true;
  // Scoped to one other bucket by equality: that bucket's business. Anything
  // else (no bucket test, `<>`, a function call in its place) must be looked at.
  const scoped = (clause: string | null): boolean =>
    clause === null || /^bucket_id = '[^']+'( and |$)/.test(canonical(clause));
  return !(scoped(row.qual) && scoped(row.with_check));
}

/** Every way the rows differ from the expected policies. Empty means correct. */
export function photoBucketPolicyProblems(rows: readonly StoragePolicyRow[]): string[] {
  const problems: string[] = [];
  const byName = new Map(rows.map((row) => [row.policyname, row]));

  for (const [name, expected] of Object.entries(PHOTO_BUCKET_POLICIES)) {
    const row = byName.get(name);
    if (!row) {
      problems.push(`missing: ${name} (migration ${expected.migration})`);
      continue;
    }
    if (row.cmd !== expected.cmd) {
      problems.push(`${name}: applies to ${row.cmd}, expected ${expected.cmd}`);
    }
    if (row.permissive !== expected.permissive) {
      problems.push(`${name}: is ${row.permissive}, expected ${expected.permissive}`);
    }
    const roles = rolesOf(row.roles);
    if (roles.length !== 1 || roles[0] !== 'authenticated') {
      problems.push(`${name}: granted to ${roles.join(', ')}, expected authenticated only`);
    }
    for (const [clause, label, wanted] of [
      [row.qual, 'USING', expected.using],
      [row.with_check, 'WITH CHECK', expected.check],
    ] as const) {
      if (wanted === null) {
        // Postgres copies USING into WITH CHECK only for display in some forms;
        // an INSERT has no USING and a SELECT or DELETE no WITH CHECK at all.
        if (clause !== null) problems.push(`${name}: has an unexpected ${label} clause`);
        continue;
      }
      for (const fragment of wanted) {
        if (!holds(clause, fragment)) problems.push(`${name}: ${label} lost "${fragment}"`);
      }
    }
  }

  for (const row of rows) {
    if (PHOTO_BUCKET_POLICIES[row.policyname]) continue;
    if (row.policyname.startsWith('photos_bucket_') || reachesPhotos(row)) {
      problems.push(
        `UNEXPECTED: ${row.policyname} (${row.permissive} ${row.cmd} to ${rolesOf(row.roles).join(', ')}) ` +
          `can reach the photos bucket`,
      );
    }
  }
  return problems;
}

export const STORAGE_POLICY_CHECK = 'photos bucket: Storage policies match migrations 0007-0034';

export async function storagePolicyChecks(db: Queryable): Promise<SecurityCheck[]> {
  try {
    const { rows: present } = await db.query<{ ok: boolean }>(
      `select to_regclass('storage.objects') is not null as ok`,
    );
    if (!present[0]?.ok) {
      return [
        {
          name: STORAGE_POLICY_CHECK,
          ok: true,
          detail: 'no storage schema (not a Supabase database) — verify on the hosted project',
        },
      ];
    }
    const { rows } = await db.query<StoragePolicyRow>(
      `select policyname, permissive, roles::text[] as roles, cmd, qual, with_check
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
        order by policyname`,
    );
    const problems = photoBucketPolicyProblems(rows);
    return [
      problems.length === 0
        ? {
            name: STORAGE_POLICY_CHECK,
            ok: true,
            detail: `${Object.keys(PHOTO_BUCKET_POLICIES).length} policies as defined`,
          }
        : { name: STORAGE_POLICY_CHECK, ok: false, detail: problems.join('; ') },
    ];
  } catch (error) {
    return [
      {
        name: STORAGE_POLICY_CHECK,
        ok: false,
        detail: `crashed: ${(error as Error).message}`,
      },
    ];
  }
}
