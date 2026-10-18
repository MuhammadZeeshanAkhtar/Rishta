-- =============================================================================
-- 0009 — English only
--
-- Urdu was a launch locale (ADR 0010) and has been removed from the product,
-- along with all right-to-left handling. This migration removes it from the
-- data, which is the only place the database carried it.
--
-- No schema change was needed. Both locale columns were always validated by
-- SHAPE rather than by an enum —
--
--   reference_translations_locale_shape  check (locale ~ '^[a-z]{2}(-...)?$')
--   user_settings_locale_shape           check (locale ~ '^[a-z]{2}(-...)?$')
--
-- so nothing in the schema ever named Urdu. That is why this is a data
-- migration plus a narrowing constraint, and why no already-applied migration
-- had to be edited: 0002 and 0003 are still correct as written.
--
-- 0005 seeds both `en` and `ur`. It is left exactly as it was — a migration is
-- a record of what happened, not a document to be revised — so on a fresh
-- database 0005 inserts both locales and this migration removes the Urdu rows
-- immediately afterwards. The end state is identical to an existing database,
-- which is the property that makes the two reproducible from one ledger.
--
-- The Urdu labels are therefore not lost: they remain in 0005 and can be
-- restored by a later migration if the locale comes back.
--
-- TO ADD A LOCALE LATER: drop the two constraints below, then seed its
-- translations. They exist so a locale returns deliberately, as a migration,
-- rather than by a stray INSERT that no client has a catalog for.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

delete from public.reference_translations where locale <> 'en';

alter table public.reference_translations
  add constraint reference_translations_locale_supported
  check (locale = 'en');

comment on constraint reference_translations_locale_supported
  on public.reference_translations is
  'The product ships in English only. Drop this constraint to add a locale.';

-- ---------------------------------------------------------------------------
-- Stored account preference
--
-- Anyone who had chosen Urdu is moved to English rather than left pointing at
-- a catalog that no longer exists. The API also narrows this value on read
-- (routes/account.ts), so a row written before this migration can never reach
-- a client as an unsupported locale.
-- ---------------------------------------------------------------------------

update public.user_settings set locale = 'en' where locale <> 'en';

alter table public.user_settings
  add constraint user_settings_locale_supported
  check (locale = 'en');

comment on constraint user_settings_locale_supported
  on public.user_settings is
  'The product ships in English only. Drop this constraint to add a locale.';
