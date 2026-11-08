-- =============================================================================
-- 0035 — account erasure (ERD E1) and the family review SLA as a scheduled sweep
-- =============================================================================
-- ERASURE. `POST /me/delete` has promised since 0030 that an account is removed after
-- a 30-day grace period, and nothing carried that out. `app.erase_account` does, as
-- ERD E1 defines it: "erasure anonymises, it does not destroy a counterpart's data".
--
--   Removed     the member's name and date of birth, their profile and its sensitive
--               fields, location, preferences, settings, devices, push tokens,
--               notifications, discovery state, verification record, date-of-birth
--               requests, family invitations (which hold a contact detail), photo
--               variants and grants, and the words they attached to photo requests and
--               interests. Photo FILES, and the sign-in itself, are deleted by the
--               erasure tool after this has run and before it commits: Postgres cannot
--               reach Storage or Auth.
--   Closed      their conversations (they leave, which closes the thread for both, as
--               B25 does, and the thread is marked ended), their matches (ended, as
--               unmatch does), open interests (withdrawn), open photo requests
--               (withdrawn), family links and every permission on them (revoked).
--   Kept        a tombstone `users` row, because every user foreign key is `on delete
--               restrict`; the link from their deleted sign-in's id to the tombstone,
--               so a session token issued before the erasure cannot create a new
--               account (see below); and the records that are someone else's or carry
--               a lawful basis: the other person's conversation and its messages,
--               interests (without the member's note), matches and their history,
--               family reviews and access logs, blocks, reports, moderation actions,
--               retention holds, the staff audit, the staff access log,
--               security events and profile views (purged at 12 months by
--               `maintenance`), consents (evidence of the basis that applied), the
--               photo rows themselves (soft-deleted, their files gone), and the
--               executed request.
--   Not done    `gender` stays on the tombstone: it is immutable once a profile is
--               complete (enforce_gender_immutable), and is not a direct identifier on
--               its own. `country_code` stays for the same reason.
--
-- ERD E1 says these are "defensible defaults, not legal advice" that need counsel's
-- review. The function is the single place to change if that review changes them.
--
-- SAFETY. Only an account with an open, due, unheld request, asked at least 30 days ago,
-- can be erased, and the function checks all of that itself, under row locks, so a
-- caller cannot erase anyone else and a cancellation cannot race it. A report opened
-- during the grace period, or a retention hold on the account, holds the request
-- instead (R4). A held request is never executed here: releasing a hold is a staff
-- decision. A staff account is refused until its staff access is removed. Service role
-- only.
--
-- FAMILY SLA. The 72-hour warning (D12-g) fired only when an owner opened the Family
-- screen. `app.notify_stalled_family_reviews` does the same sweep for everyone, for the
-- `maintenance` script to run on a schedule. The sweep on read stays.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Retention holds on the ACCOUNT.
--
-- A hold on a deletion request lived only on that request. A member could cancel a
-- held request and ask again: the new one is re-checked for an open report and a
-- suspension or ban, but a hold staff placed for a legal reason did not carry over,
-- and the account would have been erased 30 days later. A hold placed here survives
-- that. While it lasts, `app.erasure_blocker` answers `retention_hold` and
-- `app.erase_account` holds the request instead of erasing.
--
-- Who may place or lift a hold, and when, is a company decision. There is no staff
-- screen for it: placing one is a supervised database change (PRODUCTION_SECURITY.md).
-- Members can neither read nor write this table. Kept after an erasure (lawful basis).
-- -----------------------------------------------------------------------------
create table public.account_retention_holds (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users (id) on delete restrict,
  -- Internal. The member is told only that a legal review must finish first.
  reason                text not null,
  placed_by_admin_id    uuid references public.admin_users (id) on delete restrict,
  placed_at             timestamptz not null default now(),
  released_at           timestamptz,
  released_by_admin_id  uuid references public.admin_users (id) on delete restrict,
  constraint account_retention_holds_reason_len
    check (char_length(btrim(reason)) between 1 and 500),
  constraint account_retention_holds_release_after_place
    check (released_at is null or released_at >= placed_at),
  constraint account_retention_holds_released_by_needs_release
    check (released_by_admin_id is null or released_at is not null)
);

create index account_retention_holds_active_idx
  on public.account_retention_holds (user_id)
  where released_at is null;

comment on table public.account_retention_holds is
  'ERD E1 retention holds on an account. An unreleased row blocks erasure; cancelling '
  'and re-requesting deletion does not clear it. Server only.';

select app.enable_rls('public.account_retention_holds');
grant all on public.account_retention_holds to service_role;

-- Why an account cannot be erased right now, or null if it can. One definition, used
-- by the erasure tool to decide what to skip and by app.erase_account below, which the
-- tool runs before it deletes any file or sign-in, so the two never disagree.
create or replace function app.erasure_blocker(target uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when r.id is null then 'no_open_request'
    when u.status is distinct from 'pending_deletion' or u.deleted_at is not null
      then 'not_awaiting_deletion'
    -- Releasing a hold is a staff decision, never the erasure's.
    when r.status = 'held' then 'held'
    -- The 30 days are checked from when the member asked as well as from the stored
    -- date, so a wrong `scheduled_for` can never bring an erasure forward.
    when r.scheduled_for > now() or r.requested_at > now() - interval '30 days'
      then 'grace_period_running'
    when exists (select 1 from public.admin_users a where a.user_id = target and a.status = 'active')
      then 'staff_account'
    -- A hold on the account itself, which cancelling and asking again does not clear.
    when exists (
      select 1 from public.account_retention_holds h
       where h.user_id = target and h.released_at is null
    ) then 'retention_hold'
    -- R4: a safety matter opened during the grace period holds the erasure.
    when exists (
      select 1 from public.reports p
       where p.reported_user_id = target and p.status in ('open', 'triaged')
    ) then 'open_report'
    else null
  end
  from (select target as id) t
  left join public.users u on u.id = t.id
  left join public.account_deletion_requests r
    on r.user_id = t.id and r.status in ('pending', 'held')
$$;

comment on function app.erasure_blocker(uuid) is
  'ERD E1: null when the account can be erased now, otherwise the reason it cannot.';

revoke all on function app.erasure_blocker(uuid) from public, anon, authenticated;
grant execute on function app.erasure_blocker(uuid) to service_role;

create or replace function app.erase_account(target uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  request_id uuid;
  blocker text;
begin
  -- Lock the request and the account first, so a cancellation cannot slip in
  -- between the check and the erasure.
  select r.id
    into request_id
    from public.account_deletion_requests r
   where r.user_id = target and r.status in ('pending', 'held')
   for update;
  perform 1 from public.users u where u.id = target for update;

  blocker := app.erasure_blocker(target);

  if blocker = 'held' then
    return 'held';
  end if;

  -- Told in general terms only (ERD E1), never the hold's own reason.
  if blocker in ('open_report', 'retention_hold') then
    update public.account_deletion_requests
       set status = 'held',
           retention_hold_reason = case blocker
             when 'open_report'
               then 'A safety review on this account must finish before it can be deleted.'
             else 'A legal review on this account must finish before it can be deleted.'
           end
     where id = request_id;
    return 'held';
  end if;

  if blocker is not null then
    raise exception 'this account cannot be erased: %', blocker
      using errcode = 'check_violation';
  end if;

  -- Closed: the other person keeps the conversation, read-only. Leaving and ending
  -- both cancel pending stage proposals through their own triggers (B16, B25).
  update public.conversation_participants
     set left_at = now()
   where user_id = target and left_at is null;

  -- Shown as over, not active, to the person left behind. It stays in their list.
  update public.conversations c
     set status = 'ended'
    from public.conversation_participants p
   where p.conversation_id = c.id and p.user_id = target and c.status <> 'ended';

  insert into public.match_events (match_id, event, actor_user_id, from_state)
  select m.id, 'ended', target, m.communication_state
    from public.matches m
   where (m.user_a_id = target or m.user_b_id = target) and m.ended_at is null;

  update public.matches
     set ended_at = now(), ended_by_user_id = target, end_reason = 'account_deleted'
   where (user_a_id = target or user_b_id = target) and ended_at is null;

  update public.interests
     set status = 'withdrawn', responded_at = coalesce(responded_at, now())
   where (sender_user_id = target or recipient_user_id = target)
     and status in ('pending', 'maybe_later');

  update public.photo_requests
     set status = 'withdrawn', responded_at = coalesce(responded_at, now())
   where (requester_user_id = target or owner_user_id = target) and status = 'pending';

  -- The words they attached to a request: photo requests and interest notes alike.
  update public.photo_requests set message = null where requester_user_id = target;
  update public.interests set note = null where sender_user_id = target and note is not null;

  -- As the Family screen's own removal does: the link and every permission on it.
  update public.family_permissions p
     set granted = false
    from public.family_relationships r
   where p.relationship_id = r.id
     and (r.owner_user_id = target or r.delegate_user_id = target)
     and p.granted;

  update public.family_relationships
     set status = 'revoked', revoked_at = coalesce(revoked_at, now())
   where (owner_user_id = target or delegate_user_id = target) and status = 'active';

  -- Removed.
  delete from public.family_invitations where owner_user_id = target or invitee_user_id = target;
  delete from public.photo_grants where owner_user_id = target or grantee_user_id = target;
  delete from public.photo_variants v using public.photos p
   where v.photo_id = p.id and p.user_id = target;
  update public.photos
     set is_primary = false, deleted_at = coalesce(deleted_at, now())
   where user_id = target;

  delete from public.profile_sensitive where user_id = target;
  delete from public.profile_field_visibility where user_id = target;
  delete from public.profiles where user_id = target;
  delete from public.user_locations where user_id = target;
  delete from public.partner_preferences where user_id = target;
  delete from public.preference_rules where user_id = target;
  delete from public.notification_preferences where user_id = target;
  delete from public.push_tokens where user_id = target;
  delete from public.user_devices where user_id = target;
  delete from public.notifications where user_id = target;
  delete from public.shortlists where user_id = target or target_user_id = target;
  delete from public.dismissed_profiles where user_id = target or target_user_id = target;
  delete from public.match_candidates where user_id = target or candidate_user_id = target;
  delete from public.compatibility_scores where viewer_user_id = target or candidate_user_id = target;
  delete from public.discovery_generation_runs where user_id = target;
  delete from public.usage_counters where user_id = target;
  delete from public.message_reads where user_id = target;
  delete from public.verification_status where user_id = target;
  delete from public.dob_correction_requests where user_id = target;
  delete from public.user_entitlements where user_id = target;
  delete from public.user_settings where user_id = target;
  -- `user_auth_links` is KEPT, pointing at the tombstone. It holds only the id of a
  -- sign-in the tool deletes from Supabase Auth, and the provider name. Without it, a
  -- session token issued before the erasure (valid until it expires) would find no
  -- account and `POST /account/bootstrap` would create a new one for a sign-in that no
  -- longer exists, one nobody could ever delete. With it, every route refuses that
  -- token: the account behind it is soft-deleted.

  -- The tombstone. `users_identity_complete` allows these to be null in this status.
  update public.users
     set display_name = null,
         date_of_birth = null,
         onboarding_step = null,
         deleted_at = now()
   where id = target;

  update public.account_deletion_requests
     set status = 'executed', executed_at = now()
   where id = request_id;

  return 'erased';
end;
$$;

comment on function app.erase_account(uuid) is
  'ERD E1: anonymises an account whose deletion request is open, due and unheld. '
  'Holds it instead if a report is open (R4). Service role only.';

revoke all on function app.erase_account(uuid) from public, anon, authenticated;
grant execute on function app.erase_account(uuid) to service_role;

create or replace function app.notify_stalled_family_reviews(sla_hours integer default 72)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  stalled record;
  notified integer := 0;
begin
  for stalled in
    update public.family_reviews
       set sla_notified_at = now()
     where decision in ('pending', 'more_info_requested')
       and sla_notified_at is null
       and requested_at < now() - make_interval(hours => sla_hours)
       -- Only a review that can still be decided can be stalled (see family.ts).
       and exists (
         select 1 from public.matches m
          where m.id = family_reviews.match_id
            and m.communication_state = 'pending_family_review'
            and m.ended_at is null
       )
    returning id, match_id, owner_user_id
  loop
    insert into public.notifications (user_id, type, payload, dedupe_key)
    values (
      stalled.owner_user_id,
      'family_review_stalled',
      jsonb_build_object('matchId', stalled.match_id, 'slaHours', sla_hours),
      'family_review_stalled:' || stalled.id
    )
    on conflict do nothing;
    notified := notified + 1;
  end loop;
  return notified;
end;
$$;

comment on function app.notify_stalled_family_reviews(integer) is
  'D12-g: warns every owner whose family review has waited past the SLA, once. '
  'For maintenance to run on a schedule; the Family screen still sweeps on read.';

revoke all on function app.notify_stalled_family_reviews(integer) from public, anon, authenticated;
grant execute on function app.notify_stalled_family_reviews(integer) to service_role;
