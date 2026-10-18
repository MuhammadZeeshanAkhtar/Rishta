-- =============================================================================
-- 0023 — discovery_generation_runs
--
-- Phase 7a. The record that makes candidate generation safe to trigger from a
-- request.
--
-- THE DEFECT THIS CLOSES. `generateCandidates()` has existed since Phase 5 and
-- is correct, but nothing in the running application ever called it — every
-- one of its call sites was a test. So `match_candidates` stayed empty,
-- `/discovery/sections/:key` read an empty table, and a real member's Discover
-- feed was permanently blank. The engine worked; the trigger was never built.
--
-- WHY A TABLE RATHER THAN AN ADVISORY LOCK. The obvious answer to "stop two
-- requests generating at once" is `pg_advisory_lock`, and it does not work
-- here. `db.asService()` takes a fresh connection from the pool, opens a
-- transaction, commits and releases it (services/api/src/db/pg.ts), and
-- generation spans FOUR such calls:
--
--   * a transaction-scoped lock releases at the first commit, so it would
--     guard the FILTER step and nothing else;
--   * a session-scoped lock binds to the CONNECTION, which is then returned to
--     the pool still holding it, and cannot be released from the next
--     connection. That is a lock leak that poisons the pool.
--
-- A row survives all four transactions, is not tied to a connection, works
-- across processes, and — unlike a hashed advisory key — cannot collide.
--
-- IT ALSO SOLVES THE EMPTY CASE, which is the subtler half. A cooldown read
-- from `match_candidates.created_at` is unusable for the member who has NO
-- eligible candidates: there are no rows, so there is no timestamp, so every
-- feed open would regenerate forever — precisely the member for whom
-- generation is most pointless. This row is written whether or not anything
-- was produced, so "we looked recently and found nobody" is recorded.
-- =============================================================================

create table public.discovery_generation_runs (
  user_id     uuid not null references public.users (id) on delete restrict,
  section_key text not null,

  -- Claim marker. Set when a request takes responsibility for generating.
  started_at  timestamptz not null default now(),
  -- Null while a run is in flight. A run whose `started_at` is older than the
  -- stale window with this still null was abandoned — the process died, the
  -- request was cancelled — and may be reclaimed. There is no job runner to
  -- sweep these (ADR 0007 deferred, pg-boss not installed), so reclaiming on
  -- read is the only cleanup that will actually happen.
  finished_at timestamptz,
  -- The batch this run produced, for tracing a feed back to the run that made
  -- it. Null for a run that completed with no eligible candidates.
  batch_id    uuid,
  -- Null when the run has not finished, or finished with nothing.
  candidates  integer,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One row per viewer per section, reused forever. The claim is an UPDATE of
  -- this row, which is what makes it atomic: two concurrent requests issue the
  -- same conditional UPDATE and exactly one matches.
  constraint discovery_generation_runs_pkey primary key (user_id, section_key),

  -- The same eight values as `match_candidates_section_valid`. Kept in step
  -- deliberately: a run recorded for a section that cannot hold candidates
  -- would be a cooldown nothing could ever satisfy.
  constraint discovery_generation_runs_section_valid check (
    section_key in (
      'recommended', 'highly_compatible', 'nearby', 'verified',
      'recently_joined', 'same_language', 'same_country', 'open_to_relocation'
    )
  ),
  constraint discovery_generation_runs_finished_after_start check (
    finished_at is null or finished_at >= started_at
  ),
  constraint discovery_generation_runs_candidates_non_negative check (
    candidates is null or candidates >= 0
  )
);

comment on table public.discovery_generation_runs is
  'One row per viewer per discovery section. Serves two jobs at once: the '
  'claim that stops concurrent generation, and the cooldown marker that works '
  'even when generation found nobody.';

comment on column public.discovery_generation_runs.finished_at is
  'Null means in flight. Null plus an old started_at means abandoned and '
  'reclaimable — there is no sweeper, so reclaiming happens on the next read.';

-- The reclaim scan: find in-flight runs older than the stale window.
create index discovery_generation_runs_inflight_idx
  on public.discovery_generation_runs (started_at)
  where finished_at is null;

create trigger discovery_generation_runs_touch
  before update on public.discovery_generation_runs
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS — `system`. No member path of any kind.
--
-- This table is scheduling state, not member data. A member who could write it
-- could claim another member's run and starve their feed, or clear a cooldown
-- and make generation runnable on every request — a cheap way to spend the
-- server's CPU. There is no legitimate member read either: nothing in the
-- product shows "when were your candidates last generated".
--
-- Zero policies, and the absence is the control.
-- =============================================================================

select app.enable_rls('public.discovery_generation_runs');

grant all on public.discovery_generation_runs to service_role;
