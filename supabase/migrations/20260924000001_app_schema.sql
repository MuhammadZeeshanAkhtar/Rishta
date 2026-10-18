-- =============================================================================
-- 0001 — app schema, extensions and shared helpers
--
-- Establishes the `app` schema for our own functions. Nothing of ours goes in
-- `public` except tables: keeping helpers separate means `public` stays the
-- data surface and `app` stays the logic surface.
-- =============================================================================

-- No extensions in Phase 1.
--
-- gen_random_uuid() has been core Postgres since 13, so pgcrypto is not needed
-- for it. PostGIS arrives with user_geo in Phase 2, pgvector with embeddings in
-- v1.2. Adding an extension before something needs it costs portability for
-- nothing — it is what stops this schema applying to a plain Postgres in CI.

create schema if not exists app;

comment on schema app is
  'NikahMate helper functions and authorization predicates. Tables live in public.';

-- Supabase creates these roles; a plain Postgres used for CI does not.
-- Guarded so this migration is identical in both.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app to anon, authenticated, service_role;

-- Supabase's platform defaults make every new table in `public` readable AND
-- writable by anon and authenticated the moment it is created, and the Data
-- API (PostgREST) exposes it: anon to anyone holding the publishable key, which
-- ships in the app; authenticated to any member holding their own JWT
-- (supabase.com/docs/guides/database/hardening-data-api). Newer projects are
-- moving to opt-in, so a given project may or may not have them.
--
-- Revoked here, before any table exists, so the schema behaves the same
-- whichever default a project has. From this point a client role reaches a
-- table only through a GRANT written in the migration that creates it — and
-- the grant tests in packages/db pin that list. Deny by default, including at
-- the privilege layer, not just in RLS.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;

-- service_role carries BYPASSRLS, which bypasses row-level security — but NOT
-- table-level privileges. Without these grants the API's dbAsService() client
-- fails with "permission denied" on every table, RLS notwithstanding. Supabase
-- sets this up by default; a plain Postgres does not, so we do it explicitly
-- and the schema behaves identically in both.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
--
-- A trigger rather than an application concern: every write path must maintain
-- it, and there are too many write paths to rely on discipline.
-- -----------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'BEFORE UPDATE trigger. Keeps updated_at honest regardless of the write path.';

-- -----------------------------------------------------------------------------
-- Deny-by-default helper
--
-- Applied to every table as it is created. RLS with zero policies is deny-all,
-- which is exactly what a `restricted` table wants (ERD §2.2).
-- -----------------------------------------------------------------------------

create or replace function app.enable_rls(target regclass)
returns void
language plpgsql
as $$
begin
  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);
end;
$$;

comment on function app.enable_rls(regclass) is
  'Enables AND forces RLS. FORCE matters: without it the table owner bypasses '
  'policies, which silently defeats every test run as the owner.';
