-- =============================================================================
-- 0016 — shortlists and dismissed_profiles
--
-- Phase 5 Slice 6, the owner-action half of Discovery (ERD §9). Both tables
-- record a decision the MEMBER made about someone else, which makes them the
-- first tables in this phase that members write directly.
--
-- OWNERSHIP IS ENFORCED HERE, NOT IN THE ROUTE. Every policy pins
-- `user_id = app.current_user_id()`, on INSERT as well as SELECT and DELETE,
-- so a member cannot record a shortlist or a dismissal in someone else's name
-- even if a handler forgot to check. The API is the convenient control; this
-- is the real one.
--
-- NO SERVICE ROLE PATH. Unlike `compatibility_scores` and `match_candidates`,
-- these are member-owned writes with nothing system-generated about them, so
-- they go through `db.asUser` and RLS is the whole guarantee.
--
-- `target_user_id` carries no FK-level visibility check — a block applied
-- after a shortlist was saved must not make the row unwritable or undeletable.
-- Whether a target may be SEEN is decided at read time by
-- `app.can_view_profile()`, which is where it belongs: a dismissal should
-- survive a block in both directions so that unblocking does not resurrect a
-- profile the member already said no to.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- shortlists — saved profiles
-- -----------------------------------------------------------------------------

create table public.shortlists (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete restrict,
  target_user_id uuid not null references public.users (id) on delete restrict,
  created_at     timestamptz not null default now(),

  constraint shortlists_not_self check (user_id <> target_user_id),
  -- Saving twice is the same statement made twice, not two facts. The
  -- uniqueness is what lets the endpoint be idempotent under a double tap.
  constraint shortlists_pair_key unique (user_id, target_user_id)
);

comment on table public.shortlists is
  'Profiles a member saved. Owner-only in both directions: the saved member is '
  'never told, so there is no read path for them.';

create index shortlists_user_idx on public.shortlists (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- dismissed_profiles — "not interested"
--
-- ERD §9: excluded from discovery PERMANENTLY, and never surfaced to the
-- dismissed party. Both halves matter. A dismissal that the other person could
-- detect would be a rejection notice, which is not what "not interested" means
-- and not something this product sends.
-- -----------------------------------------------------------------------------

create table public.dismissed_profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete restrict,
  target_user_id uuid not null references public.users (id) on delete restrict,
  created_at     timestamptz not null default now(),

  constraint dismissed_profiles_not_self check (user_id <> target_user_id),
  constraint dismissed_profiles_pair_key unique (user_id, target_user_id)
);

comment on table public.dismissed_profiles is
  'Permanently hidden from the owner discovery. Never visible to the dismissed '
  'member — a detectable dismissal is a rejection notice.';

-- The discovery read filters on this for every candidate, in both the feed and
-- the shortlist, so the lookup is by (owner, target) rather than by owner.
create index dismissed_profiles_pair_idx
  on public.dismissed_profiles (user_id, target_user_id);

-- =============================================================================
-- RLS — owner, and only the owner
--
-- No UPDATE policy and no UPDATE grant on either table. A row here has no
-- mutable field: a shortlist is added or removed, a dismissal is made or
-- undone. Allowing UPDATE would only create a way to move `user_id` or
-- `target_user_id`, which is to say a way to forge someone else's decision.
-- =============================================================================

select app.enable_rls('public.shortlists');
select app.enable_rls('public.dismissed_profiles');

grant all on public.shortlists to service_role;
grant all on public.dismissed_profiles to service_role;

grant select, insert, delete on public.shortlists to authenticated;
grant select, insert, delete on public.dismissed_profiles to authenticated;

create policy shortlists_select_own
  on public.shortlists for select to authenticated
  using (user_id = app.current_user_id());

create policy shortlists_insert_own
  on public.shortlists for insert to authenticated
  with check (user_id = app.current_user_id());

create policy shortlists_delete_own
  on public.shortlists for delete to authenticated
  using (user_id = app.current_user_id());

create policy dismissed_profiles_select_own
  on public.dismissed_profiles for select to authenticated
  using (user_id = app.current_user_id());

create policy dismissed_profiles_insert_own
  on public.dismissed_profiles for insert to authenticated
  with check (user_id = app.current_user_id());

create policy dismissed_profiles_delete_own
  on public.dismissed_profiles for delete to authenticated
  using (user_id = app.current_user_id());
