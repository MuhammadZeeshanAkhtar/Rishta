-- =============================================================================
-- 0031 — code review Phase 5: cross-member photos (L3, company decision 2)
--
-- Decision 2: "secure Storage policies; only authorised viewers, approved
-- photos". This migration adds the request/grant records the ERD specifies
-- (§7 `photo_requests`, `photo_grants`) and ONE rule for which stored object a
-- viewer may read, used in two places:
--
--   - the API, to decide which variant to sign for a viewer;
--   - a Storage policy, so that signing is refused for anything else even if
--     the API, or a member calling Storage directly, asks for it.
--
-- The API still holds no Storage service credential: it signs with the
-- caller's own token, and this policy is what lets that succeed.
--
-- THE RULE, per `photos.visibility` (README A1: private by default):
--
--   public      thumb, blurred and full, to any member who may view the profile
--   blurred     the server-generated blurred file to any such member; thumb
--               and full only with a grant
--   on_request  nothing without a grant (the viewer learns only that a photo
--               exists and may be requested); thumb, blurred and full with one
--   private     nothing, ever, for anyone but the owner — a grant does not
--               reach a private photo, so setting a photo private is also how
--               an owner withdraws what a grant revealed
--
-- Always also: the photo is approved and not deleted, and the viewer may view
-- the owner's profile (`app.can_view_profile` — blocks, suspension, review
-- status, deletion). A grant is per owner and grantee (`photo_id` null = every
-- eligible photo, ERD) and lapses when revoked.
--
-- Writes to both tables are the server's (service role, documented in
-- docs/SERVICE_ROLE_USAGE.md): a request carries a free-text message that must
-- pass the contact-details filter (L9), and a grant is the owner's decision —
-- neither may be written through the Data API (review B7).
--
-- Additive: no existing table, policy or grant is changed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- photo_requests — owner on both sides (ERD §7)
-- -----------------------------------------------------------------------------

create table public.photo_requests (
  id                 uuid primary key default gen_random_uuid(),
  requester_user_id  uuid not null references public.users (id) on delete restrict,
  owner_user_id      uuid not null references public.users (id) on delete restrict,
  status             text not null default 'pending',
  message            text,
  created_at         timestamptz not null default now(),
  responded_at       timestamptz,

  constraint photo_requests_not_self check (requester_user_id <> owner_user_id),
  constraint photo_requests_status_valid
    check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  constraint photo_requests_message_len
    check (message is null or char_length(message) between 1 and 300),
  constraint photo_requests_responded_consistent check (
    (status = 'pending' and responded_at is null)
    or (status <> 'pending' and responded_at is not null)
  )
);

comment on table public.photo_requests is
  'A member asking to see another member''s photos (ERD §7). One open request '
  'per pair, which is also the anti-nagging control. Server-written.';

-- One open request at a time per pair (ERD).
create unique index photo_requests_one_pending
  on public.photo_requests (requester_user_id, owner_user_id)
  where status = 'pending';
create index photo_requests_owner_idx on public.photo_requests (owner_user_id, created_at desc);
create index photo_requests_requester_idx on public.photo_requests (requester_user_id, created_at desc);

alter table public.photo_requests enable row level security;
alter table public.photo_requests force row level security;

grant select on public.photo_requests to authenticated;
grant all on public.photo_requests to service_role;

create policy photo_requests_select_party
  on public.photo_requests for select to authenticated
  using (
    requester_user_id = app.current_user_id()
    or owner_user_id = app.current_user_id()
  );

-- -----------------------------------------------------------------------------
-- photo_grants — owner and grantee (ERD §7)
-- -----------------------------------------------------------------------------

create table public.photo_grants (
  id               uuid primary key default gen_random_uuid(),
  photo_id         uuid references public.photos (id) on delete cascade,
  owner_user_id    uuid not null references public.users (id) on delete restrict,
  grantee_user_id  uuid not null references public.users (id) on delete restrict,
  request_id       uuid references public.photo_requests (id) on delete set null,
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz,

  constraint photo_grants_not_self check (owner_user_id <> grantee_user_id),
  constraint photo_grants_revoked_after check (revoked_at is null or revoked_at >= granted_at)
);

comment on table public.photo_grants is
  'Who may see an owner''s blurred and on-request photos in full. photo_id null '
  'means every such photo (ERD §7). Never reaches a private photo. Server-written.';

-- ERD: unique(photo_id, grantee_user_id). With a nullable photo_id that needs
-- two partial indexes, and only LIVE grants are unique, so a revoked grant
-- does not block a later one.
create unique index photo_grants_one_live_all
  on public.photo_grants (owner_user_id, grantee_user_id)
  where photo_id is null and revoked_at is null;
create unique index photo_grants_one_live_photo
  on public.photo_grants (photo_id, grantee_user_id)
  where photo_id is not null and revoked_at is null;
create index photo_grants_owner_grantee_idx on public.photo_grants (owner_user_id, grantee_user_id);

alter table public.photo_grants enable row level security;
alter table public.photo_grants force row level security;

grant select on public.photo_grants to authenticated;
grant all on public.photo_grants to service_role;

create policy photo_grants_select_party
  on public.photo_grants for select to authenticated
  using (
    owner_user_id = app.current_user_id()
    or grantee_user_id = app.current_user_id()
  );

-- -----------------------------------------------------------------------------
-- The rule
-- -----------------------------------------------------------------------------

create or replace function app.has_photo_grant(viewer uuid, owner uuid, photo uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.photo_grants g
     where g.owner_user_id = owner
       and g.grantee_user_id = viewer
       and g.revoked_at is null
       and (g.photo_id is null or g.photo_id = photo)
  )
$$;

comment on function app.has_photo_grant(uuid, uuid, uuid) is
  'A live grant from owner to viewer covering this photo (or all photos).';

revoke all on function app.has_photo_grant(uuid, uuid, uuid) from public;
grant execute on function app.has_photo_grant(uuid, uuid, uuid) to authenticated, service_role;

-- `kind` is the stored object: 'thumb' | 'blurred' (photo_variants rows) or
-- 'full' (photos.storage_path, the EXIF-stripped original, review B12).
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

comment on function app.photo_variant_readable(uuid, uuid, text) is
  'L3: may viewer read this stored object of this photo? The single rule the API '
  'and the Storage policy share. See the header of migration 0031.';

revoke all on function app.photo_variant_readable(uuid, uuid, text) from public;
grant execute on function app.photo_variant_readable(uuid, uuid, text) to authenticated, service_role;

-- The same rule from a Storage object name, for the Storage policy. The name
-- is matched EXACTLY against a stored path, so a crafted name matches
-- nothing; the owner's own objects are covered by 0007's owner policy.
create or replace function app.can_read_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select app.photo_variant_readable(app.current_user_id(), p.id, 'full')
        from public.photos p
       where p.storage_path = object_name
       limit 1
    ),
    (
      select app.photo_variant_readable(app.current_user_id(), v.photo_id, v.variant)
        from public.photo_variants v
       where v.storage_path = object_name
       limit 1
    ),
    false
  )
$$;

comment on function app.can_read_photo_object(text) is
  'L3: the Storage read rule for another member''s photo object, by exact path.';

revoke all on function app.can_read_photo_object(text) from public;
grant execute on function app.can_read_photo_object(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Storage: let an authorised viewer read (and so sign) exactly those objects.
-- Guarded like 0007 and 0029: a no-op outside Supabase, verifiable only there.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'objects'
  ) then
    raise notice 'storage schema absent — skipping the L3 viewer policy (expected outside Supabase)';
    return;
  end if;

  drop policy if exists photos_bucket_select_authorised_viewer on storage.objects;
  create policy photos_bucket_select_authorised_viewer
    on storage.objects for select to authenticated
    using (bucket_id = 'photos' and app.can_read_photo_object(name));
end;
$$;
