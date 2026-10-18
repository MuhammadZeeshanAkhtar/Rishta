-- =============================================================================
-- 0007 — the private `photos` Storage bucket and its policies
--
-- Separate from 0006 because this touches the `storage` schema rather than
-- `public`. Keeping it apart means a plain Postgres without Supabase's storage
-- extension can still run every other migration — which is what lets the test
-- suite apply the real files against PGlite.
--
-- GUARDED THROUGHOUT: every statement is wrapped in a check for
-- `storage.buckets`. On Supabase it runs; on PGlite it is a no-op rather than
-- a failure, so the migration set stays identical in both.
--
-- The security model, in one line: the bucket is PRIVATE, and a member can
-- only touch objects whose first path segment is their own `users.id`.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    raise notice 'storage schema absent — skipping bucket setup (expected outside Supabase)';
    return;
  end if;

  -- --- the bucket ------------------------------------------------------------
  --
  -- public = false is the whole point. A public bucket serves every object to
  -- anyone who can guess a path, and photo leakage is risk R5 — the highest
  -- severity personal harm in this product.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'photos',
    'photos',
    false,
    10485760,                                            -- 10 MB, matching the contract
    array['image/jpeg', 'image/png', 'image/webp']
  )
  on conflict (id) do update set
    public = false,                                      -- re-asserted on every run
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  -- --- policies on storage.objects -------------------------------------------
  --
  -- Supabase enables RLS on storage.objects itself. These policies scope the
  -- `photos` bucket to its owner by path.
  --
  -- `(storage.foldername(name))[1]` is the first path segment. Our paths are
  -- `{users.id}/{photo_id}/{variant}.{ext}`, and app.current_user_id() resolves
  -- the Supabase auth id to our internal id — the same indirection every
  -- public-schema policy uses, so there is one definition of "who is asking".
  --
  -- Dropped first so re-running this migration cannot leave two generations of
  -- policy on the same table.
  drop policy if exists photos_bucket_insert_own on storage.objects;
  drop policy if exists photos_bucket_select_own on storage.objects;
  drop policy if exists photos_bucket_update_own on storage.objects;
  drop policy if exists photos_bucket_delete_own on storage.objects;

  create policy photos_bucket_insert_own
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
    );

  create policy photos_bucket_select_own
    on storage.objects for select to authenticated
    using (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
    );

  create policy photos_bucket_update_own
    on storage.objects for update to authenticated
    using (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
    )
    with check (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
    );

  create policy photos_bucket_delete_own
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'photos'
      and (storage.foldername(name))[1] = app.current_user_id()::text
    );

  -- `anon` is given nothing. It holds the publishable key, which ships inside
  -- the app and can be extracted from any APK; an anonymous caller must not be
  -- able to read, list or write a single object.

  raise notice 'photos bucket and policies configured';
end
$$;
