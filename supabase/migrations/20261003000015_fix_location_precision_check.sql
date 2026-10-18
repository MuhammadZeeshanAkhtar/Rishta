-- =============================================================================
-- 0015 — location_precision could never be stored
--
-- Migration 0004 put two constraints on `profile_field_visibility` that cannot
-- both be satisfied for the same row:
--
--   profile_field_visibility_value_valid
--     check (visibility in ('public', 'matched_only', 'on_request', 'private'))
--
--   profile_field_visibility_location_precision
--     check (field_key <> 'location_precision'
--            or visibility in ('city', 'region', 'country'))
--
-- The second says a `location_precision` row must hold `city`, `region` or
-- `country`. The first says EVERY row must hold one of the four visibility
-- tiers. A `location_precision` row therefore has to be both at once, and no
-- value is in both sets — so no such row could be inserted at all, for anyone,
-- since Phase 3.
--
-- The comment above the second constraint had the intent exactly right:
-- "location_precision is a precision choice, not a visibility one." The first
-- constraint simply was not told. This narrows it to agree.
--
-- OBSERVED CONSEQUENCE. `/me/profile/visibility` lists `location_precision`
-- among its defaults and the Privacy Center renders a city/region/country
-- control for it, so saving that control failed with a check violation. It was
-- invisible until something tried to write a value other than the default,
-- because the default is never persisted — a missing row falls back in code.
--
-- Found by a Slice 5 test that set a candidate's precision to `country` to
-- prove the discovery card honours it.
-- =============================================================================

alter table public.profile_field_visibility
  drop constraint profile_field_visibility_value_valid;

alter table public.profile_field_visibility
  add constraint profile_field_visibility_value_valid check (
    -- Governed instead by profile_field_visibility_location_precision, which
    -- is the constraint that knows this key holds a precision.
    field_key = 'location_precision'
    or visibility in ('public', 'matched_only', 'on_request', 'private')
  );

comment on constraint profile_field_visibility_value_valid
  on public.profile_field_visibility is
  'The four visibility tiers, except for location_precision, which is a '
  'precision choice and carries its own constraint.';
