-- =============================================================================
-- 0034 — Stage 2 cutover. Apply only once the API running as `api_member` is live.
--
-- Applied before that API is serving, member reads and writes through the API
-- fail, and moderators see no queued photos. See 0033 for the reasoning.
--
-- WHAT `authenticated` KEEPS. The Supabase Data API and GraphQL use this role, so
-- from here they can read and write nothing in `public`, whether or not the
-- Dashboard still exposes the schema. Storage policies keep working: they call
-- `app.*` security-definer functions, whose grants are untouched.
--
-- The one exception is Realtime, which the app uses to learn that a chat has a new
-- message (`subscribeToMessages`). It checks the subscriber's own SELECT rights,
-- so `authenticated` keeps exactly what that needs: the primary key, the column
-- the subscription filters on, and the timestamp. The app ignores the payload and
-- re-reads through the API. Bodies are not included, because
-- `messages_select_member` filters on membership only, and a direct read returned
-- messages the sender had deleted, which the API hides.
--
-- VERIFY ON SUPABASE. Realtime cannot be exercised outside Supabase. If new
-- messages stop arriving live, `grant select on public.messages to authenticated`
-- restores the wider read.
--
-- ROLLBACK. Re-run the copy loop from 0033 with the roles swapped, and recreate
-- the 0029 moderator policy.
-- =============================================================================

-- Also removes column privileges, as REVOKE on a table does.
revoke all privileges on all tables in schema public from authenticated;

grant select (id, conversation_id, created_at) on public.messages to authenticated;

-- Functions in `app` default to EXECUTE for PUBLIC unless a migration revoked it, which
-- many did not. `anon` has no business calling them: `app` is not exposed, so this is
-- defence in depth. `app.current_user_id()` stays, as 0003 granted it deliberately. Those
-- `authenticated` could run keep working for it, because RLS policies call them.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname <> 'current_user_id'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke all on function %s from public, anon', fn.signature);
    execute format('grant execute on function %s to authenticated, service_role', fn.signature);
  end loop;
end;
$$;

-- Nothing in `public` uses a sequence today. Covered so that stays true.
revoke all privileges on all sequences in schema public from authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'objects'
  ) then
    raise notice 'storage schema absent — skipping the moderator read policy (expected outside Supabase)';
    return;
  end if;

  drop policy if exists photos_bucket_select_moderator on storage.objects;
  create policy photos_bucket_select_moderator
    on storage.objects for select to authenticated
    using (
      bucket_id = 'photos'
      and app.is_active_moderator()
      and app.staff_photo_access_open(name)
    );
end;
$$;
