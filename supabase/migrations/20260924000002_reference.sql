-- =============================================================================
-- 0002 — reference data
--
-- Nineteen near-identical tables collapsed into one generic pair (ADR 0009).
-- This also matches the API contract already written: a single
-- GET /reference/:type, not nineteen endpoints.
--
-- Access class: public. Readable by everyone, writable by no client.
-- =============================================================================

create table public.reference_items (
  id            uuid primary key default gen_random_uuid(),
  type          text not null,
  code          text not null,
  parent_id     uuid references public.reference_items (id) on delete restrict,
  sort_order    integer not null default 0,
  metadata      jsonb not null default '{}'::jsonb,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint reference_items_type_valid check (type in (
    'country', 'region', 'city', 'language', 'education_level', 'field_of_study',
    'profession', 'industry', 'employment_status', 'marital_status',
    'religious_practice', 'sect', 'prayer_frequency', 'quran_level',
    'marriage_timeline', 'relocation_option', 'hobby', 'lifestyle_attribute',
    'personality_trait', 'dress_practice', 'diet', 'smoking'
  )),

  -- Codes are stable machine identifiers, never display strings. Storing
  -- "Bachelor's Degree" here would make the field untranslatable and break
  -- filtering across languages.
  constraint reference_items_code_shape check (code ~ '^[a-z][a-z0-9_]*$'),

  constraint reference_items_type_code_key unique (type, code)
);

-- Enables composite foreign keys from other tables, so a profile's
-- education_level cannot point at a country (ERD E2).
alter table public.reference_items
  add constraint reference_items_id_type_key unique (id, type);

create index reference_items_type_sort_idx
  on public.reference_items (type, sort_order)
  where active;

create index reference_items_parent_idx
  on public.reference_items (parent_id)
  where parent_id is not null;

comment on table public.reference_items is
  'Every coded list, keyed by (type, code). Adding an item is a data change.';
comment on column public.reference_items.code is
  'Stable machine identifier such as edu_bachelors. Never a display string.';

create trigger reference_items_touch
  before update on public.reference_items
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------

create table public.reference_translations (
  id                 uuid primary key default gen_random_uuid(),
  reference_item_id  uuid not null references public.reference_items (id) on delete cascade,
  locale             text not null,
  label              text not null,
  description        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint reference_translations_locale_shape
    check (locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$'),
  constraint reference_translations_item_locale_key unique (reference_item_id, locale)
);

comment on table public.reference_translations is
  'Localised labels. Adding a language is inserting rows, never a release.';

create trigger reference_translations_touch
  before update on public.reference_translations
  for each row execute function app.touch_updated_at();

-- `on delete cascade` here is deliberate and is the one place it appears in
-- Phase 1: a translation has no meaning without its item, and reference data
-- carries no personal data, so nothing of evidential value is lost.

-- -----------------------------------------------------------------------------
-- RLS — access class `public`
--
-- Enabled in the same migration that creates the table. No table ships without
-- it (README §9.5 non-negotiable 1).
-- -----------------------------------------------------------------------------

select app.enable_rls('public.reference_items');
select app.enable_rls('public.reference_translations');

grant select on public.reference_items to anon, authenticated;
grant select on public.reference_translations to anon, authenticated;

-- Explicit, in addition to the default privileges in 0001: service_role needs
-- table privileges as well as BYPASSRLS.
grant all on public.reference_items to service_role;
grant all on public.reference_translations to service_role;

create policy reference_items_read_active
  on public.reference_items
  for select
  to anon, authenticated
  using (active);

create policy reference_translations_read
  on public.reference_translations
  for select
  to anon, authenticated
  using (true);

-- No insert, update or delete policy exists for any client role.
-- Reference data is maintained through the admin surface using the service
-- role, which bypasses RLS.
