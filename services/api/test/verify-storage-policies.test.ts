import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../scripts/phase1-security-checks';
import {
  PHOTO_BUCKET_POLICIES,
  photoBucketPolicyProblems,
  storagePolicyChecks,
  type StoragePolicyRow,
} from '../scripts/storage-policy-checks';
import { grantStorageStandIn, seedStorageStandIn } from './helpers';

/**
 * Review N4: `verify:db` must accept a correctly migrated project, and refuse a
 * wrong one. The Storage migrations are guarded so they run only where a
 * `storage` schema exists, which is why nothing here exercised them before. This
 * gives PGlite a minimal stand-in for Supabase's `storage` tables so the real
 * migration files run and the real policies come out of `pg_policies`. The
 * stand-in is a table and a helper, not a copy of any policy.
 */

let pg: PGlite;

const queryable = (db: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params as never[]),
});

const readPolicies = async (): Promise<StoragePolicyRow[]> =>
  (
    await pg.query<StoragePolicyRow>(
      `select policyname, permissive, roles::text[] as roles, cmd, qual, with_check
         from pg_policies where schemaname = 'storage' and tablename = 'objects'`,
    )
  ).rows;

const check = async () => {
  const results = await storagePolicyChecks(queryable(pg));
  expect(results).toHaveLength(1);
  return results[0]!;
};

/** Runs `change`, asserts what the check says, and puts the database back. */
async function whileBroken(change: string, expected: RegExp): Promise<void> {
  await pg.exec('begin');
  try {
    await pg.exec(change);
    const result = await check();
    expect(result.ok, `should have failed after: ${change}`).toBe(false);
    expect(result.detail).toMatch(expected);
  } finally {
    await pg.exec('rollback');
  }
}

beforeAll(async () => {
  pg = new PGlite();
  await seedStorageStandIn(pg);
  await applyMigrations(pg);
  await grantStorageStandIn(pg);
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

describe('against the real migrations', () => {
  it('passes a correctly migrated project', async () => {
    const result = await check();
    expect(result.detail).not.toMatch(/UNEXPECTED|missing|lost/);
    expect(result.ok).toBe(true);
  });

  it('the inventory is exactly what 0007, 0029, 0031 and 0032 create', async () => {
    const names = (await readPolicies()).map((r) => r.policyname).sort();
    expect(names).toEqual(Object.keys(PHOTO_BUCKET_POLICIES).sort());
    expect(names).toContain('photos_bucket_select_moderator');
    expect(names).toContain('photos_bucket_select_authorised_viewer');
  });

  it('would have failed the old check: more than the four policies from 0007 exist', async () => {
    const oldList = [
      'photos_bucket_delete_own',
      'photos_bucket_insert_own',
      'photos_bucket_select_own',
      'photos_bucket_update_own',
    ];
    const extra = (await readPolicies()).filter((r) => !oldList.includes(r.policyname));
    expect(extra.length).toBeGreaterThan(0);
  });
});

describe('a missing policy fails', () => {
  it.each(Object.keys(PHOTO_BUCKET_POLICIES))('%s', async (name) => {
    await whileBroken(`drop policy ${name} on storage.objects`, new RegExp(`missing: ${name}`));
  });
});

describe('an unexpected policy fails', () => {
  it.each([
    [
      'open to everyone in the bucket',
      `create policy sneaky on storage.objects for select to authenticated using (bucket_id = 'photos')`,
    ],
    [
      'with no bucket test at all',
      `create policy sneaky on storage.objects for select to authenticated using (true)`,
    ],
    [
      'for anon',
      `create policy sneaky on storage.objects for select to anon using (bucket_id = 'photos')`,
    ],
    [
      'named like another bucket but not limited to it',
      `create policy sneaky on storage.objects for select to authenticated using (bucket_id = 'avatars' or true)`,
    ],
    [
      'excluding one bucket, which includes this one',
      `create policy sneaky on storage.objects for select to authenticated using (bucket_id <> 'avatars')`,
    ],
  ])('%s', async (_label, sql) => {
    await whileBroken(sql, /UNEXPECTED: sneaky/);
  });

  it('with our prefix, whatever it says', async () => {
    await whileBroken(
      `create policy photos_bucket_extra on storage.objects for select to authenticated using (bucket_id = 'avatars')`,
      /UNEXPECTED: photos_bucket_extra/,
    );
  });

  it('a policy limited to some other bucket is that bucket’s business', async () => {
    await pg.exec('begin');
    try {
      await pg.exec(
        `create policy avatars_read on storage.objects for select to authenticated using (bucket_id = 'avatars')`,
      );
      expect((await check()).ok).toBe(true);
    } finally {
      await pg.exec('rollback');
    }
  });
});

describe('a right-named policy doing the wrong thing fails', () => {
  const replace = (name: string, definition: string) =>
    `drop policy ${name} on storage.objects; create policy ${name} on storage.objects ${definition}`;

  it.each([
    [
      'owner read open to the whole bucket',
      replace(
        'photos_bucket_select_own',
        `for select to authenticated using (bucket_id = 'photos')`,
      ),
      /select_own: USING lost/,
    ],
    [
      'owner read on the wrong bucket',
      replace(
        'photos_bucket_select_own',
        `for select to authenticated using (bucket_id = 'other' and (storage.foldername(name))[1] = app.current_user_id()::text)`,
      ),
      /select_own: USING lost/,
    ],
    [
      'upload into any folder',
      replace(
        'photos_bucket_insert_own',
        `for insert to authenticated with check (bucket_id = 'photos')`,
      ),
      /insert_own: WITH CHECK lost/,
    ],
    [
      'replace an object and move it out of your folder',
      replace(
        'photos_bucket_update_own',
        `for update to authenticated
           using (bucket_id = 'photos' and (storage.foldername(name))[1] = app.current_user_id()::text)
           with check (bucket_id = 'photos')`,
      ),
      /update_own: WITH CHECK lost/,
    ],
    [
      'moderator read with no moderator test',
      replace(
        'photos_bucket_select_moderator',
        `for select to authenticated using (bucket_id = 'photos')`,
      ),
      /select_moderator: USING lost/,
    ],
    [
      'moderator read of the whole bucket, as 0029 had it',
      replace(
        'photos_bucket_select_moderator',
        `for select to authenticated using (bucket_id = 'photos' and app.is_active_moderator())`,
      ),
      /select_moderator: USING lost "app.staff_photo_access_open/,
    ],
    [
      'writes no longer limited to a photo awaiting finalize',
      replace(
        'photos_bucket_insert_own',
        `for insert to authenticated with check (
           bucket_id = 'photos' and (storage.foldername(name))[1] = app.current_user_id()::text)`,
      ),
      /insert_own: WITH CHECK lost "app.member_may_write_photo_object/,
    ],
    [
      'viewer read that does not use the rule',
      replace(
        'photos_bucket_select_authorised_viewer',
        `for select to authenticated using (bucket_id = 'photos' and true)`,
      ),
      /select_authorised_viewer: USING lost/,
    ],
    [
      'viewer read offered to anon',
      replace(
        'photos_bucket_select_authorised_viewer',
        `for select to anon using (bucket_id = 'photos' and app.can_read_photo_object(name))`,
      ),
      /granted to anon/,
    ],
    [
      'restricted-account policy made permissive, which opens instead of refuses',
      replace(
        'photos_bucket_refuse_restricted_account',
        `as permissive for all to authenticated
           using (bucket_id <> 'photos' or (select app.current_account_can_act()))
           with check (bucket_id <> 'photos' or (select app.current_account_can_act()))`,
      ),
      /refuse_restricted_account: is PERMISSIVE/,
    ],
    [
      'restricted-account policy that no longer checks the account',
      replace(
        'photos_bucket_refuse_restricted_account',
        `as restrictive for all to authenticated using (bucket_id <> 'photos' or true) with check (bucket_id <> 'photos' or true)`,
      ),
      /refuse_restricted_account: USING lost/,
    ],
    [
      'restricted-account policy limited to reads',
      replace(
        'photos_bucket_refuse_restricted_account',
        `as restrictive for select to authenticated
           using (bucket_id <> 'photos' or (select app.current_account_can_act()))`,
      ),
      /refuse_restricted_account: applies to SELECT/,
    ],
    [
      'delete policy turned into a read',
      replace(
        'photos_bucket_delete_own',
        `for select to authenticated using (bucket_id = 'photos' and (storage.foldername(name))[1] = app.current_user_id()::text)`,
      ),
      /delete_own: applies to SELECT/,
    ],
  ])('%s', async (_label, sql, expected) => {
    await whileBroken(sql, expected);
  });
});

describe('outside Supabase', () => {
  it('says it must be verified on the hosted project rather than passing silently', async () => {
    const plain = new PGlite();
    try {
      await applyMigrations(plain, { through: '20260924000001' });
      const results = await storagePolicyChecks(queryable(plain));
      expect(results[0]!.ok).toBe(true);
      expect(results[0]!.detail).toMatch(/verify on the hosted project/);
    } finally {
      await plain.close();
    }
  }, 60_000);
});

describe('the pure comparison', () => {
  it('reports an empty table as every policy missing', () => {
    const problems = photoBucketPolicyProblems([]);
    expect(problems).toHaveLength(Object.keys(PHOTO_BUCKET_POLICIES).length);
    expect(problems.every((p) => p.startsWith('missing: '))).toBe(true);
  });

  it('accepts the roles column in either form Postgres drivers return it', () => {
    const row = (roles: StoragePolicyRow['roles']): StoragePolicyRow => ({
      policyname: 'photos_bucket_select_moderator',
      permissive: 'PERMISSIVE',
      roles,
      cmd: 'SELECT',
      qual: `((bucket_id = 'photos'::text) AND app.is_active_moderator() AND app.staff_photo_access_open(name))`,
      with_check: null,
    });
    const mention = (problems: string[]) => problems.filter((p) => p.includes('select_moderator'));
    expect(mention(photoBucketPolicyProblems([row(['authenticated'])]))).toEqual([]);
    expect(mention(photoBucketPolicyProblems([row('{authenticated}')]))).toEqual([]);
  });
});

describe('the policies behave as the inventory says (real Postgres, real RLS)', () => {
  let member: { id: string; auth: string };
  let stranger: { id: string; auth: string };
  let path: string;

  const seed = async (name: string) => {
    const auth = crypto.randomUUID();
    const users = await pg.query<{ id: string }>(
      `insert into public.users (display_name, gender, date_of_birth, country_code, status)
       values ($1, 'female', date '1995-06-15', 'pk', 'active') returning id`,
      [name],
    );
    const id = users.rows[0]!.id;
    await pg.query(
      `insert into public.user_auth_links (user_id, auth_user_id, provider) values ($1::uuid, $2::uuid, 'email')`,
      [id, auth],
    );
    await pg.query(
      `insert into public.profiles (user_id, about_me, review_status, submitted_at, marital_status_code, religious_practice_code)
       values ($1::uuid, 'A sufficiently long about-me for this member.', 'approved', now(), 'ms_never_married', 'rel_practising')`,
      [id],
    );
    return { id, auth };
  };

  const asMember = async <T>(who: { auth: string }, sql: string, params: unknown[] = []) => {
    await pg.exec('begin');
    try {
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: who.auth, role: 'authenticated' }),
      ]);
      await pg.exec('set local role authenticated');
      return (await pg.query<T>(sql, params as never[])).rows;
    } finally {
      await pg.exec('rollback');
    }
  };

  beforeAll(async () => {
    await pg.exec(`
      insert into public.reference_items (type, code) values
        ('marital_status', 'ms_never_married'), ('religious_practice', 'rel_practising')
      on conflict (type, code) do nothing
    `);
    member = await seed('Member');
    stranger = await seed('Stranger');
    path = `${member.id}/f/original.jpg`;
    await pg.query(
      `insert into public.photos (user_id, storage_path, content_type, visibility, moderation_status)
       values ($1::uuid, $2, 'image/jpeg', 'public', 'approved')`,
      [member.id, path],
    );
    await pg.query(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [path]);
  });

  const setStatus = (id: string, status: string) =>
    pg.query(`update public.users set status = $2 where id = $1::uuid`, [id, status]);

  it('owner and authorised viewer read; a restricted account of either kind does not', async () => {
    const read = (who: { auth: string }) =>
      asMember(who, `select name from storage.objects where name = $1`, [path]);

    expect(await read(member)).toHaveLength(1);
    expect(await read(stranger)).toHaveLength(1);

    await setStatus(stranger.id, 'suspended');
    expect(await read(stranger)).toEqual([]);
    await setStatus(stranger.id, 'active');

    await setStatus(member.id, 'banned');
    expect(await read(member)).toEqual([]);
    await setStatus(member.id, 'active');
  });

  it('a restricted owner cannot upload or remove', async () => {
    const object = `${member.id}/new/original.jpg`;
    await pg.query(
      `insert into public.photos (user_id, storage_path, content_type) values ($1::uuid, $2, 'image/jpeg')`,
      [member.id, object],
    );
    const upload = (who: { auth: string; id: string }) =>
      asMember(
        who,
        `insert into storage.objects (bucket_id, name) values ('photos', $1) returning name`,
        [object],
      );

    expect(await upload(member)).toHaveLength(1);
    await setStatus(member.id, 'deactivated');
    await expect(upload(member)).rejects.toThrow(/row-level security/);
    expect(
      await asMember(member, `delete from storage.objects where name = $1 returning name`, [path]),
    ).toEqual([]);
    await setStatus(member.id, 'active');
  });

  describe('Storage writes follow moderation', () => {
    const put = (who: { auth: string }, name: string) =>
      asMember(
        who,
        `insert into storage.objects (bucket_id, name) values ('photos', $1) returning name`,
        [name],
      );
    const replace = (who: { auth: string }, name: string) =>
      asMember(who, `update storage.objects set owner = null where name = $1 returning name`, [
        name,
      ]);

    const newPhoto = async (owner: { id: string }, folder: string, status = 'pending') => {
      const name = `${owner.id}/${folder}/original.jpg`;
      const photo = await pg.query<{ id: string }>(
        `insert into public.photos (user_id, storage_path, content_type, moderation_status)
         values ($1::uuid, $2, 'image/jpeg', $3) returning id`,
        [owner.id, name, status],
      );
      await pg.query(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [name]);
      return { id: photo.rows[0]!.id, name, base: `${owner.id}/${folder}` };
    };

    it('the app can upload, and finalize can write, while the photo awaits finalize', async () => {
      const p = await newPhoto(member, 'w1');
      expect(await replace(member, p.name)).toHaveLength(1);
      expect(await put(member, `${p.base}/thumb.jpg`)).toHaveLength(1);
      expect(await put(member, `${p.base}/blurred.jpg`)).toHaveLength(1);
    });

    it('after finalize nothing can be swapped, including the blurred copy no moderator sees', async () => {
      const p = await newPhoto(member, 'w2');
      await pg.query(
        `insert into public.photo_variants (photo_id, variant, storage_path)
         values ($1::uuid, 'blurred', $2)`,
        [p.id, `${p.base}/blurred.jpg`],
      );
      await pg.query(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [
        `${p.base}/blurred.jpg`,
      ]);
      expect(await replace(member, p.name)).toEqual([]);
      expect(await replace(member, `${p.base}/blurred.jpg`)).toEqual([]);
      await expect(put(member, `${p.base}/thumb.jpg`)).rejects.toThrow(/row-level security/);
    });

    it.each(['approved', 'rejected'])('a %s photo cannot be replaced', async (status) => {
      const p = await newPhoto(member, `w-${status}`, status);
      expect(await replace(member, p.name)).toEqual([]);
      await expect(put(member, `${p.base}/thumb.jpg`)).rejects.toThrow(/row-level security/);
    });

    it('nothing can be stored without a photo row, or under any other name', async () => {
      const p = await newPhoto(member, 'w3');
      await expect(put(member, `${member.id}/no-row/original.jpg`)).rejects.toThrow(
        /row-level security/,
      );
      await expect(put(member, `${p.base}/extra.jpg`)).rejects.toThrow(/row-level security/);
    });

    it('a member can still delete their own photo object', async () => {
      const p = await newPhoto(member, 'w4', 'approved');
      const gone = await asMember(
        member,
        `delete from storage.objects where name = $1 returning name`,
        [p.name],
      );
      expect(gone).toHaveLength(1);
    });
  });

  it('nobody writes into someone else’s folder', async () => {
    await expect(
      asMember(stranger, `insert into storage.objects (bucket_id, name) values ('photos', $1)`, [
        `${member.id}/evil/original.jpg`,
      ]),
    ).rejects.toThrow(/row-level security/);
  });
});
