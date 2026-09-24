import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, type TestDb } from './harness.js';

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
  it('creates every Phase 1 table', async () => {
    const rows = await db.admin<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'reference_items',
      'reference_translations',
      'security_events',
      'user_auth_links',
      'user_consents',
      'user_devices',
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
    expect(rows.length).toBe(9);
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
       where t.schemaname = 'public' and t.tablename in ('user_auth_links', 'user_consents')
       group by t.tablename order by t.tablename`,
    );
    expect(rows).toEqual([
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
    await expect(
      db.admin(
        `insert into public.reference_items (type, code) values ('education_level', 'edu_bachelors')`,
      ),
    ).resolves.toBeDefined();
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
