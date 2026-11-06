-- =============================================================================
-- 0030 — Code review remediation, Phase 4 (review dated 2026-10-28, L10)
--
-- The tables behind API operations that docs/openapi.yaml specifies and the
-- ERD designs, but that were never built:
--
--   notification_preferences  GET/PUT /me/notification-preferences  (ERD §15)
--   push_tokens               POST/DELETE /me/push-tokens           (ERD §15)
--   profile_views             POST /profiles/{id}/view, GET /me/profile-views
--   account_deletion_requests POST/DELETE /me/delete                (ERD §3, E1, R4)
--
-- Forward-only and additive. RELEASE ORDER: after 0029; then the Phase 4 API.
-- =============================================================================

-- =============================================================================
-- notification_preferences — per type, owner-managed (ERD §15)
--
-- One row per (member, type). No row means the default: in-app on, push on.
-- Quiet hours are carried on every row the API writes (PUT replaces the whole
-- set), so any row answers "what are my quiet hours". They govern PUSH only —
-- an inbox entry does not interrupt anyone — and are evaluated in the member's
-- own timezone when push delivery exists (L8).
-- =============================================================================

create table public.notification_preferences (
  user_id            uuid not null references public.users (id) on delete restrict,
  type               text not null,
  push_enabled       boolean not null default true,
  inapp_enabled      boolean not null default true,
  quiet_hours_start  time,
  quiet_hours_end    time,
  updated_at         timestamptz not null default now(),
  primary key (user_id, type),
  -- The same set notifications_type_valid allows (0024), so a preference can
  -- never be stored for a type that is never sent.
  constraint notification_preferences_type_valid check (
    type in (
      'interest_received', 'interest_accepted', 'new_match', 'new_message',
      'photo_request', 'photo_request_answered', 'family_invitation',
      'family_invitation_answered', 'stage_advance_proposed',
      'verification_update', 'security_alert', 'report_update',
      'family_review_requested', 'family_review_decided', 'family_review_stalled'
    )
  ),
  -- `security_alert` cannot be silenced in-app: it is how a member learns
  -- their account changed.
  constraint notification_preferences_security_alert_inapp
    check (type <> 'security_alert' or inapp_enabled),
  constraint notification_preferences_quiet_hours_paired
    check ((quiet_hours_start is null) = (quiet_hours_end is null))
);

comment on table public.notification_preferences is
  'Per-type notification settings (ERD §15). Absent row = default on. In-app '
  'is enforced by the trigger below; push is stored for delivery (L8).';

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

grant select, insert, delete on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;

create policy notification_preferences_select_own
  on public.notification_preferences for select to authenticated
  using (user_id = app.current_user_id());
create policy notification_preferences_insert_own
  on public.notification_preferences for insert to authenticated
  with check (user_id = app.current_user_id());
create policy notification_preferences_delete_own
  on public.notification_preferences for delete to authenticated
  using (user_id = app.current_user_id());

-- In-app OFF must mean no inbox entry, whichever path writes it — there are
-- eight insert sites across four route files. One trigger, at the table.
-- Returning NULL from a BEFORE INSERT skips the row (and its ON CONFLICT
-- branch), so a silenced type simply produces nothing.
create or replace function app.respect_notification_preferences()
returns trigger
language plpgsql
-- Fires on the server's inserts for OTHER members; reads their preferences.
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.notification_preferences np
     where np.user_id = new.user_id
       and np.type = new.type
       and not np.inapp_enabled
  ) then
    return null;
  end if;
  return new;
end;
$$;

create trigger notifications_respect_preferences
  before insert on public.notifications
  for each row execute function app.respect_notification_preferences();

-- =============================================================================
-- push_tokens — a capability to reach a device (ERD §15): RESTRICTED
--
-- No member grant, no policy. The API writes it with the service role from the
-- member's own registration; delivery (L8) is a separate, external service.
-- =============================================================================

create table public.push_tokens (
  user_id         uuid not null references public.users (id) on delete restrict,
  device_id       text not null,
  token           text not null,
  platform        text not null,
  invalidated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint push_tokens_platform_valid check (platform in ('android', 'ios')),
  constraint push_tokens_token_len check (char_length(token) between 8 and 4096),
  constraint push_tokens_device_len check (char_length(device_id) between 1 and 200)
);

alter table public.push_tokens enable row level security;
alter table public.push_tokens force row level security;
grant all on public.push_tokens to service_role;

-- =============================================================================
-- profile_views — SYSTEM (ERD §9)
--
-- Every view is recorded, incognito or not: recording is for abuse
-- investigation; hiding incognito viewers from "who viewed you" is the API's
-- job. No member can read the raw rows.
-- =============================================================================

create table public.profile_views (
  id              uuid primary key default gen_random_uuid(),
  viewer_user_id  uuid not null references public.users (id) on delete restrict,
  viewed_user_id  uuid not null references public.users (id) on delete restrict,
  viewed_at       timestamptz not null default now(),
  source          text not null default 'profile',
  constraint profile_views_not_self check (viewer_user_id <> viewed_user_id),
  constraint profile_views_source_valid check (source in ('profile', 'discovery', 'interest'))
);

create index profile_views_viewed_idx on public.profile_views (viewed_user_id, viewed_at desc);
create index profile_views_viewer_idx on public.profile_views (viewer_user_id, viewed_at desc);

alter table public.profile_views enable row level security;
alter table public.profile_views force row level security;
grant all on public.profile_views to service_role;

-- =============================================================================
-- account_deletion_requests — RESTRICTED (ERD §3, E1, R4)
--
-- A request starts a 30-day grace period. An open safety case places a hold
-- (R4): evidence about a member must not be erased while it is being looked
-- at. EXECUTION — anonymising the member and deleting the auth identity — is
-- not in this migration: it needs a job runner and Supabase Auth
-- administration, neither of which exists yet (L11, L7).
-- =============================================================================

create table public.account_deletion_requests (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.users (id) on delete restrict,
  requested_at           timestamptz not null default now(),
  scheduled_for          timestamptz not null,
  status                 text not null default 'pending',
  retention_hold_reason  text,
  -- What `users.status` was before the request, so cancelling restores it.
  -- A suspended or banned member who asks for deletion and then cancels must
  -- return suspended or banned, not `active`: cancelling is not an appeal.
  previous_status        text not null,
  executed_at            timestamptz,
  cancelled_at           timestamptz,
  constraint account_deletion_requests_status_valid
    check (status in ('pending', 'held', 'executed', 'cancelled')),
  constraint account_deletion_requests_hold_consistent
    check ((status = 'held') = (retention_hold_reason is not null)),
  constraint account_deletion_requests_grace
    check (scheduled_for >= requested_at)
);

-- One live request per member.
create unique index account_deletion_requests_one_open
  on public.account_deletion_requests (user_id)
  where status in ('pending', 'held');

alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_requests force row level security;
grant all on public.account_deletion_requests to service_role;

-- =============================================================================
-- L11 — retention and expiry, as functions the maintenance task calls
--
-- The ERD retention table (§ retention): security_events 12 months,
-- profile_views 12 months (notifications: 0029). Family invitations past
-- their expiry are marked `expired` — the API already REPORTS them expired on
-- read; this makes the stored state agree. Each function is idempotent:
-- running it twice changes nothing the second time. Service role only.
-- =============================================================================

create or replace function app.purge_expired_security_events()
returns integer
language sql volatile security definer set search_path = public, pg_temp
as $$
  with purged as (
    delete from public.security_events where created_at < now() - interval '12 months' returning 1
  ) select count(*)::int from purged
$$;

create or replace function app.purge_expired_profile_views()
returns integer
language sql volatile security definer set search_path = public, pg_temp
as $$
  with purged as (
    delete from public.profile_views where viewed_at < now() - interval '12 months' returning 1
  ) select count(*)::int from purged
$$;

create or replace function app.expire_family_invitations()
returns integer
language sql volatile security definer set search_path = public, pg_temp
as $$
  with expired as (
    update public.family_invitations
       set status = 'expired', responded_at = now()
     where status = 'pending' and expires_at < now()
    returning 1
  ) select count(*)::int from expired
$$;

revoke all on function app.purge_expired_security_events() from public;
revoke all on function app.purge_expired_profile_views() from public;
revoke all on function app.expire_family_invitations() from public;
grant execute on function app.purge_expired_security_events() to service_role;
grant execute on function app.purge_expired_profile_views() to service_role;
grant execute on function app.expire_family_invitations() to service_role;
