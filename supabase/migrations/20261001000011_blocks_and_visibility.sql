-- =============================================================================
-- 0011 — blocks, the shared predicates, and cross-user visibility
--
-- Phase 5 Slice 1. This is the migration every earlier phase deferred to.
--
-- 0004 and 0006 both shipped `profiles` and `photos` as OWNER-ONLY and said
-- why in the file: ERD §4 specifies `shared` via app.can_view_profile(), the
-- predicate needs `blocks`, and shipping a permissive policy — or a
-- placeholder returning true — would expose every profile and every photo the
-- moment a second member existed. `blocks` is therefore pulled forward out of
-- Phase 6: it is not a safety feature that happens to be useful here, it is
-- the thing the visibility predicate is built on.
--
-- WHAT THIS DOES NOT DO. Field-level and media-tier filtering stay in the API
-- (ERD §2.3: "Field-level filtering is not done in RLS"). RLS decides which
-- ROWS exist for a caller; `profile_field_visibility` and the photo tiers
-- decide what is rendered from them. `user_locations` stays owner-only — see
-- the note at the bottom.
--
-- RECURSION. Every predicate is `security definer`, so a policy never invokes
-- another table's policy (ERD §2.4 non-negotiable 4). They are `stable` so
-- Postgres evaluates them once per statement rather than once per row, which
-- matters: `can_view_profile` runs on every row of every discovery query.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- blocks
--
-- `relationship_id` from ERD §14 is deliberately ABSENT. It references
-- `family_relationships`, which does not exist until Phase 6b, and a uuid
-- column with no referent is worse than no column. `acted_by_user_id` IS here:
-- it points at `users`, which exists, and ADR 0011's `block_on_behalf` needs
-- the block and its actor recorded together from the first row written.
-- -----------------------------------------------------------------------------

create table public.blocks (
  id              uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references public.users (id) on delete restrict,
  blocked_user_id uuid not null references public.users (id) on delete restrict,
  reason_code     text,
  -- Null means the owner acted. Set means a delegate did, and the block still
  -- belongs to `blocker_user_id` (ADR 0011 A7).
  acted_by_user_id uuid references public.users (id) on delete restrict,
  created_at      timestamptz not null default now(),

  constraint blocks_not_self check (blocker_user_id <> blocked_user_id),
  constraint blocks_reason_shape
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]*$'),
  constraint blocks_pair_key unique (blocker_user_id, blocked_user_id)
);

comment on table public.blocks is
  'Bidirectional in EFFECT, directional in storage: one row means neither party '
  'sees the other. The blocked party has no read path to this table at all.';

-- The reverse-direction index. `app.is_blocked()` checks BOTH directions on
-- every shared read, so without this the blocked_user_id half is a seq scan on
-- the hottest predicate in the schema.
create index blocks_blocked_idx on public.blocks (blocked_user_id);

-- =============================================================================
-- The shared predicates (ERD §2.3)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app.is_blocked — BIDIRECTIONAL
--
-- ERD §2.3 calls a one-directional check "the single most likely policy bug in
-- this schema", which is why this exists as one function every policy calls
-- rather than a condition re-expressed per table. A blocks B means B also
-- cannot see A; the blocked party must not be able to detect the block, and
-- the only way to guarantee that everywhere is to check both halves here.
-- -----------------------------------------------------------------------------

create or replace function app.is_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.blocks
    where (blocker_user_id = a and blocked_user_id = b)
       or (blocker_user_id = b and blocked_user_id = a)
  )
$$;

comment on function app.is_blocked(uuid, uuid) is
  'True when EITHER party has blocked the other. Checking one direction is the '
  'most likely policy bug in this schema, so it lives in exactly one place.';

revoke all on function app.is_blocked(uuid, uuid) from public;
grant execute on function app.is_blocked(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- app.relationship — the viewer's standing relative to a target
--
-- ERD §2.3 defines the full range as
--   'self' | 'stranger' | 'interest_pending' | 'match' | 'own_wali'
--   | 'counterpart_wali' | 'blocked'
--
-- Only self / blocked / stranger are REACHABLE today, because `interests`,
-- `matches` and the family tables do not exist yet. Returning a state whose
-- table is absent would be a lie the visibility system is built on, so the
-- others are simply not produced.
--
-- EXTENDING THIS IN PHASE 6 is an insertion at the marked point, not a
-- rewrite. Order is the contract:
--
--   self > blocked > match > interest_pending > stranger
--
-- `blocked` must stay above `match`: a block applied after a match has to win,
-- or blocking someone you matched with does nothing. And because every state
-- Phase 6 adds is strictly NARROWER than 'stranger', inserting them can only
-- ever grant more to people who already had the baseline — it cannot widen a
-- decision that is already false.
-- -----------------------------------------------------------------------------

create or replace function app.relationship(viewer uuid, target uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when viewer is null or target is null then 'stranger'
    when viewer = target                  then 'self'
    when app.is_blocked(viewer, target)   then 'blocked'
    -- PHASE 6 INSERTION POINT — 'match', then 'interest_pending'.
    -- PHASE 6b INSERTION POINT — 'own_wali', 'counterpart_wali'.
    else 'stranger'
  end
$$;

comment on function app.relationship(uuid, uuid) is
  'Viewer standing: self | blocked | stranger today. Phase 6 adds match and '
  'interest_pending at the marked point; blocked must remain above both.';

revoke all on function app.relationship(uuid, uuid) from public;
grant execute on function app.relationship(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- app.can_view_profile — may `viewer` see `target` at all
--
-- Row visibility only. What is RENDERED from a visible row is decided by
-- `profile_field_visibility` in the API.
--
-- Three refusals, in order:
--   1. No viewer at all. `app.current_user_id()` is NULL for anon, and a NULL
--      viewer must never fall through to the discoverability test — that would
--      make every approved profile world-readable through any path that
--      forgets `to authenticated`. Belt and braces with the policy's role.
--   2. Blocked, in either direction.
--   3. Not discoverable: the target must be an active, non-deleted account
--      whose profile has passed review. A `draft`, `pending` or `rejected`
--      profile is invisible to everyone but its owner, which is what keeps an
--      unfinished profile out of Discover.
--
-- Self short-circuits to true BEFORE the review test, so a member always sees
-- their own profile while it is still a draft. That also keeps UPDATE working
-- under FORCE RLS, where the row an UPDATE produces must remain visible to the
-- SELECT policy (the lesson migration 0008 records).
-- -----------------------------------------------------------------------------

create or replace function app.can_view_profile(viewer uuid, target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when viewer is null then false
    else case app.relationship(viewer, target)
      when 'self'    then true
      when 'blocked' then false
      else exists (
        select 1
        from public.users u
        join public.profiles p on p.user_id = u.id
        where u.id = target
          and u.status = 'active'
          and u.deleted_at is null
          and p.deleted_at is null
          and p.review_status = 'approved'
      )
    end
  end
$$;

comment on function app.can_view_profile(uuid, uuid) is
  'Row-level visibility of one member to another. Owner always; blocked never; '
  'everyone else only for an active account with an approved profile.';

revoke all on function app.can_view_profile(uuid, uuid) from public;
grant execute on function app.can_view_profile(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- app.can_view_photo — the same decision, plus the media rules
--
-- A fourth function rather than the condition written twice. `photos` and
-- `photo_variants` must agree exactly; two copies of this rule is how a
-- variant stays readable after its parent stops being. The ERD makes the same
-- argument for `is_blocked`, and photos are the highest-severity leak in the
-- product (R5), so it applies with more force here.
--
-- Two media rules on top of profile visibility:
--   * `private` is not a tier the API filters — it is a statement that no one
--     else may hold the row. Enforced here rather than trusted to a handler.
--   * An unapproved photo never reaches another member. `pending` means not
--     yet checked, and the whole point of the moderation hook is that nothing
--     escapes before it runs.
-- `blurred` and `on_request` stay row-visible on purpose: the API decides
-- which variant to sign, and `on_request` needs the row to offer a request at
-- all. That is the field-level half, and it is the API's job.
-- -----------------------------------------------------------------------------

create or replace function app.can_view_photo(viewer uuid, photo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.photos p
    where p.id = photo_id
      and p.deleted_at is null
      and (
        p.user_id = viewer
        or (
          p.visibility <> 'private'
          and p.moderation_status = 'approved'
          and app.can_view_profile(viewer, p.user_id)
        )
      )
  )
$$;

comment on function app.can_view_photo(uuid, uuid) is
  'Photo row visibility. Owner sees every own photo; others only an approved, '
  'non-private photo on a profile they may view.';

revoke all on function app.can_view_photo(uuid, uuid) from public;
grant execute on function app.can_view_photo(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- blocks RLS — owner, and ONLY the blocker
--
-- The blocked party gets no read path whatsoever. Being able to list rows
-- where you are `blocked_user_id` would make the block detectable, and a
-- detectable block is a retaliation trigger. `app.is_blocked()` is security
-- definer precisely so the predicate can see what the blocked party cannot.
--
-- No UPDATE policy: a block is created or removed, never edited.
-- =============================================================================

select app.enable_rls('public.blocks');

grant all on public.blocks to service_role;
grant select, insert, delete on public.blocks to authenticated;

create policy blocks_select_own
  on public.blocks for select to authenticated
  using (blocker_user_id = app.current_user_id());

create policy blocks_insert_own
  on public.blocks for insert to authenticated
  with check (blocker_user_id = app.current_user_id());

create policy blocks_delete_own
  on public.blocks for delete to authenticated
  using (blocker_user_id = app.current_user_id());

-- =============================================================================
-- profiles — owner-only SELECT becomes shared
--
-- The write policies are untouched. Only SELECT widens; INSERT and UPDATE stay
-- `user_id = app.current_user_id()`, and there is still no DELETE policy.
-- =============================================================================

drop policy profiles_select_own on public.profiles;

create policy profiles_select_visible
  on public.profiles for select to authenticated
  using (
    deleted_at is null
    and app.can_view_profile(app.current_user_id(), user_id)
  );

-- =============================================================================
-- photos and photo_variants
--
-- Same change, same shape. Owner behaviour is preserved inside
-- `app.can_view_photo`, so soft delete keeps working: the UPDATE policy is
-- unchanged and the owner's row stays visible to SELECT.
-- =============================================================================

drop policy photos_select_own on public.photos;

create policy photos_select_visible
  on public.photos for select to authenticated
  using (app.can_view_photo(app.current_user_id(), id));

drop policy photo_variants_select_own on public.photo_variants;

create policy photo_variants_select_visible
  on public.photo_variants for select to authenticated
  using (app.can_view_photo(app.current_user_id(), photo_id));

-- =============================================================================
-- user_locations — DELIBERATELY STILL OWNER-ONLY
--
-- Not an oversight. `user_locations.display_precision` is a per-member choice
-- between exact, city, region and country, and honouring it means returning a
-- DIFFERENT value to different viewers — coarsening a city to a country, not
-- hiding a row. RLS cannot express that; it decides whether a row exists.
--
-- Opening this table now would hand every viewer the stored city regardless of
-- the precision its owner chose, which is the privacy promise Phase 3 made and
-- the Privacy Center shows. The distance dimension and the coarsened read
-- belong to the scoring slice, which reaches this table through the service
-- role and applies precision on the way out.
-- =============================================================================
