-- =============================================================================
-- 0013 — user_entitlements
--
-- Phase 5 Slice 2. ADR 0005: the entitlement abstraction ships in v1 with money
-- switched off, so adding payments in 1.2 touches billing rather than feature
-- code. Feature code asks `can(user, key)` and never asks whether someone is
-- premium.
--
-- WHAT THIS TABLE IS, AND IS NOT.
--
-- It holds per-user OVERRIDES, not every user's full entitlement set. The free
-- plan is not stored here: `FREE_PLAN_ENTITLEMENTS` in @nikahmate/domain is
-- documented as seeded into `plan_entitlements`, which is an M2 table that does
-- not exist yet. Until it does, the free plan is the code-level default and
-- this table records only what differs from it — a grant, a promo, or a plan
-- that is not the free one.
--
-- That is why there is no backfill and no change to account bootstrap. Three
-- consequences worth stating, because the alternative looks tempting:
--
--   * Materialising five rows per member at signup would freeze the free plan
--     at the moment each account was created. Changing a free-plan default
--     would then need a data migration across every user, and any account
--     missed would silently keep the old value.
--   * A missing row is not an error. `can()` falls back to the free plan, so a
--     member with no rows at all is a correctly-provisioned free member.
--   * When M2 adds `plans` and `plan_entitlements`, the fallback moves from a
--     constant to a table lookup inside the same resolver. Feature code does
--     not change, which is the entire point of the abstraction.
--
-- `value` is jsonb because entitlements are not all booleans: `daily_interests`
-- is a number and the rest are flags. One column, both shapes, no second table.
-- =============================================================================

create table public.user_entitlements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete restrict,
  entitlement_key text not null,
  value           jsonb not null,
  -- ERD §16. `plan` is what a subscription confers, `grant` is a manual
  -- override by an operator, `promo` is time-boxed marketing.
  source          text not null default 'grant',
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Closed, like `review_status` and `users.status`. An entitlement whose key
  -- is a typo would never match anything and would never raise an error — it
  -- would simply not apply, which is the kind of failure nobody notices.
  constraint user_entitlements_key_valid check (
    entitlement_key in (
      'daily_interests', 'advanced_filters', 'who_viewed_me', 'incognito', 'profile_boost'
    )
  ),
  constraint user_entitlements_source_valid
    check (source in ('plan', 'grant', 'promo')),
  -- Booleans and numbers only. A string or an object here would be a value the
  -- resolver cannot compare, and it would reach it as a silent `false`.
  constraint user_entitlements_value_shape
    check (jsonb_typeof(value) in ('boolean', 'number')),
  constraint user_entitlements_user_key_key unique (user_id, entitlement_key)
);

comment on table public.user_entitlements is
  'Per-user entitlement OVERRIDES. The free plan is the code-level default '
  '(FREE_PLAN_ENTITLEMENTS); a member with no rows here is a free member.';

comment on column public.user_entitlements.value is
  'Boolean for a flag, number for a limit. jsonb so one column carries both.';

comment on column public.user_entitlements.expires_at is
  'Null means it does not expire. An expired row is ignored by the resolver '
  'rather than deleted, so a promo that lapsed is still auditable.';

create index user_entitlements_user_idx on public.user_entitlements (user_id);

create trigger user_entitlements_touch
  before update on public.user_entitlements
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS — owner reads, service role writes (ERD §16)
--
-- The grant list is the control here, not the policy. `authenticated` gets
-- SELECT and nothing else: a member who could INSERT into this table would
-- grant themselves `who_viewed_me`, and one who could UPDATE would raise their
-- own `daily_interests`. There is deliberately no INSERT, UPDATE or DELETE
-- policy for members, because there is no privilege for one to govern.
--
-- Writes go through `db.asService('entitlement.grant', …)`, which is the
-- compiler-enforced allowlist in services/api/src/db/types.ts.
-- =============================================================================

select app.enable_rls('public.user_entitlements');

grant all on public.user_entitlements to service_role;
grant select on public.user_entitlements to authenticated;

create policy user_entitlements_select_own
  on public.user_entitlements for select to authenticated
  using (user_id = app.current_user_id());
