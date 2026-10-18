-- =============================================================================
-- 0014 — compatibility_scores, compatibility_factors, match_candidates
--
-- Phase 5 Slice 4. Storage for the deterministic engine (ADR 0001) and the
-- precomputed candidate sets the Discovery API will read from.
--
-- ALL THREE ARE `system` TABLES (ERD §2.2): inserted and updated by the
-- service role only, with the owner permitted to read their own rows. A member
-- who could write any of them would place themselves in someone else's
-- Discover feed, raise their own score, or author an "explanation" the engine
-- never produced — and the last of those would quietly destroy the property
-- the whole scoring design exists to guarantee.
--
-- Read access is asymmetric on purpose: the VIEWER may read scores computed
-- FOR them, and nobody may read the scores computed ABOUT them. A member who
-- could list `candidate_user_id = me` would learn who is being shown their
-- profile and what the engine thinks of them, which is neither theirs to know
-- nor something the product promises.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- compatibility_scores
--
-- DIRECTIONAL (ERD §9). A's score for B differs from B's for A because the
-- preferences differ; storing one row per unordered pair would mean one of the
-- two people is shown someone else's answer.
--
-- `engine_version` is not optional. Without it, "why did my matches change?"
-- has no answer and two sets of weights cannot be compared against real accept
-- rates (ADR 0001, ERD E4).
-- -----------------------------------------------------------------------------

create table public.compatibility_scores (
  id                 uuid primary key default gen_random_uuid(),
  viewer_user_id     uuid not null references public.users (id) on delete restrict,
  candidate_user_id  uuid not null references public.users (id) on delete restrict,
  overall            numeric(5, 2) not null,
  engine_version     text not null,
  computed_at        timestamptz not null default now(),

  constraint compatibility_scores_not_self
    check (viewer_user_id <> candidate_user_id),
  constraint compatibility_scores_overall_range
    check (overall >= 0 and overall <= 100),
  constraint compatibility_scores_pair_key
    unique (viewer_user_id, candidate_user_id)
);

comment on table public.compatibility_scores is
  'Directional compatibility. One row per (viewer, candidate) ordered pair, '
  'produced by the engine at engine_version.';

-- The ranking read: one viewer's candidates, best first.
create index compatibility_scores_viewer_overall_idx
  on public.compatibility_scores (viewer_user_id, overall desc);

-- -----------------------------------------------------------------------------
-- compatibility_factors — what makes D6 work
--
-- `facts` stores the values ACTUALLY COMPARED, which is why an explanation is
-- truthful rather than plausible: the reason shown is regenerated from the
-- comparison rather than narrated after it. It is also the only way to
-- investigate a complaint months later.
--
-- `weight` and `is_hard` go beyond the ERD column list. They are stored
-- because the engine's answer is not reproducible without them: a sub-score
-- says what one dimension concluded, and only the weight explains how much it
-- moved the overall. `is_hard` records which criteria were deal-breakers at
-- the moment of scoring, so a later audit can tell a filter decision from a
-- scoring one.
--
-- `sub_score` is nullable, and that is meaningful rather than sloppy: null
-- means the dimension found nothing to compare. The engine excludes those from
-- the mean instead of scoring them zero, because a missing optional field
-- should make a profile look UNKNOWN, not incompatible.
-- -----------------------------------------------------------------------------

create table public.compatibility_factors (
  id              uuid primary key default gen_random_uuid(),
  score_id        uuid not null references public.compatibility_scores (id) on delete cascade,
  dimension       text not null,
  sub_score       numeric(5, 2),
  weight          numeric(6, 4) not null,
  is_hard         boolean not null default false,
  facts           jsonb not null default '{}'::jsonb,
  explanation_key text not null,
  created_at      timestamptz not null default now(),

  -- The 11 confirmed dimensions. `personality` is deliberately absent: README
  -- prose lists it, the ERD enumeration does not, and the ERD is
  -- authoritative. A row naming it would mean the engine and the schema
  -- disagree about what was scored.
  constraint compatibility_factors_dimension_valid check (
    dimension in (
      'religious', 'timeline', 'relocation', 'children', 'family',
      'language', 'location', 'education', 'profession', 'lifestyle',
      'reciprocity'
    )
  ),
  constraint compatibility_factors_sub_score_range
    check (sub_score is null or (sub_score >= 0 and sub_score <= 100)),
  constraint compatibility_factors_weight_range
    check (weight >= 0),
  -- An explanation with no facts behind it is the exact failure this table
  -- exists to prevent, so the shape is enforced rather than trusted.
  constraint compatibility_factors_facts_object
    check (jsonb_typeof(facts) = 'object'),
  -- One row per dimension per score. Two rows for `reciprocity` would double
  -- its weight silently, which is the mistake the model is most careful about.
  constraint compatibility_factors_score_dimension_key
    unique (score_id, dimension)
);

comment on table public.compatibility_factors is
  'The facts behind each sub-score. Makes explanations regenerable and '
  'complaints investigable (ADR 0001).';

comment on column public.compatibility_factors.sub_score is
  'Null means the dimension had nothing to compare, and is excluded from the '
  'overall rather than counted as zero.';

create index compatibility_factors_score_idx
  on public.compatibility_factors (score_id);

-- -----------------------------------------------------------------------------
-- match_candidates — precomputed section membership
--
-- `batch_id` is what makes regeneration atomic (ERD §9). A generation writes a
-- new batch and deletes the previous one inside one transaction, so a reader
-- never sees a half-built section: either every row is the old batch or every
-- row is the new one. Deleting first and inserting after would leave a window
-- in which a member's Discover feed is empty.
-- -----------------------------------------------------------------------------

create table public.match_candidates (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete restrict,
  candidate_user_id uuid not null references public.users (id) on delete restrict,
  section_key       text not null,
  rank              integer not null,
  batch_id          uuid not null,
  created_at        timestamptz not null default now(),

  constraint match_candidates_not_self
    check (user_id <> candidate_user_id),
  constraint match_candidates_rank_positive
    check (rank >= 0),
  constraint match_candidates_section_valid check (
    section_key in (
      'recommended', 'highly_compatible', 'nearby', 'verified',
      'recently_joined', 'same_language', 'same_country', 'open_to_relocation'
    )
  ),
  -- A candidate appears at most once per section per viewer.
  constraint match_candidates_member_key
    unique (user_id, section_key, candidate_user_id)
);

comment on table public.match_candidates is
  'Precomputed, ranked section membership. Replaced atomically per batch_id; '
  'blocks and dismissals are re-applied on read, never trusted from here.';

comment on column public.match_candidates.batch_id is
  'One generation run. The new batch is written and the old deleted in the '
  'same transaction, so a section is never observed half-built.';

-- The section read: one viewer, one section, in order.
create index match_candidates_section_idx
  on public.match_candidates (user_id, section_key, rank);
-- The atomic swap.
create index match_candidates_batch_idx on public.match_candidates (batch_id);

-- =============================================================================
-- RLS
--
-- No INSERT, UPDATE or DELETE privilege for `authenticated` on any of the
-- three. As with `user_entitlements`, the grant is the control and the absence
-- of a write policy is deliberate — there is no privilege for one to govern.
-- =============================================================================

select app.enable_rls('public.compatibility_scores');
select app.enable_rls('public.compatibility_factors');
select app.enable_rls('public.match_candidates');

grant all on public.compatibility_scores to service_role;
grant all on public.compatibility_factors to service_role;
grant all on public.match_candidates to service_role;

grant select on public.compatibility_scores to authenticated;
grant select on public.compatibility_factors to authenticated;
grant select on public.match_candidates to authenticated;

-- A member reads the scores computed FOR them, never the ones computed ABOUT
-- them. The second would disclose who is being shown their profile.
create policy compatibility_scores_select_own
  on public.compatibility_scores for select to authenticated
  using (viewer_user_id = app.current_user_id());

-- Factors follow their score. A direct `exists` against the parent would make
-- this policy depend on another table's policy, which ERD §2.4 forbids; the
-- score_id is scoped by the viewer column on the parent instead, reached
-- through a security definer predicate.
create or replace function app.owns_compatibility_score(viewer uuid, score uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.compatibility_scores s
    where s.id = score and s.viewer_user_id = viewer
  )
$$;

comment on function app.owns_compatibility_score(uuid, uuid) is
  'Was this score computed FOR this viewer. Security definer so the factors '
  'policy never invokes the scores policy (ERD 2.4).';

revoke all on function app.owns_compatibility_score(uuid, uuid) from public;
grant execute on function app.owns_compatibility_score(uuid, uuid)
  to authenticated, service_role;

create policy compatibility_factors_select_own
  on public.compatibility_factors for select to authenticated
  using (app.owns_compatibility_score(app.current_user_id(), score_id));

create policy match_candidates_select_own
  on public.match_candidates for select to authenticated
  using (user_id = app.current_user_id());
