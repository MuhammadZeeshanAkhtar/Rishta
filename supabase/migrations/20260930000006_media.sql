-- =============================================================================
-- 0006 — photos, variants and moderation
--
-- Phase 4 of docs/ERD.md §7. Creates only what Phase 4 needs:
--
--   photos · photo_variants · media_moderation_results
--
-- DELIBERATELY ABSENT: photo_grants, photo_requests and photo_views. Those
-- belong to the request/reveal flow, which needs viewer relationships
-- (interests, matches, blocks) that do not exist yet. Creating the tables now
-- would be three unused tables and a policy set written against a permission
-- model nobody has implemented.
--
-- Nothing from Phases 1–3 is altered. This file only creates.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- photos
--
-- The row is the authorization record; the bytes live in a private Storage
-- bucket. `storage_path` is a path, never a URL — a URL in this column would
-- be a URL somebody eventually logs, shares, or renders.
-- -----------------------------------------------------------------------------

create table public.photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete restrict,

  storage_path text not null,
  content_type text not null,
  byte_size    integer,
  width        integer,
  height       integer,

  -- A1: private by default. Someone who uploads a photo and does nothing else
  -- must not thereby have published it.
  visibility   text not null default 'private',
  position     integer not null default 0,
  is_primary   boolean not null default false,

  -- Not visible to anyone until moderation passes. The server owns this
  -- column; there is no grant for it below.
  moderation_status    text not null default 'pending',
  rejection_reason_key text,
  moderated_at         timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint photos_visibility_valid
    check (visibility in ('public', 'blurred', 'on_request', 'private')),
  constraint photos_moderation_valid
    check (moderation_status in ('pending', 'approved', 'rejected')),
  constraint photos_content_type_valid
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  -- 10 MB, matching the contract's byteSize ceiling and the bucket limit.
  constraint photos_byte_size_sane
    check (byte_size is null or byte_size between 1 and 10485760),
  constraint photos_dimensions_sane
    check (
      (width is null or width between 1 and 20000)
      and (height is null or height between 1 and 20000)
    ),
  constraint photos_position_sane check (position between 0 and 50),
  -- The path always begins with the owner's id. Storage policies enforce the
  -- same thing from the other side; agreeing here makes a mismatch impossible
  -- to write in the first place.
  constraint photos_storage_path_owned
    check (storage_path like (user_id::text || '/%'))
);

comment on table public.photos is
  'Photo records. Bytes live in the private `photos` Storage bucket.';
comment on column public.photos.storage_path is
  'Object path inside the private bucket. NEVER a URL.';
comment on column public.photos.visibility is
  'A1 — private by default. blurred serves a SEPARATE pre-blurred file.';
comment on column public.photos.moderation_status is
  'Not visible to anyone until approved. Owner has no grant on this column.';

create index photos_user_position_idx
  on public.photos (user_id, position)
  where deleted_at is null;

-- The moderation queue.
create index photos_moderation_queue_idx
  on public.photos (moderation_status, created_at)
  where moderation_status = 'pending' and deleted_at is null;

-- At most one primary photo per person. A partial unique index rather than a
-- trigger: the database simply cannot hold two.
create unique index photos_one_primary_per_user
  on public.photos (user_id)
  where is_primary and deleted_at is null;

create trigger photos_touch
  before update on public.photos
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- photo_variants
--
-- The blurred variant is a SEPARATE STORED FILE, generated server-side at
-- upload. A client-side blur would mean the real image already reached the
-- device, which makes the privacy control decorative (ERD §7).
-- -----------------------------------------------------------------------------

create table public.photo_variants (
  id           uuid primary key default gen_random_uuid(),
  photo_id     uuid not null references public.photos (id) on delete cascade,
  variant      text not null,
  storage_path text not null,
  width        integer,
  height       integer,
  byte_size    integer,
  created_at   timestamptz not null default now(),

  constraint photo_variants_variant_valid check (variant in ('thumb', 'blurred', 'full')),
  constraint photo_variants_photo_variant_key unique (photo_id, variant)
);

-- `on delete cascade` is deliberate and is the second place it appears: a
-- variant has no meaning without its parent photo, and the parent is
-- soft-deleted, so a hard delete here only ever follows a real purge.
comment on table public.photo_variants is
  'Server-generated derivatives. The blurred file is stored, not computed client-side.';

create index photo_variants_photo_idx on public.photo_variants (photo_id);

-- -----------------------------------------------------------------------------
-- media_moderation_results — restricted
-- -----------------------------------------------------------------------------

create table public.media_moderation_results (
  id                   uuid primary key default gen_random_uuid(),
  photo_id             uuid not null references public.photos (id) on delete cascade,
  provider             text not null,
  verdict              text not null,
  labels               jsonb not null default '{}'::jsonb,
  reviewed_by_admin_id uuid,
  reviewed_at          timestamptz,
  created_at           timestamptz not null default now(),

  constraint media_moderation_verdict_valid
    check (verdict in ('approved', 'rejected', 'review'))
);

comment on table public.media_moderation_results is
  'Automated and human moderation outcomes. RESTRICTED: zero policies.';

create index media_moderation_photo_idx on public.media_moderation_results (photo_id);

-- =============================================================================
-- RLS
--
-- OWNER-ONLY, for the same reason profiles is: cross-user reads need
-- app.can_view_profile(), which needs blocks and matches (Phase 5/6). A
-- permissive policy now would expose every photo the moment a second member
-- exists. Photos are the highest-severity leak in this product (R5), so this
-- is the one place to be most conservative.
-- =============================================================================

select app.enable_rls('public.photos');
select app.enable_rls('public.photo_variants');
select app.enable_rls('public.media_moderation_results');

grant all on public.photos to service_role;
grant all on public.photo_variants to service_role;
grant all on public.media_moderation_results to service_role;

-- --- photos: owner ------------------------------------------------------------

grant select on public.photos to authenticated;

-- Column-level. moderation_status, rejection_reason_key and moderated_at are
-- absent: a member who could approve their own photo would bypass moderation
-- entirely, which is the whole control.
grant insert (user_id, storage_path, content_type, byte_size, width, height, visibility, position)
  on public.photos to authenticated;
grant update (visibility, position, is_primary, deleted_at)
  on public.photos to authenticated;

create policy photos_select_own
  on public.photos for select to authenticated
  using (user_id = app.current_user_id() and deleted_at is null);

create policy photos_insert_own
  on public.photos for insert to authenticated
  with check (user_id = app.current_user_id());

create policy photos_update_own
  on public.photos for update to authenticated
  using (user_id = app.current_user_id() and deleted_at is null)
  with check (user_id = app.current_user_id());

-- Soft delete only, through the update grant on deleted_at. A hard DELETE
-- would orphan objects in the bucket with nothing left pointing at them.
-- No delete policy exists.

-- --- photo_variants: follows the parent ---------------------------------------

grant select on public.photo_variants to authenticated;

create policy photo_variants_select_own
  on public.photo_variants for select to authenticated
  using (
    exists (
      select 1 from public.photos p
      where p.id = photo_variants.photo_id
        and p.user_id = app.current_user_id()
        and p.deleted_at is null
    )
  );

-- No insert or update grant for members: variants are produced by the server
-- during finalize. A member who could write a variant row could point the
-- `blurred` variant at the unblurred original.

-- --- media_moderation_results: restricted, ZERO policies -----------------------
--
-- No grant, no policy. A member learning why their photo was rejected learns
-- it through rejection_reason_key on the photo, not by reading the provider's
-- labels about their own image.
