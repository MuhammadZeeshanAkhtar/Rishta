-- =============================================================================
-- 0004 — profile, location and partner preferences
--
-- The six tables Phase 3 needs, exactly as designed in docs/ERD.md §4, §6, §8.
-- Nothing from Phase 2 is altered: this file only creates.
--
-- Three conventions inherited from Phase 2, deliberately not re-litigated here:
--
--   1. Every table enables AND forces RLS in the migration that creates it.
--   2. `restricted` tables carry zero policies. The absence is the control.
--   3. Client roles reach a table only through an explicit GRANT, because 0001
--      revoked the platform's automatic ones. Grants below are COLUMN-level
--      wherever a table has state the owner must not write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — consolidated from six tables (ADR 0009)
--
-- Every reference code that drives a HARD filter carries a composite foreign
-- key (ERD E2), so a profile's education level cannot point at a country. The
-- `*_ref_type` columns are generated constants that exist only to make those
-- composite keys expressible; they are never read by the application.
-- -----------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references public.users (id) on delete restrict,

  -- --- free text -------------------------------------------------------------
  about_me     text,
  looking_for  text,

  -- --- basics ----------------------------------------------------------------
  nationality_code      char(2),
  nationality_ref_type  text generated always as ('country'::text) stored,
  languages             text[] not null default '{}',
  height_cm             integer,

  -- --- marriage --------------------------------------------------------------
  --
  -- marital_status_code is NOT NULL in the ERD. It is nullable here for the
  -- same reason the identity columns on `users` are: a profile is built over
  -- several screens and must survive a dropped connection mid-onboarding.
  -- profiles_complete_for_review below restores the invariant the moment the
  -- profile leaves 'draft', which is the point at which it could be seen.
  marital_status_code        text,
  marital_status_ref_type    text generated always as ('marital_status'::text) stored,
  has_children               boolean,
  children_count             integer,
  children_live_with_me      boolean,
  wants_children_code        text,
  marriage_timeline_code     text,
  marriage_timeline_ref_type text generated always as ('marriage_timeline'::text) stored,

  -- --- relocation ------------------------------------------------------------
  relocation_willingness_code     text,
  relocation_willingness_ref_type text generated always as ('relocation_option'::text) stored,
  relocation_target_countries     text[] not null default '{}',

  -- --- education -------------------------------------------------------------
  education_level_code     text,
  education_level_ref_type text generated always as ('education_level'::text) stored,
  field_of_study_code      text,
  institution              text,

  -- --- career ----------------------------------------------------------------
  profession_code      text,
  profession_ref_type  text generated always as ('profession'::text) stored,
  industry_code        text,
  employment_status_code text,

  -- --- religious -------------------------------------------------------------
  --
  -- sect_code is NULLABLE and that is load-bearing (A2). Null means "not
  -- stated", and a null must never be filtered out by someone else's sect
  -- preference unless they deliberately opt in — the guard for which is
  -- partner_preferences.exclude_unstated_sect, defaulting to false.
  religious_practice_code     text,
  religious_practice_ref_type text generated always as ('religious_practice'::text) stored,
  sect_code                   text,
  sect_ref_type               text generated always as ('sect'::text) stored,
  prayer_frequency_code       text,
  quran_level_code            text,
  dress_practice_code         text,

  -- --- family ----------------------------------------------------------------
  family_religiosity_code              text,
  living_with_family_expectation_code  text,
  family_background                    text,

  -- --- lifestyle -------------------------------------------------------------
  hobbies              text[] not null default '{}',
  lifestyle_attributes text[] not null default '{}',
  personality_traits   text[] not null default '{}',
  diet_code            text,
  smoking_code         text,

  -- --- state -----------------------------------------------------------------
  --
  -- Not writable by the owner: there are no column grants for these below, so
  -- a member cannot mark their own profile approved or inflate their score.
  completion_score int  not null default 0,
  review_status    text not null default 'draft',
  submitted_at     timestamptz,
  reviewed_at      timestamptz,
  rejection_reason_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint profiles_review_status_valid
    check (review_status in ('draft', 'pending', 'approved', 'rejected')),
  constraint profiles_completion_range
    check (completion_score between 0 and 100),
  constraint profiles_height_sane
    check (height_cm is null or height_cm between 120 and 250),
  constraint profiles_children_count_sane
    check (children_count is null or children_count between 0 and 20),
  constraint profiles_about_me_len
    check (about_me is null or char_length(about_me) <= 2000),
  constraint profiles_looking_for_len
    check (looking_for is null or char_length(looking_for) <= 2000),
  constraint profiles_family_background_len
    check (family_background is null or char_length(family_background) <= 2000),
  constraint profiles_institution_len
    check (institution is null or char_length(institution) <= 160),

  -- Children answers must agree with each other. "No children" plus a count of
  -- three is the kind of contradiction that quietly corrupts a filter.
  constraint profiles_children_consistent check (
    has_children is not true
    or children_count is null
    or children_count >= 0
  ),
  constraint profiles_no_children_has_no_count check (
    has_children is distinct from false
    or (children_count is null and children_live_with_me is null)
  ),

  -- The invariant, conditional on having left draft — the same shape as
  -- users_identity_complete in 0003.
  constraint profiles_complete_for_review check (
    review_status = 'draft'
    or (
      marital_status_code is not null
      and religious_practice_code is not null
      and about_me is not null
      and char_length(btrim(about_me)) >= 20
    )
  ),

  constraint profiles_nationality_fk
    foreign key (nationality_ref_type, nationality_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_marital_status_fk
    foreign key (marital_status_ref_type, marital_status_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_marriage_timeline_fk
    foreign key (marriage_timeline_ref_type, marriage_timeline_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_relocation_fk
    foreign key (relocation_willingness_ref_type, relocation_willingness_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_education_level_fk
    foreign key (education_level_ref_type, education_level_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_profession_fk
    foreign key (profession_ref_type, profession_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_religious_practice_fk
    foreign key (religious_practice_ref_type, religious_practice_code)
    references public.reference_items (type, code) on delete restrict,
  constraint profiles_sect_fk
    foreign key (sect_ref_type, sect_code)
    references public.reference_items (type, code) on delete restrict
);

comment on table public.profiles is
  'All discoverable attributes. One row per user, built across onboarding.';
comment on column public.profiles.sect_code is
  'Null means NOT STATED and must never be auto-excluded by another member''s '
  'filter (A2). The guard is partner_preferences.exclude_unstated_sect.';
comment on column public.profiles.review_status is
  'A profile is not discoverable until this is approved. Owner cannot write it.';

-- GIN on every array used by matching (A9): `&&` for "any shared language",
-- `@>` for "has all of". A btree index cannot answer either.
create index profiles_languages_idx on public.profiles using gin (languages);
create index profiles_hobbies_idx on public.profiles using gin (hobbies);
create index profiles_lifestyle_idx on public.profiles using gin (lifestyle_attributes);
create index profiles_traits_idx on public.profiles using gin (personality_traits);
create index profiles_relocation_countries_idx
  on public.profiles using gin (relocation_target_countries);

create index profiles_marital_status_idx on public.profiles (marital_status_code);
create index profiles_religious_practice_idx on public.profiles (religious_practice_code);
create index profiles_marriage_timeline_idx on public.profiles (marriage_timeline_code);
create index profiles_education_level_idx on public.profiles (education_level_code);

-- The discovery working set. Partial, because everything else is irrelevant to
-- the hottest read path in the product.
create index profiles_discoverable_idx
  on public.profiles (user_id)
  where review_status = 'approved' and deleted_at is null;

create trigger profiles_touch
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- profile_sensitive — the privacy boundary
--
-- Separate table rather than columns on `profiles` so that "hide my workplace"
-- is STRUCTURALLY true rather than a flag someone forgets to check. No
-- discovery query can reach it because no client can reach it at all.
-- -----------------------------------------------------------------------------

create table public.profile_sensitive (
  user_id        uuid primary key references public.users (id) on delete restrict,
  phone_e164     text,
  email          text,
  employer_name  text,
  workplace_city text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint profile_sensitive_phone_shape
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint profile_sensitive_email_shape
    check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

comment on table public.profile_sensitive is
  'Phone, email, employer, workplace. RESTRICTED: zero policies, service role only.';

create trigger profile_sensitive_touch
  before update on public.profile_sensitive
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- profile_field_visibility — the 14 controllable keys (ERD E6)
--
-- Applied by the API, not by RLS: RLS decides ROW visibility, this decides
-- FIELD visibility, and per-field RLS would need column grants that cannot
-- express "visible to matches only".
-- -----------------------------------------------------------------------------

create table public.profile_field_visibility (
  user_id    uuid not null references public.users (id) on delete restrict,
  field_key  text not null,
  visibility text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, field_key),

  constraint profile_field_visibility_key_valid check (field_key in (
    'profession', 'industry', 'employment_status', 'institution',
    'education_level', 'field_of_study', 'location_precision', 'height',
    'nationality', 'family_background', 'sect', 'children_details',
    'hobbies_and_lifestyle', 'about_me'
  )),
  constraint profile_field_visibility_value_valid
    check (visibility in ('public', 'matched_only', 'on_request', 'private')),

  -- Two keys are narrower than the general set, per E6. about_me cannot be
  -- hidden entirely — a profile with no words is not a profile — and
  -- location_precision is a precision choice, not a visibility one.
  constraint profile_field_visibility_about_me_limited check (
    field_key <> 'about_me' or visibility in ('public', 'matched_only')
  ),
  constraint profile_field_visibility_location_precision check (
    field_key <> 'location_precision' or visibility in ('city', 'region', 'country')
  )
);

create trigger profile_field_visibility_touch
  before update on public.profile_field_visibility
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- user_locations — what discovery reads
--
-- Coarse by construction. Exact coordinates live in user_geo, which is
-- restricted and arrives with PostGIS in a later phase.
-- -----------------------------------------------------------------------------

create table public.user_locations (
  user_id           uuid primary key references public.users (id) on delete restrict,
  country_code      char(2) not null,
  country_ref_type  text generated always as ('country'::text) stored,
  region_code       text,
  city_name         text,
  city_ref_id       uuid references public.reference_items (id) on delete set null,
  display_precision text not null default 'city',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint user_locations_precision_valid
    check (display_precision in ('city', 'region', 'country')),
  constraint user_locations_city_name_len
    check (city_name is null or char_length(city_name) <= 120),
  constraint user_locations_country_fk
    foreign key (country_ref_type, country_code)
    references public.reference_items (type, code) on delete restrict
);

comment on column public.user_locations.display_precision is
  'How exactly the member chooses to appear. Never overridden by the server.';

create index user_locations_country_region_idx
  on public.user_locations (country_code, region_code);

create trigger user_locations_touch
  before update on public.user_locations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- partner_preferences
-- -----------------------------------------------------------------------------

create table public.partner_preferences (
  user_id uuid primary key references public.users (id) on delete restrict,

  age_min       integer,
  age_max       integer,
  height_min_cm integer,
  height_max_cm integer,

  country_codes   text[] not null default '{}',
  max_distance_km integer,
  language_codes  text[] not null default '{}',

  education_level_codes text[] not null default '{}',
  profession_codes      text[] not null default '{}',

  religious_practice_codes text[] not null default '{}',
  sect_codes               text[] not null default '{}',

  -- The A2 guard, in the schema. Someone who states a sect preference still
  -- sees profiles that left it blank unless they deliberately opt out —
  -- silence must not cost a person visibility.
  exclude_unstated_sect boolean not null default false,

  marital_status_codes    text[] not null default '{}',
  accepts_children        boolean,
  wants_children_codes    text[] not null default '{}',
  marriage_timeline_codes text[] not null default '{}',

  relocation_required      boolean,
  living_with_family_codes text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 18 is the product's floor and is enforced on `users` by a trigger; a
  -- preference that reaches below it could only ever match nobody.
  constraint partner_preferences_age_min_floor
    check (age_min is null or age_min >= 18),
  constraint partner_preferences_age_max_ceiling
    check (age_max is null or age_max <= 120),
  constraint partner_preferences_age_range
    check (age_min is null or age_max is null or age_min <= age_max),
  constraint partner_preferences_height_range
    check (height_min_cm is null or height_max_cm is null or height_min_cm <= height_max_cm),
  constraint partner_preferences_distance_sane
    check (max_distance_km is null or max_distance_km between 1 and 20000)
);

comment on column public.partner_preferences.exclude_unstated_sect is
  'A2 guard. FALSE by default: a blank sect must not make someone invisible.';

-- GIN on the arrays the reverse-match (reciprocity) query filters by.
create index partner_preferences_countries_idx
  on public.partner_preferences using gin (country_codes);
create index partner_preferences_languages_idx
  on public.partner_preferences using gin (language_codes);
create index partner_preferences_marital_idx
  on public.partner_preferences using gin (marital_status_codes);
create index partner_preferences_religious_idx
  on public.partner_preferences using gin (religious_practice_codes);

create trigger partner_preferences_touch
  before update on public.partner_preferences
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- preference_rules — hard filters versus ranking weights
-- -----------------------------------------------------------------------------

create table public.preference_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete restrict,
  criterion  text not null,
  is_hard    boolean not null default false,
  weight     numeric(3, 2) not null default 0.5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint preference_rules_weight_range check (weight >= 0 and weight <= 1),
  constraint preference_rules_criterion_shape check (criterion ~ '^[a-z][a-z0-9_]*$'),
  constraint preference_rules_user_criterion_key unique (user_id, criterion)
);

comment on table public.preference_rules is
  'Hard filters EXCLUDE; soft preferences only rank. Drives filter-vs-rank.';

create trigger preference_rules_touch
  before update on public.preference_rules
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

select app.enable_rls('public.profiles');
select app.enable_rls('public.profile_sensitive');
select app.enable_rls('public.profile_field_visibility');
select app.enable_rls('public.user_locations');
select app.enable_rls('public.partner_preferences');
select app.enable_rls('public.preference_rules');

-- service_role: BYPASSRLS handles rows, these handle table privileges.
grant all on public.profiles to service_role;
grant all on public.profile_sensitive to service_role;
grant all on public.profile_field_visibility to service_role;
grant all on public.user_locations to service_role;
grant all on public.partner_preferences to service_role;
grant all on public.preference_rules to service_role;

-- --- profiles ----------------------------------------------------------------
--
-- OWNER-ONLY, deliberately.
--
-- ERD §4 specifies `shared` via app.can_view_profile(), and that is still the
-- destination. It cannot be written yet: the predicate depends on blocks,
-- interests and matches, none of which exist until Phase 6. Shipping a
-- permissive cross-user policy now — or a placeholder that returns true —
-- would expose every profile the moment the first two members exist.
--
-- Deny-by-default until the tables the real predicate needs are here.

grant select on public.profiles to authenticated;

-- Column-level. review_status, completion_score, submitted_at, reviewed_at and
-- rejection_reason_key are absent from both lists: the server owns them, and a
-- member who could set review_status = 'approved' would be discoverable
-- without ever passing review.
grant insert (
  user_id, about_me, looking_for, nationality_code, languages, height_cm,
  marital_status_code, has_children, children_count, children_live_with_me,
  wants_children_code, marriage_timeline_code, relocation_willingness_code,
  relocation_target_countries, education_level_code, field_of_study_code,
  institution, profession_code, industry_code, employment_status_code,
  religious_practice_code, sect_code, prayer_frequency_code, quran_level_code,
  dress_practice_code, family_religiosity_code,
  living_with_family_expectation_code, family_background, hobbies,
  lifestyle_attributes, personality_traits, diet_code, smoking_code
) on public.profiles to authenticated;

grant update (
  about_me, looking_for, nationality_code, languages, height_cm,
  marital_status_code, has_children, children_count, children_live_with_me,
  wants_children_code, marriage_timeline_code, relocation_willingness_code,
  relocation_target_countries, education_level_code, field_of_study_code,
  institution, profession_code, industry_code, employment_status_code,
  religious_practice_code, sect_code, prayer_frequency_code, quran_level_code,
  dress_practice_code, family_religiosity_code,
  living_with_family_expectation_code, family_background, hobbies,
  lifestyle_attributes, personality_traits, diet_code, smoking_code
) on public.profiles to authenticated;

create policy profiles_select_own
  on public.profiles for select to authenticated
  using (user_id = app.current_user_id() and deleted_at is null);

create policy profiles_insert_own
  on public.profiles for insert to authenticated
  with check (user_id = app.current_user_id());

create policy profiles_update_own
  on public.profiles for update to authenticated
  using (user_id = app.current_user_id() and deleted_at is null)
  with check (user_id = app.current_user_id());

-- No delete policy. A profile is soft-deleted through the account deletion
-- workflow, which carries a grace period and retention holds (E1).

-- --- profile_sensitive: restricted, ZERO policies -----------------------------
--
-- No grant, no policy, no client path. Reachable only by the service role,
-- from the enumerated call sites in docs/SERVICE_ROLE_USAGE.md.

-- --- profile_field_visibility: owner ------------------------------------------

grant select on public.profile_field_visibility to authenticated;
grant insert (user_id, field_key, visibility) on public.profile_field_visibility to authenticated;
grant update (visibility) on public.profile_field_visibility to authenticated;
grant delete on public.profile_field_visibility to authenticated;

create policy profile_field_visibility_select_own
  on public.profile_field_visibility for select to authenticated
  using (user_id = app.current_user_id());

create policy profile_field_visibility_insert_own
  on public.profile_field_visibility for insert to authenticated
  with check (user_id = app.current_user_id());

create policy profile_field_visibility_update_own
  on public.profile_field_visibility for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- Delete is permitted here, unlike everywhere else: removing a row restores
-- the default visibility for that field. It destroys no history.
create policy profile_field_visibility_delete_own
  on public.profile_field_visibility for delete to authenticated
  using (user_id = app.current_user_id());

-- --- user_locations: owner-only for now ---------------------------------------
--
-- ERD §6 marks this `shared`, for the same reason and with the same blocker as
-- profiles. Owner-only until the permission predicate exists.

grant select on public.user_locations to authenticated;
grant insert (user_id, country_code, region_code, city_name, city_ref_id, display_precision)
  on public.user_locations to authenticated;
grant update (country_code, region_code, city_name, city_ref_id, display_precision)
  on public.user_locations to authenticated;

create policy user_locations_select_own
  on public.user_locations for select to authenticated
  using (user_id = app.current_user_id());

create policy user_locations_insert_own
  on public.user_locations for insert to authenticated
  with check (user_id = app.current_user_id());

create policy user_locations_update_own
  on public.user_locations for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- --- partner_preferences: owner -----------------------------------------------

grant select on public.partner_preferences to authenticated;
grant insert (
  user_id, age_min, age_max, height_min_cm, height_max_cm, country_codes,
  max_distance_km, language_codes, education_level_codes, profession_codes,
  religious_practice_codes, sect_codes, exclude_unstated_sect,
  marital_status_codes, accepts_children, wants_children_codes,
  marriage_timeline_codes, relocation_required, living_with_family_codes
) on public.partner_preferences to authenticated;
grant update (
  age_min, age_max, height_min_cm, height_max_cm, country_codes,
  max_distance_km, language_codes, education_level_codes, profession_codes,
  religious_practice_codes, sect_codes, exclude_unstated_sect,
  marital_status_codes, accepts_children, wants_children_codes,
  marriage_timeline_codes, relocation_required, living_with_family_codes
) on public.partner_preferences to authenticated;

create policy partner_preferences_select_own
  on public.partner_preferences for select to authenticated
  using (user_id = app.current_user_id());

create policy partner_preferences_insert_own
  on public.partner_preferences for insert to authenticated
  with check (user_id = app.current_user_id());

create policy partner_preferences_update_own
  on public.partner_preferences for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- --- preference_rules: owner --------------------------------------------------

grant select on public.preference_rules to authenticated;
grant insert (user_id, criterion, is_hard, weight) on public.preference_rules to authenticated;
grant update (is_hard, weight) on public.preference_rules to authenticated;
grant delete on public.preference_rules to authenticated;

create policy preference_rules_select_own
  on public.preference_rules for select to authenticated
  using (user_id = app.current_user_id());

create policy preference_rules_insert_own
  on public.preference_rules for insert to authenticated
  with check (user_id = app.current_user_id());

create policy preference_rules_update_own
  on public.preference_rules for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy preference_rules_delete_own
  on public.preference_rules for delete to authenticated
  using (user_id = app.current_user_id());
