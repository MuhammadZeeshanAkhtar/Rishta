-- =============================================================================
-- 0012 — a visibility policy must not re-read the table it guards
--
-- 0011 wrote both SELECT policies as a call to a predicate that looks the row
-- up again:
--
--   photos:   using (app.can_view_photo(app.current_user_id(), id))
--   profiles: using (app.can_view_profile(app.current_user_id(), user_id))
--
-- `app.can_view_photo` reads `public.photos`, and `app.can_view_profile` reads
-- `public.profiles`. Each therefore re-reads, from inside a table's own SELECT
-- policy, the very table that policy guards.
--
-- MEASURED CONSEQUENCE. `POST /me/photos/upload-url` runs
-- `insert into public.photos … returning id`. RETURNING makes the SELECT
-- policy run against the row the statement is writing, the predicate cannot
-- see that row, the policy evaluates false, and the insert is refused with
-- "new row violates row-level security policy". Proved by swapping only the
-- policy body on an otherwise identical database: the self-reading form fails
-- the insert, the column-reading form below succeeds. Every photo upload was
-- broken between 0011 and this migration.
--
-- This is the same family as migration 0008. Under FORCE ROW LEVEL SECURITY a
-- write has to survive its own table's SELECT policy, so any predicate in that
-- policy must be answerable from the row in hand rather than from a second
-- look at storage.
--
-- `profiles` did not fail only because its insert happens to carry no
-- RETURNING clause — a latent version of the identical bug, which is why it is
-- corrected here too rather than left to be discovered by the next person who
-- adds one.
--
-- THE SHAPE. Each rule becomes a pure, column-taking predicate that touches no
-- guarded table, with two callers:
--
--   * the table's own policy, passing the row's columns — no second read;
--   * the lookup-by-id function, for callers who hold only an id (the
--     `photo_variants` policy, and the API).
--
-- One copy of each rule, and policies that never read themselves.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app.profile_visible_to — the profile rule, over columns
--
-- Reads `users` and `blocks`. Neither is guarded by a policy that calls this,
-- so there is no cycle — but both are owner-only, so this MUST be security
-- definer: evaluated as the viewer it would find no row for the target and
-- report every stranger invisible. It still reads no table it guards, which is
-- the property that matters.
-- -----------------------------------------------------------------------------

create or replace function app.profile_visible_to(
  viewer uuid,
  owner uuid,
  review_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when viewer is null  then false
    when owner = viewer  then true
    when review_status <> 'approved' then false
    when app.is_blocked(viewer, owner) then false
    else exists (
      select 1 from public.users u
      where u.id = owner and u.status = 'active' and u.deleted_at is null
    )
  end
$$;

comment on function app.profile_visible_to(uuid, uuid, text) is
  'Profile row visibility from the row own columns, so a SELECT policy can use '
  'it without reading the table it guards.';

revoke all on function app.profile_visible_to(uuid, uuid, text) from public;
grant execute on function app.profile_visible_to(uuid, uuid, text)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- app.can_view_profile — now a lookup that delegates
--
-- Same signature and same answer as 0011; the rule simply lives in one place.
-- Still the entry point for callers holding only a pair of ids.
-- -----------------------------------------------------------------------------

create or replace function app.can_view_profile(viewer uuid, target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when viewer is null then false
    when viewer = target then true
    else coalesce(
      (
        select app.profile_visible_to(viewer, p.user_id, p.review_status)
        from public.profiles p
        where p.user_id = target and p.deleted_at is null
      ),
      false
    )
  end
$$;

-- -----------------------------------------------------------------------------
-- app.photo_visible_to — the media rule, over columns
--
-- `private` is a statement that no one else may hold the row, and an
-- unapproved photo must never reach another member; `blurred` and
-- `on_request` stay row-visible because choosing the variant is the API job.
-- -----------------------------------------------------------------------------

create or replace function app.photo_visible_to(
  viewer uuid,
  owner uuid,
  visibility text,
  moderation_status text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when viewer is null then false
    when owner = viewer then true
    when visibility = 'private' then false
    when moderation_status <> 'approved' then false
    else app.can_view_profile(viewer, owner)
  end
$$;

comment on function app.photo_visible_to(uuid, uuid, text, text) is
  'Photo row visibility from the row own columns. Owner sees every own photo; '
  'others only an approved, non-private photo on a profile they may view.';

revoke all on function app.photo_visible_to(uuid, uuid, text, text) from public;
grant execute on function app.photo_visible_to(uuid, uuid, text, text)
  to authenticated, service_role;

create or replace function app.can_view_photo(viewer uuid, photo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select app.photo_visible_to(viewer, p.user_id, p.visibility, p.moderation_status)
      from public.photos p
      where p.id = photo_id and p.deleted_at is null
    ),
    false
  )
$$;

-- =============================================================================
-- The policies, rewritten to read only the row in hand
--
-- `photo_variants` is left exactly as 0011 wrote it: it guards a DIFFERENT
-- table from the one `app.can_view_photo` reads, so it was never self-reading
-- and nothing about it needs to change.
-- =============================================================================

drop policy profiles_select_visible on public.profiles;

create policy profiles_select_visible
  on public.profiles for select to authenticated
  using (
    deleted_at is null
    and app.profile_visible_to(app.current_user_id(), user_id, review_status)
  );

drop policy photos_select_visible on public.photos;

create policy photos_select_visible
  on public.photos for select to authenticated
  using (
    deleted_at is null
    and app.photo_visible_to(app.current_user_id(), user_id, visibility, moderation_status)
  );
