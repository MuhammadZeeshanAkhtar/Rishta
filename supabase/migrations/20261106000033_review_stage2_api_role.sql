-- =============================================================================
-- 0033 — Stage 2: a database role only the API can use, N3 groundwork, staff
--        photo access log. ADDITIVE: the API already serving keeps working.
--
-- THE ROOT CAUSE OF B7. The API's member session and the Supabase Data API both
-- ran as `authenticated`. Every write the API needs was therefore also open to
-- anyone holding a member JWT, who could skip whatever the route validates:
-- contact-details filters, re-review triggers aside, column shapes, rate limits.
-- A grant cannot tell the two apart, because they were the same role.
--
-- THE FIX. `api_member` is a new NOLOGIN role that inherits `authenticated`, so
-- every RLS policy, function grant and schema grant applies to it unchanged, and
-- it now holds the table privileges. PostgREST and GraphQL choose their role from
-- the JWT's `role` claim, and their connection role (`authenticator`) is not a
-- member of `api_member`, so it cannot `SET ROLE` to it even with a forged claim.
-- Only the API's own connection can.
--
-- SPLIT RELEASE, like 0026/0027:
--   0033  creates the role and COPIES the privileges. Nothing is taken away, and
--         what 0027 took is lent back (see the end of this file), so the previous
--         API (still on `authenticated`) keeps working, and can be rolled back to.
--   API   the current API runs as `api_member`, and needs this migration.
--   0034  takes the privileges away from `authenticated`.
-- `migrate --through=20261106000033` stops here. A fresh project can apply
-- everything at once, before the API starts.
--
-- If the API connects as a different database user than the one running this
-- migration, that user needs `grant api_member to <user>` as well.
--
-- ROLLBACK. `drop role` is refused while privileges remain, so
-- `drop owned by api_member` first, and only with the previous API restored.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'api_member') then
    create role api_member nologin inherit;
  end if;
end;
$$;

comment on role api_member is
  'The API acting for one member. Inherits authenticated for RLS and function '
  'grants, holds the table privileges. Must never be granted to authenticator.';

grant authenticated to api_member;
grant api_member to current_user;

-- Copied rather than listed, so this cannot drift from what 0001-0032 granted.
-- Table privileges come from relacl and column privileges from attacl, which is
-- what keeps a column-limited write column-limited.
do $$
declare
  granted record;
begin
  for granted in
    select c.oid::regclass as object_name, a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles g on g.oid = a.grantee
     where n.nspname = 'public' and c.relkind = 'r' and g.rolname = 'authenticated'
  loop
    execute format('grant %s on %s to api_member', granted.privilege_type, granted.object_name);
  end loop;

  for granted in
    select c.oid::regclass as object_name, att.attname as column_name, a.privilege_type
      from pg_attribute att
      join pg_class c on c.oid = att.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(att.attacl) a
      join pg_roles g on g.oid = a.grantee
     where n.nspname = 'public' and c.relkind = 'r' and g.rolname = 'authenticated'
       and att.attnum > 0 and not att.attisdropped
  loop
    execute format(
      'grant %s (%I) on %s to api_member',
      granted.privilege_type, granted.column_name, granted.object_name
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Storage writes follow moderation.
--
-- A member could replace the bytes of an APPROVED photo directly through the
-- Storage API with their own token, or replace `blurred.jpg` with the real image,
-- and no moderator would ever see it. Writes are now allowed only to the exact
-- objects of one of their own photos that is still pending and not yet finalized.
-- That covers the app's upload (the row exists before the URL is signed) and the
-- API's own finalize (which writes before it records any variant). Deleting one's
-- own object stays allowed, because it can only ever remove their own photo.
-- -----------------------------------------------------------------------------

create or replace function app.member_may_write_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.photos p
     where p.user_id = app.current_user_id()
       and p.deleted_at is null
       and p.moderation_status = 'pending'
       and not exists (select 1 from public.photo_variants v where v.photo_id = p.id)
       and object_name in (
         p.storage_path,
         regexp_replace(p.storage_path, '/original\.[a-z]+$', '') || '/thumb.jpg',
         regexp_replace(p.storage_path, '/original\.[a-z]+$', '') || '/blurred.jpg'
       )
  )
$$;

comment on function app.member_may_write_photo_object(text) is
  'May the caller write this exact stored object? Only for their own photo, while '
  'it is pending and before it has been finalized.';

revoke all on function app.member_may_write_photo_object(text) from public;
grant execute on function app.member_may_write_photo_object(text) to authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'objects'
  ) then
    raise notice 'storage schema absent — skipping the Storage write policies (expected outside Supabase)';
    return;
  end if;

  drop policy if exists photos_bucket_insert_own on storage.objects;
  create policy photos_bucket_insert_own
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
      and app.member_may_write_photo_object(name)
    );

  drop policy if exists photos_bucket_update_own on storage.objects;
  create policy photos_bucket_update_own
    on storage.objects for update to authenticated
    using (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
      and app.member_may_write_photo_object(name)
    )
    with check (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
      and app.member_may_write_photo_object(name)
    );
end;
$$;

-- -----------------------------------------------------------------------------
-- N3 — originals stored before review B12 still carry EXIF, including GPS.
--
-- Every photo row present when this runs is marked: nothing here can tell which
-- were stored before B12, and marking too many only costs a re-check. A marked
-- original is never served to another member. `scripts/legacy-content.ts` cleans
-- each one and clears the mark. Rows created from here on default to false,
-- because finalize strips the original before anything else happens to it.
-- The update only sets this one new column; no photo changes visibility.
-- -----------------------------------------------------------------------------

alter table public.photos
  add column original_needs_strip boolean not null default false,
  add column primary_before_requeue boolean not null default false;

update public.photos set original_needs_strip = true;

comment on column public.photos.original_needs_strip is
  'N3: the stored original may still carry EXIF. Never served to another member.';
comment on column public.photos.primary_before_requeue is
  'N3: was the main photo when re-queued for review. Restored if approved again.';

create or replace function app.photo_variant_readable(viewer uuid, photo uuid, kind text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when viewer is null then false
      when p.user_id = viewer then true
      when p.deleted_at is not null then false
      when p.moderation_status <> 'approved' then false
      when p.visibility = 'private' then false
      when kind not in ('thumb', 'blurred', 'full') then false
      when kind = 'full' and p.original_needs_strip then false
      when not app.can_view_profile(viewer, p.user_id) then false
      when p.visibility = 'public' then true
      when p.visibility = 'blurred' and kind = 'blurred' then true
      when p.visibility in ('blurred', 'on_request')
        then app.has_photo_grant(viewer, p.user_id, p.id)
      else false
    end
    from public.photos p
    where p.id = photo
  ), false)
$$;

-- -----------------------------------------------------------------------------
-- A member still in onboarding can ask for deletion.
--
-- `users_identity_complete` requires a name, gender, date of birth and country on
-- any account past onboarding, so asking for deletion before filling those in failed
-- with a 400 and no way forward. Someone who has made an account must be able to ask
-- for its deletion from any point, and `pending_deletion` hides the account anyway.
-- -----------------------------------------------------------------------------

alter table public.users drop constraint users_identity_complete;
alter table public.users add constraint users_identity_complete check (
  status in ('onboarding', 'pending_deletion')
  or (
    display_name is not null
    and gender is not null
    and date_of_birth is not null
    and country_code is not null
  )
);

-- -----------------------------------------------------------------------------
-- Staff photo access (ERD `pii_access_log`, 24-month retention).
--
-- `photos_bucket_select_moderator` (0029) let any moderator read every object in
-- the bucket through the Storage API, with no record. From 0034 a moderator can
-- read only an object the API has just logged access to, and the API logs access
-- only for photos in the moderation queue. So reading a photo without leaving a
-- row here is not possible, whichever way it is asked for.
-- -----------------------------------------------------------------------------

create table public.pii_access_log (
  id              uuid primary key default gen_random_uuid(),
  admin_user_id   uuid not null references public.admin_users (id) on delete restrict,
  subject_user_id uuid not null references public.users (id) on delete restrict,
  photo_id        uuid references public.photos (id) on delete restrict,
  fields          text[] not null,
  justification   text not null,
  accessed_at     timestamptz not null default now(),
  constraint pii_access_log_fields_present check (cardinality(fields) > 0),
  constraint pii_access_log_justification_present check (justification ~ '[^[:space:]]')
);

create index pii_access_log_subject_idx on public.pii_access_log (subject_user_id, accessed_at desc);
create index pii_access_log_admin_idx on public.pii_access_log (admin_user_id, accessed_at desc);
create index pii_access_log_open_grant_idx
  on public.pii_access_log (admin_user_id, photo_id, accessed_at desc)
  where photo_id is not null;

comment on table public.pii_access_log is
  'Who looked at which member''s private data, and why. Restricted: no member or '
  'staff role can read or change it directly.';

select app.enable_rls('public.pii_access_log');
grant all on public.pii_access_log to service_role;

-- A record of access cannot be edited. Rows leave only through retention.
create or replace function app.pii_access_log_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'pii_access_log is append-only'
    using errcode = 'check_violation';
end;
$$;

create trigger pii_access_log_append_only
  before update on public.pii_access_log
  for each row execute function app.pii_access_log_is_append_only();

create or replace function app.purge_expired_pii_access_log()
returns integer
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with purged as (
    delete from public.pii_access_log
     where accessed_at < now() - interval '24 months'
    returning 1
  )
  select count(*)::int from purged
$$;

comment on function app.purge_expired_pii_access_log() is
  'Deletes access-log rows older than 24 months (ERD retention).';

revoke all on function app.purge_expired_pii_access_log() from public;
grant execute on function app.purge_expired_pii_access_log() to service_role;

-- Exact path match, like app.can_read_photo_object. Five minutes is the lifetime
-- of the signed URL the API issues (SIGNED_URL_TTL_SECONDS).
create or replace function app.staff_photo_access_open(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.pii_access_log l
      join public.admin_users a on a.id = l.admin_user_id
      join public.photos p on p.id = l.photo_id
     where a.user_id = app.current_user_id()
       and l.accessed_at > now() - interval '5 minutes'
       and (
         p.storage_path = object_name
         or exists (
           select 1 from public.photo_variants v
            where v.photo_id = p.id and v.storage_path = object_name
         )
       )
  )
$$;

comment on function app.staff_photo_access_open(text) is
  'Has this staff member a logged, unexpired reason to read this exact object?';

revoke all on function app.staff_photo_access_open(text) from public;
grant execute on function app.staff_photo_access_open(text) to authenticated, service_role;

-- =============================================================================
-- The bridge for the release window
-- =============================================================================
-- 0027 revokes `kind`, but the API that is live today names it in every message it
-- inserts. Running that API's own tests at each migration showed this is the one thing
-- in 0026 to 0033 that stops active members working: from 0027 until the current API is
-- deployed, nobody can send a message. A release takes much longer than a migration, so
-- this lends the column back and shrinks that gap to the seconds between 0027 and here
-- in the same run. It also means the previous API can still be rolled back to, right up
-- to 0034.
--
-- This opens nothing that is not open today. It is the grant the live database already
-- has, the 0026 policy still refuses every kind but 'text', and 0034 removes it along
-- with everything else `authenticated` holds. It sits after the copy above so that
-- `api_member` never holds the column in its own right: once 0034 runs, nobody does.
grant insert (kind) on public.messages to authenticated;
