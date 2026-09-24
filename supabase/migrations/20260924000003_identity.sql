-- =============================================================================
-- 0003 — identity and account
--
-- Seven tables plus app.current_user_id(), the resolver every RLS policy in the
-- system depends on.
--
-- Phase 1 note on `users` and `verification_status`: the ERD marks both as
-- access class `shared`, meaning the permission-resolved predicate decides who
-- sees them. That predicate needs blocks, interests and matches, none of which
-- exist until Phase 4. Until then these carry OWNER-ONLY policies, and Phase 3
-- extends them. Shipping a permissive placeholder would be the wrong direction
-- to be wrong in.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------

create table public.users (
  id                   uuid primary key default gen_random_uuid(),
  display_name         text not null,
  gender               text not null,
  date_of_birth        date not null,
  country_code         char(2) not null,

  -- Constant column existing only to carry the composite FK below.
  country_ref_type     text generated always as ('country'::text) stored,

  status               text not null default 'onboarding',
  onboarding_step      text,
  profile_completed_at timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,

  constraint users_display_name_len check (char_length(display_name) between 1 and 80),
  constraint users_gender_valid check (gender in ('male', 'female')),
  constraint users_status_valid check (status in (
    'onboarding', 'active', 'deactivated', 'suspended', 'banned', 'pending_deletion'
  )),
  constraint users_dob_sane check (
    date_of_birth > date '1900-01-01' and date_of_birth < current_date
  ),

  -- Database-level integrity on a hard-filterable reference code (ERD E2).
  constraint users_country_fk
    foreign key (country_ref_type, country_code)
    references public.reference_items (type, code)
    on delete restrict
);

comment on table public.users is
  'Core identity. The universal reference — every other table points here.';
comment on column public.users.gender is
  'Immutable once profile_completed_at is set. Discovery, matching and the '
  'entire preference model assume it cannot change.';
comment on column public.users.date_of_birth is
  'Age is computed from this and never stored. The date itself is never '
  'returned to another member.';

create index users_status_idx on public.users (status) where deleted_at is null;

-- The discovery prefilter. Matching is strictly cross-gender, so every
-- candidate query starts here.
create index users_gender_dob_idx
  on public.users (gender, date_of_birth)
  where deleted_at is null and status = 'active';

create index users_country_idx on public.users (country_code) where deleted_at is null;

create trigger users_touch
  before update on public.users
  for each row execute function app.touch_updated_at();

-- Gender immutability. A correctness control, not a convenience: the whole
-- matching model assumes it holds.
create or replace function app.enforce_gender_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.profile_completed_at is not null and new.gender is distinct from old.gender then
    raise exception 'gender is immutable once the profile is complete'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger users_gender_immutable
  before update on public.users
  for each row execute function app.enforce_gender_immutable();

-- Age gate. Enforced at the API too; this is the backstop. It cannot be a CHECK
-- constraint because the comparison is against current_date, which is not
-- immutable.
create or replace function app.enforce_minimum_age()
returns trigger
language plpgsql
as $$
begin
  if new.date_of_birth > (current_date - interval '18 years') then
    raise exception 'members must be at least 18 years old'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger users_minimum_age
  before insert or update of date_of_birth on public.users
  for each row execute function app.enforce_minimum_age();

-- -----------------------------------------------------------------------------
-- user_auth_links — the indirection that keeps auth replaceable
-- -----------------------------------------------------------------------------

create table public.user_auth_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete restrict,
  auth_user_id  uuid not null,
  provider      text not null,
  linked_at     timestamptz not null default now(),

  constraint user_auth_links_provider_valid
    check (provider in ('email', 'phone', 'google', 'apple')),
  constraint user_auth_links_auth_user_key unique (auth_user_id)
);

create index user_auth_links_user_idx on public.user_auth_links (user_id);

comment on table public.user_auth_links is
  'Maps a Supabase Auth id to our own users.id. This indirection is what lets '
  'the auth provider be replaced without rewriting every foreign key.';

-- -----------------------------------------------------------------------------
-- app.current_user_id() — read by every policy in the system
--
-- STABLE is load-bearing. It lets Postgres evaluate this once per statement
-- rather than once per row: the difference between a fast discovery query and
-- an unusable one (ERD §2.1).
--
-- SECURITY DEFINER because user_auth_links is `restricted` — no client role can
-- read it directly, and must not be able to.
-- -----------------------------------------------------------------------------

create or replace function app.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_id
  from public.user_auth_links
  where auth_user_id = auth.uid()
$$;

comment on function app.current_user_id() is
  'Resolves the JWT subject to our internal users.id. STABLE so it is evaluated '
  'once per statement, not once per row.';

revoke all on function app.current_user_id() from public;
grant execute on function app.current_user_id() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- user_settings
-- -----------------------------------------------------------------------------

create table public.user_settings (
  user_id             uuid primary key references public.users (id) on delete restrict,
  locale              text not null default 'en',
  timezone            text not null default 'UTC',
  show_online_status  boolean not null default true,
  send_read_receipts  boolean not null default true,
  incognito           boolean not null default false,
  discovery_paused    boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint user_settings_locale_shape check (locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$')
);

comment on column public.user_settings.timezone is
  'IANA identifier. Notification quiet hours are evaluated against this, never '
  'against the server timezone.';

create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- user_devices
-- -----------------------------------------------------------------------------

create table public.user_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete restrict,
  device_id     text not null,
  platform      text not null,
  app_version   text,
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint user_devices_platform_valid check (platform in ('android', 'ios')),
  constraint user_devices_user_device_key unique (user_id, device_id)
);

create trigger user_devices_touch
  before update on public.user_devices
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- user_consents — where R1 lives
-- -----------------------------------------------------------------------------

create table public.user_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete restrict,
  consent_type    text not null,
  version         text not null,
  granted         boolean not null,
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  ip_hash         text,
  user_agent_hash text,

  constraint user_consents_type_valid check (consent_type in (
    'terms', 'privacy', 'article9_religious_data', 'ai_processing', 'marketing'
  ))
);

create index user_consents_user_type_idx
  on public.user_consents (user_id, consent_type, granted_at desc);

comment on table public.user_consents is
  'Granular, versioned consent records. article9_religious_data is recorded '
  'separately and deliberately: religion is GDPR special-category data and this '
  'product is built on it. Bundling that consent into a general terms checkbox '
  'is the failure mode R1 describes.';
comment on column public.user_consents.ip_hash is
  'Hashed, never raw. Evidence of consent without retaining the identifier.';

-- -----------------------------------------------------------------------------
-- security_events — append-only
-- -----------------------------------------------------------------------------

create table public.security_events (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete restrict,
  event_type           text not null,
  ip_hash              text,
  user_agent_hash      text,
  approximate_country  char(2),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),

  constraint security_events_type_valid check (event_type in (
    'sign_in', 'sign_out', 'password_change', 'email_change',
    'new_device', 'device_revoked'
  ))
);

create index security_events_user_idx on public.security_events (user_id, created_at desc);

comment on column public.security_events.approximate_country is
  'Country-level only. A precise location in a security log is itself a privacy '
  'risk, and is not needed to recognise an unexpected sign-in.';

-- -----------------------------------------------------------------------------
-- verification_status
-- -----------------------------------------------------------------------------

create table public.verification_status (
  user_id             uuid primary key references public.users (id) on delete restrict,
  email_verified_at   timestamptz,
  phone_verified_at   timestamptz,
  selfie_verified_at  timestamptz,
  id_verified_at      timestamptz,
  profile_reviewed_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.verification_status is
  'Only the presence of a timestamp is ever exposed, never the artefacts behind '
  'it. selfie_verified_at and id_verified_at stay null through v1 — their flows '
  'arrive in 1.1 (ADR 0005).';

create trigger verification_status_touch
  before update on public.verification_status
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

select app.enable_rls('public.users');
select app.enable_rls('public.user_auth_links');
select app.enable_rls('public.user_settings');
select app.enable_rls('public.user_devices');
select app.enable_rls('public.user_consents');
select app.enable_rls('public.security_events');
select app.enable_rls('public.verification_status');

-- service_role: BYPASSRLS handles the rows, these handle the tables.
grant all on public.users to service_role;
grant all on public.user_auth_links to service_role;
grant all on public.user_settings to service_role;
grant all on public.user_devices to service_role;
grant all on public.user_consents to service_role;
grant all on public.security_events to service_role;
grant all on public.verification_status to service_role;

-- --- users: owner-only in Phase 1 -------------------------------------------

grant select, update on public.users to authenticated;

create policy users_select_own
  on public.users for select to authenticated
  using (id = app.current_user_id() and deleted_at is null);

create policy users_update_own
  on public.users for update to authenticated
  using (id = app.current_user_id() and deleted_at is null)
  with check (id = app.current_user_id());

-- No insert policy: accounts are created by the API through the service role,
-- after it has verified the JWT. A client inserting its own users row could
-- choose its own status.

-- --- user_auth_links: restricted, ZERO policies ------------------------------
--
-- The absence is the control. No client role can read or write this table; only
-- the service role and app.current_user_id() (SECURITY DEFINER) reach it.

-- --- user_consents: restricted, ZERO policies --------------------------------

-- --- user_settings: owner ----------------------------------------------------

grant select, update on public.user_settings to authenticated;

create policy user_settings_select_own
  on public.user_settings for select to authenticated
  using (user_id = app.current_user_id());

create policy user_settings_update_own
  on public.user_settings for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- --- user_devices: owner -----------------------------------------------------

grant select, update on public.user_devices to authenticated;

create policy user_devices_select_own
  on public.user_devices for select to authenticated
  using (user_id = app.current_user_id());

-- Update is limited to revocation; the API owns registration.
create policy user_devices_revoke_own
  on public.user_devices for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- --- security_events: system, read-own only ----------------------------------

grant select on public.security_events to authenticated;

create policy security_events_select_own
  on public.security_events for select to authenticated
  using (user_id = app.current_user_id());

-- Deliberately no insert, update or delete policy for any client role. An
-- append-only audit that a client can write is not an audit.

-- --- verification_status: owner-only in Phase 1 ------------------------------

grant select on public.verification_status to authenticated;

create policy verification_status_select_own
  on public.verification_status for select to authenticated
  using (user_id = app.current_user_id());
