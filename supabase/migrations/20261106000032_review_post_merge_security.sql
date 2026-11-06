-- =============================================================================
-- 0032 — post-merge security audit: N2/B7, N1 (database half), N5 support
--
-- N2/B7. The API's `asUser` and the Supabase Data API both run as
-- `authenticated`, and `profiles_select_visible` (0011/0012) let any member read
-- every column of any approved profile. Field privacy lives only in the API
-- (ERD §2.3), so `family_background`, `institution`, `about_me` and the rest
-- were readable directly even when set to private. Removing `public` from the
-- exposed schemas is a Dashboard setting this file cannot make, cannot verify,
-- and which can be reversed by anyone with Dashboard access; GraphQL and any
-- future exposure reach the same grants. So the database itself now holds the
-- line: a member's direct SELECT on `profiles`, `photos` and `photo_variants`
-- returns only their own rows.
--
-- Nothing legitimate needs the wider rule. Every cross-member read of these
-- tables is an API read made under a registered service-role use with the
-- visibility rule applied in the query and the field filter in the route
-- (`profile.read_public`, `discovery.read_cards`, `photo.read_access`). The
-- security-definer predicates (`app.can_view_profile`, `app.can_view_photo`,
-- `app.photo_variant_readable`, the Storage rule) do not depend on these
-- policies. The two predicates that existed only for the old policies are left
-- in place: dropping them is cleanup, not security.
--
-- N1. A suspended, banned, deactivated or pending-deletion account could keep
-- writing and reading through the Data API (and Realtime, and Storage). The API
-- gate refuses them; RESTRICTIVE policies below refuse them underneath it, so a
-- member-facing table cannot be reached by routing around the API. Exempt for
-- READ only, because `GET /me` reads them as the caller and a restricted member
-- must be able to learn their own status: users, user_settings,
-- verification_status, family_relationships, family_permissions. Reference
-- tables hold no member data. Restrictive policies do not touch service_role,
-- which has BYPASSRLS.
--
-- N1, timed suspensions. `moderation_actions.expires_at` was recorded and never
-- honoured. `app.lift_expired_suspensions` honours exactly the date a moderator
-- chose, and nothing else: no date means no automatic end. A later ban or clear
-- supersedes it. It restores `previous_status`, so a member who had deactivated
-- themselves is not put back into discovery by a suspension ending.
--
-- ROLLBACK. Recreate the 0012 policies, drop the restrictive policies by name
-- (`*_refuse_restricted_account`), drop the two functions, and drop the
-- `moderation_actions` constraint and column. Rows with a null actor must be
-- kept (they are the record of a lift), so `actor_admin_id` stays nullable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- N2/B7 — direct reads are owner-only
-- -----------------------------------------------------------------------------

drop policy profiles_select_visible on public.profiles;

create policy profiles_select_own
  on public.profiles for select to authenticated
  using (user_id = app.current_user_id() and deleted_at is null);

drop policy photos_select_visible on public.photos;

create policy photos_select_own
  on public.photos for select to authenticated
  using (user_id = app.current_user_id() and deleted_at is null);

drop policy photo_variants_select_visible on public.photo_variants;

-- Follows the parent. Reading `photos` here runs that table's owner-only policy,
-- which does not read `photo_variants`, so there is no cycle.
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

-- -----------------------------------------------------------------------------
-- N1 — may the caller's account act at all?
--
-- An allowlist, so an unknown or future status fails closed. `onboarding` is
-- allowed: it is a member finishing their profile, not a restriction.
-- -----------------------------------------------------------------------------

create or replace function app.current_account_can_act()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
     where u.id = app.current_user_id()
       and u.deleted_at is null
       and u.status in ('onboarding', 'active')
  )
$$;

comment on function app.current_account_can_act() is
  'N1: false for a suspended, banned, deactivated, pending-deletion or deleted '
  'account. Used by the restrictive policies and the Storage policy.';

revoke all on function app.current_account_can_act() from public;
grant execute on function app.current_account_can_act() to authenticated, service_role;

-- Every table a member can reach, except the read-exempt ones named above.
-- `(select …)` makes it an InitPlan: evaluated once per statement, not per row.
do $$
declare
  target text;
begin
  foreach target in array array[
    'blocks', 'compatibility_factors', 'compatibility_scores',
    'conversation_participants', 'conversation_stages', 'conversations',
    'dismissed_profiles', 'dob_correction_requests', 'family_access_log',
    'family_invitations', 'family_reviews', 'interests', 'match_candidates',
    'matches', 'message_reads', 'messages', 'notification_preferences',
    'notifications', 'partner_preferences', 'photo_grants', 'photo_requests',
    'photo_variants', 'photos', 'preference_rules', 'profile_field_visibility',
    'profiles', 'reports', 'security_events', 'shortlists', 'usage_counters',
    'user_devices', 'user_entitlements', 'user_locations'
  ] loop
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated
         using ((select app.current_account_can_act()))
         with check ((select app.current_account_can_act()))',
      target || '_refuse_restricted_account', target
    );
  end loop;

  -- Read-exempt, but never writable by a restricted account.
  foreach target in array array['users', 'user_settings'] loop
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated
         using ((select app.current_account_can_act()))
         with check ((select app.current_account_can_act()))',
      target || '_refuse_restricted_account', target
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- N1 — Storage. A restrictive policy scoped to this bucket, so a restricted
-- account cannot read, sign, upload, replace or delete any object through the
-- Storage API. This also covers a restricted member of staff, whose moderator
-- read path (0029) would otherwise still match. Guarded like 0007, 0029, 0031.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'objects'
  ) then
    raise notice 'storage schema absent — skipping the restricted-account policy (expected outside Supabase)';
    return;
  end if;

  drop policy if exists photos_bucket_refuse_restricted_account on storage.objects;
  create policy photos_bucket_refuse_restricted_account
    on storage.objects as restrictive for all to authenticated
    using (bucket_id <> 'photos' or (select app.current_account_can_act()))
    with check (bucket_id <> 'photos' or (select app.current_account_can_act()));
end;
$$;

-- -----------------------------------------------------------------------------
-- N1 — timed suspensions
-- -----------------------------------------------------------------------------

alter table public.moderation_actions
  alter column actor_admin_id drop not null,
  add column previous_status text,
  add constraint moderation_actions_previous_status_valid
    check (previous_status is null
           or previous_status in ('onboarding', 'active', 'deactivated', 'pending_deletion')),
  -- Only the system's own record of an expiry may have no staff member behind it.
  add constraint moderation_actions_actor_present
    check (actor_admin_id is not null
           or (action = 'clear' and reason = 'suspension_expired'));

comment on column public.moderation_actions.previous_status is
  'The account status to return to when this restriction ends. Null on rows '
  'from before 0032, which return to active as they always did.';

create or replace function app.lift_expired_suspensions(only_user uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  due record;
  lifted integer := 0;
begin
  for due in
    select u.id, latest.previous_status
      from public.users u
      join lateral (
        select m.action, m.expires_at, m.previous_status
          from public.moderation_actions m
         where m.subject_user_id = u.id
           and m.action in ('suspend', 'ban', 'clear')
         order by m.created_at desc, m.id desc
         limit 1
      ) latest on true
     where u.status = 'suspended'
       and u.deleted_at is null
       and (only_user is null or u.id = only_user)
       and latest.action = 'suspend'
       and latest.expires_at is not null
       and latest.expires_at <= now()
       for update of u skip locked
  loop
    update public.users
       set status = coalesce(due.previous_status, 'active')
     where id = due.id;

    insert into public.moderation_actions (subject_user_id, actor_admin_id, action, reason)
    values (due.id, null, 'clear', 'suspension_expired');

    lifted := lifted + 1;
  end loop;
  return lifted;
end;
$$;

comment on function app.lift_expired_suspensions(uuid) is
  'N1: ends suspensions whose moderator-set end date has passed. Idempotent. '
  'Called by the API when a suspended member makes a request, and by maintenance.';

revoke all on function app.lift_expired_suspensions(uuid) from public;
grant execute on function app.lift_expired_suspensions(uuid) to service_role;
