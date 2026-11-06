-- =============================================================================
-- 0029 — Code review remediation, Phase 3 (review dated 2026-10-28)
--
-- Database half of B5, B6, B13, B26 and L1. Forward-only and additive; no
-- earlier migration is edited.
--
--   B5   Photos were auto-approved. They now wait for a moderator, so the
--        moderator's decision needs somewhere to live (L1 below).
--   B6   Profiles were auto-approved and later edits — including the date of
--        birth — were never re-reviewed. DOB locks once the profile is
--        complete; a correction goes through a support request with an audit
--        trail (company decision 4); edits to reviewed text send the profile
--        back to review.
--   B13  An unapproved photo could be the profile's main photo.
--   B26  Notifications had no retention.
--   L1   No admin or moderation backend. This is the M2 design from the ERD
--        (§14, §17): admin users with mandatory MFA, roles, an append-only
--        audit, moderation actions with a required reason.
--
-- RELEASE ORDER: after 0028. The Phase 3 API reads these tables; apply this
-- first, then deploy that API.
-- =============================================================================

-- =============================================================================
-- B13 — only an approved photo can be the main photo
--
-- Existing rows are made consistent first, so the constraint cannot fail on
-- data written before it existed (a pending photo set as primary was exactly
-- the bug). The route checks too and answers 409; this is the backstop for a
-- member writing `is_primary` through the Data API (0006 grants it).
-- =============================================================================

update public.photos
   set is_primary = false
 where is_primary and moderation_status <> 'approved';

alter table public.photos
  add constraint photos_primary_approved
  check (not is_primary or moderation_status = 'approved');

-- =============================================================================
-- B6 — date of birth locks once the profile is complete
--
-- The same rule 0003 applies to gender, and for the same reason: an age that
-- can be changed after review is an age nobody reviewed. One difference — a
-- genuine mistake must be correctable, so the server may still change it
-- (company decision 4: a support/admin workflow with an audit trail, see
-- dob_correction_requests below). Members, through the API or the Data API,
-- may not.
-- =============================================================================

create or replace function app.enforce_dob_locked()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.profile_completed_at is not null
     and new.date_of_birth is distinct from old.date_of_birth
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
  then
    raise exception 'date of birth is locked once the profile is complete'
      using errcode = 'insufficient_privilege',
            hint = 'B6: request a correction; support verifies it.';
  end if;
  return new;
end;
$$;

comment on function app.enforce_dob_locked() is
  'BEFORE UPDATE OF date_of_birth on users. After profile completion only the '
  'server (the audited correction workflow) may change it (B6).';

create trigger users_dob_locked
  before update of date_of_birth on public.users
  for each row execute function app.enforce_dob_locked();

-- =============================================================================
-- B6 — editing what was reviewed sends the profile back to review
--
-- Moderation reviews what a member WROTE. Reference-coded fields (education
-- level, marital status, …) come from fixed lists and carry no moderation
-- risk; free text and the display name do. Changing any of them after a
-- review returns the profile to `pending`, out of discovery until a moderator
-- looks again. Server-side changes (the moderator's own decision) do not.
-- =============================================================================

create or replace function app.rereview_on_profile_edit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.review_status in ('approved', 'rejected')
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and (
       new.about_me is distinct from old.about_me
       or new.looking_for is distinct from old.looking_for
       or new.institution is distinct from old.institution
       or new.family_background is distinct from old.family_background
     )
  then
    new.review_status := 'pending';
    new.reviewed_at := null;
    new.rejection_reason_key := null;
  end if;
  return new;
end;
$$;

comment on function app.rereview_on_profile_edit() is
  'BEFORE UPDATE on profiles. A member editing reviewed free text after a '
  'decision returns the profile to pending (B6).';

create trigger profiles_rereview_on_edit
  before update on public.profiles
  for each row execute function app.rereview_on_profile_edit();

-- The one privileged write, split out of the trigger. Members hold no grant
-- on profiles.review_status, so it must be elevated — but a SECURITY DEFINER
-- trigger would see its OWNER as current_user and could no longer tell a
-- member's rename from the server's (found by this migration's own test). So
-- the trigger below runs with the caller's rights and decides; this helper
-- only acts. It takes no argument and touches only the CALLER's own profile,
-- so a member calling it directly can only send their own profile to review.
create or replace function app.send_own_profile_to_review()
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set review_status = 'pending', reviewed_at = null, rejection_reason_key = null
   where user_id = app.current_user_id()
     and review_status in ('approved', 'rejected')
$$;

revoke all on function app.send_own_profile_to_review() from public;
grant execute on function app.send_own_profile_to_review() to authenticated;

create or replace function app.rereview_on_name_change()
returns trigger
language plpgsql
-- INVOKER rights, deliberately: current_user must be the caller.
set search_path = public, pg_temp
as $$
begin
  if new.display_name is distinct from old.display_name
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and new.id = app.current_user_id()
  then
    perform app.send_own_profile_to_review();
  end if;
  return null;
end;
$$;

comment on function app.rereview_on_name_change() is
  'AFTER UPDATE OF display_name on users. A renamed member is reviewed again (B6).';

create trigger users_rereview_on_name_change
  after update of display_name on public.users
  for each row execute function app.rereview_on_name_change();

-- =============================================================================
-- L1 — admin users, roles and the audit (ERD §17, M2)
--
-- A separate surface from members. An admin is an existing auth identity
-- (users row) PLUS a row here; there is no API to create one — granting the
-- power to moderate is an operator action, made with the service role and
-- recorded in the audit. `mfa_required` defaults to true: README §9.1 makes
-- 2FA mandatory, and the API refuses an admin token that is not aal2.
--
-- Simplified from the ERD's roles/permissions/role_assignments to one
-- assignments table with a fixed role set; permissions are decided in code by
-- role. Every table is RESTRICTED: RLS enabled and forced, no member grant, no
-- policy. Only the API's service role reads or writes them.
-- =============================================================================

create table public.admin_users (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references public.users (id) on delete restrict,
  status        text not null default 'active',
  mfa_required  boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint admin_users_status_valid check (status in ('active', 'disabled'))
);

comment on table public.admin_users is
  'Staff who may moderate (L1). An auth identity plus this row; created by an '
  'operator with the service role, never through the API.';

create table public.admin_role_assignments (
  id             uuid primary key default gen_random_uuid(),
  admin_user_id  uuid not null references public.admin_users (id) on delete restrict,
  role_key       text not null,
  granted_at     timestamptz not null default now(),
  expires_at     timestamptz,
  constraint admin_role_assignments_role_valid
    check (role_key in ('moderator', 'support', 'admin')),
  constraint admin_role_assignments_unique unique (admin_user_id, role_key)
);

create index admin_role_assignments_admin_idx on public.admin_role_assignments (admin_user_id);

create table public.admin_action_audit (
  id             uuid primary key default gen_random_uuid(),
  admin_user_id  uuid not null references public.admin_users (id) on delete restrict,
  action         text not null,
  target_type    text not null,
  target_id      uuid not null,
  reason         text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint admin_action_audit_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index admin_action_audit_admin_idx on public.admin_action_audit (admin_user_id, created_at desc);
create index admin_action_audit_target_idx on public.admin_action_audit (target_type, target_id);

comment on table public.admin_action_audit is
  'Every moderation decision, by whom and why. Append-only: an audit an '
  'admin can edit is not an audit (ERD §17).';

-- Append-only for EVERY role, the service role included.
create or replace function app.audit_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admin_action_audit is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger admin_action_audit_append_only
  before update or delete on public.admin_action_audit
  for each row execute function app.audit_is_append_only();

-- Suspensions, bans and warnings (ERD §14, moderation_actions). The reason is
-- NOT NULL and non-blank deliberately: an unexplained ban is unappealable.
create table public.moderation_actions (
  id               uuid primary key default gen_random_uuid(),
  subject_user_id  uuid not null references public.users (id) on delete restrict,
  actor_admin_id   uuid not null references public.admin_users (id) on delete restrict,
  action           text not null,
  reason           text not null,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  constraint moderation_actions_action_valid
    check (action in ('warn', 'restrict', 'suspend', 'ban', 'clear')),
  constraint moderation_actions_reason_present check (reason ~ '[^[:space:]]')
);

create index moderation_actions_subject_idx on public.moderation_actions (subject_user_id, created_at desc);

-- =============================================================================
-- B6 — date-of-birth corrections (company decision 4)
--
-- The member asks; support verifies outside the app (ID check) and decides;
-- the decision is audited in admin_action_audit. One open request per member.
-- `current_dob` is a snapshot filled by the database, so the record shows what
-- the date WAS even after it changes.
-- =============================================================================

create table public.dob_correction_requests (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete restrict,
  current_dob          date,
  requested_dob        date not null,
  reason               text not null,
  status               text not null default 'pending',
  decided_by_admin_id  uuid references public.admin_users (id) on delete restrict,
  decided_at           timestamptz,
  decision_note        text,
  created_at           timestamptz not null default now(),
  constraint dob_correction_requests_status_valid
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint dob_correction_requests_reason_present check (reason ~ '[^[:space:]]'),
  constraint dob_correction_requests_reason_len check (char_length(reason) <= 1000),
  constraint dob_correction_requests_decided_consistent check (
    (status = 'pending' and decided_at is null and decided_by_admin_id is null)
    or (status = 'cancelled' and decided_at is not null)
    or (status in ('approved', 'rejected') and decided_at is not null
        and decided_by_admin_id is not null)
  )
);

create unique index dob_correction_requests_one_open
  on public.dob_correction_requests (user_id)
  where status = 'pending';

create or replace function app.snapshot_current_dob()
returns trigger
language plpgsql
-- Fires on a member's insert; members cannot read another column of users
-- through this path, and the value written is their own date of birth.
security definer
set search_path = public, pg_temp
as $$
begin
  new.current_dob := (select u.date_of_birth from public.users u where u.id = new.user_id);
  return new;
end;
$$;

create trigger dob_correction_requests_snapshot
  before insert on public.dob_correction_requests
  for each row execute function app.snapshot_current_dob();

-- =============================================================================
-- RLS for the new tables
-- =============================================================================

alter table public.admin_users enable row level security;
alter table public.admin_users force row level security;
alter table public.admin_role_assignments enable row level security;
alter table public.admin_role_assignments force row level security;
alter table public.admin_action_audit enable row level security;
alter table public.admin_action_audit force row level security;
alter table public.moderation_actions enable row level security;
alter table public.moderation_actions force row level security;
alter table public.dob_correction_requests enable row level security;
alter table public.dob_correction_requests force row level security;

grant all on public.admin_users to service_role;
grant all on public.admin_role_assignments to service_role;
grant select, insert on public.admin_action_audit to service_role;
grant all on public.moderation_actions to service_role;
grant all on public.dob_correction_requests to service_role;

-- A member sees and files their own correction requests. Column INSERT grant:
-- they choose the date and the reason, never the status or the decision.
grant select on public.dob_correction_requests to authenticated;
grant insert (user_id, requested_dob, reason) on public.dob_correction_requests to authenticated;

create policy dob_correction_requests_select_own
  on public.dob_correction_requests for select to authenticated
  using (user_id = app.current_user_id());

create policy dob_correction_requests_insert_own
  on public.dob_correction_requests for insert to authenticated
  with check (user_id = app.current_user_id() and status = 'pending');

-- =============================================================================
-- B26 — notifications are kept 12 months (ERD retention table)
--
-- One function, so the retention rule lives in one place; run by the
-- maintenance script (`pnpm --filter @nikahmate/api maintenance`) on whatever
-- schedule the deployment provides. Service role only.
-- =============================================================================

create or replace function app.purge_expired_notifications()
returns integer
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with purged as (
    delete from public.notifications
     where created_at < now() - interval '12 months'
    returning 1
  )
  select count(*)::int from purged
$$;

comment on function app.purge_expired_notifications() is
  'Deletes notifications older than 12 months (ERD retention). B26.';

revoke all on function app.purge_expired_notifications() from public;
grant execute on function app.purge_expired_notifications() to service_role;

-- =============================================================================
-- L1 — may the caller act as a moderator?
--
-- Answers from the caller's own JWT, so it can be used where only the token is
-- known: the Storage policy below. Active admin, an unexpired `moderator` or
-- `admin` role, and — when the admin's row requires it, which is the default —
-- a token issued after a second factor (`aal2`, Supabase Auth MFA).
-- =============================================================================

create or replace function app.is_active_moderator()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.admin_users a
      join public.admin_role_assignments r on r.admin_user_id = a.id
     where a.user_id = app.current_user_id()
       and a.status = 'active'
       and r.role_key in ('moderator', 'admin')
       and (r.expires_at is null or r.expires_at > now())
       and (
         not a.mfa_required
         or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2'
       )
  )
$$;

comment on function app.is_active_moderator() is
  'True when the caller is an active moderator/admin, with MFA (aal2) when '
  'required. Lets a moderator view a queued photo (L1).';

revoke all on function app.is_active_moderator() from public;
grant execute on function app.is_active_moderator() to authenticated, service_role;

-- A moderator must SEE a photo to judge it. Storage policies were owner-only,
-- and the API holds no service-role key by design, so without this the queue
-- would hold images nobody could open. Read-only, photos bucket only.
--
-- Guarded like 0007: on a plain Postgres (PGlite in the test suites) there is
-- no `storage` schema and this is a no-op, so it is verified only on Supabase.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'objects'
  ) then
    raise notice 'storage schema absent — skipping moderator read policy (expected outside Supabase)';
    return;
  end if;

  drop policy if exists photos_bucket_select_moderator on storage.objects;
  create policy photos_bucket_select_moderator
    on storage.objects for select to authenticated
    using (bucket_id = 'photos' and app.is_active_moderator());
end;
$$;
