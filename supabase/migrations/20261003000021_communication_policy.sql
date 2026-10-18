-- =============================================================================
-- 0021 — communication_policy: the Family Safety gate's missing input
--
-- A PRE-BETA SAFEGUARD, NOT PHASE 6b. Nothing here reviews, approves, rejects
-- or revokes anything. No family table, no delegate, no permission. This
-- migration supplies the one value the gate reads, and makes sure the gate is
-- read at every point a match period comes into existence.
--
-- WHY IT CANNOT WAIT FOR 6b. ERD §21 invariant 5: "Changing
-- `user_settings.communication_policy` never retroactively re-gates a live
-- match." That is the right rule — silently freezing a live conversation from
-- a settings toggle is indistinguishable from a bug, and for anyone under
-- pressure at home indistinguishable from a punishment. But it has a
-- consequence. Migration 0018 shipped `communication_state default 'open'`
-- because no policy existed to consult, so every match created between then
-- and 6b would sit permanently outside the gate, with the invariant forbidding
-- the obvious repair.
--
-- The column is therefore added NOW, so provenance is right from the first
-- match onward and 6b has only to add the parties who decide.
--
-- NOTHING CHANGES TODAY, PROVABLY. The default is `direct` (ERD §7) and no
-- member or API write path exists, so every row holds `direct` and every match
-- still opens in `open`. The gate is wired and has nothing to withhold — the
-- same position 0018 put `communication_state` in.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- user_settings.communication_policy
--
-- ERD §7, verbatim: `text NOT NULL default 'direct'` · `direct` ·
-- `family_reviewed`. The default is itself a decision the ERD argues for: "A
-- safety gate that is on by default for people who have invited nobody would
-- lock them out of the product, and a default that has to be worked around is
-- a default that teaches people to work around safety settings."
-- -----------------------------------------------------------------------------

alter table public.user_settings
  add column communication_policy text not null default 'direct';

alter table public.user_settings
  add constraint user_settings_communication_policy_valid
  check (communication_policy in ('direct', 'family_reviewed'));

comment on column public.user_settings.communication_policy is
  'ADR 0011 — the owner''s Family Safety gate. Defaults to direct. NOT yet '
  'member-writable: allowing family_reviewed before Phase 6b exists would let '
  'someone choose a gate no delegate can open, stalling every match they '
  'make. It joins the update grant in the slice that can honour it.';

-- NO COLUMN GRANT, DELIBERATELY. `user_settings` is member-updatable through a
-- column allowlist (migration 0003), which the Data API reaches directly. This
-- column is absent from that list, so neither PATCH /me nor a hand-rolled
-- PostgREST call can write it. The absence is the control, and the grant test
-- in packages/db pins the list that proves it.
--
-- Read access rides on the existing table-level SELECT plus
-- `user_settings_select_own`: the owner sees their own policy and only their
-- own. A counterpart must never learn what the other household expects
-- (ADR 0011) — which is also why the function below is not callable by
-- `authenticated`.

-- -----------------------------------------------------------------------------
-- app.required_communication_state(uuid, uuid)
--
-- ERD §21's transition table, as a function:
--
--   → `open`                   System, when neither side is family_reviewed
--   → `pending_family_review`  System, on accept when either side is
--
-- ONE EXPRESSION, SHARED BY EVERY PATH. This is a function rather than a line
-- of SQL in the accept route because there is more than one way a match row
-- comes to life — a fresh insert, and the revival of a row the pair ended
-- earlier — and the bypass this migration closes was exactly those two paths
-- disagreeing. Two copies of a gate are one copy and one hole.
--
-- STRICTLY ONE QUESTION: does a side require review? Blocks are not its
-- business; `blocked` is a transition the block path owns, and the accept
-- route already refuses a pair who cannot see each other.
--
-- SECURITY DEFINER, because `user_settings` is owner-RLS and the answer spans
-- two people's rows. `service_role` only: granted to `authenticated` it would
-- answer "is this person's household strict?" about anybody.
-- -----------------------------------------------------------------------------

create or replace function app.required_communication_state(user_one uuid, user_two uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.user_settings s
      where s.user_id in (user_one, user_two)
        and s.communication_policy = 'family_reviewed'
    ) then 'pending_family_review'
    else 'open'
  end
$$;

comment on function app.required_communication_state(uuid, uuid) is
  'The state a NEW match period must start in. A match is gated if EITHER '
  'side requires review (ADR 0011) — both households are protected by one '
  'person''s setting, because neither can see what the other expects.';

revoke all on function app.required_communication_state(uuid, uuid) from public;
grant execute on function app.required_communication_state(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- The gate is applied where a match period BEGINS — in the database
--
-- THE REMATCH BYPASS THIS CLOSES. `matches_pair_key` is unique over the
-- unordered pair with no partial clause, so there is one row per pair forever
-- and unmatching marks it `ended_at` rather than deleting it. Coming back
-- therefore REVIVES that row. The 0018 accept route revived it with
-- `communication_state = 'open'` hard-coded — true while no policy could
-- exist, and a laundering path the moment one can: a gated pair unmatch,
-- rematch, and land in `open` having never been reviewed.
--
-- WHY A TRIGGER RATHER THAN TWO LINES IN THE ROUTE. The invariant is "a new
-- match period starts at the gate the current policy requires". Written in the
-- route it holds for the paths that remembered; written here it holds for
-- every path there will ever be, including whatever 6b and the chat slice add.
-- This repository puts authorization at the database boundary rather than in
-- the caller, and a gate is the least suitable thing to make an exception for.
--
-- WHAT IT DOES NOT TOUCH, and this is the whole of ERD §21 invariant 5: an
-- UPDATE to a LIVE match. A delegate approving, a revocation, a block, a
-- policy flipped by someone already matched — none of them fire it. The
-- condition is a row whose `ended_at` goes from set to null, which is a new
-- match period and nothing else. The accept route already treats it as one: it
-- writes a second `created` event, so the log reads created -> ended ->
-- created.
-- -----------------------------------------------------------------------------

create or replace function app.gate_new_match_period()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nested rather than one `or`: OLD is unassigned on INSERT, and a PL/pgSQL
  -- condition is evaluated as a single SQL expression, so reading
  -- `old.ended_at` in the same test would raise regardless of short-circuit.
  if tg_op = 'INSERT' then
    new.communication_state :=
      app.required_communication_state(new.user_a_id, new.user_b_id);
    new.communication_state_at := now();
  elsif old.ended_at is not null and new.ended_at is null then
    -- A revival: the pair ended it and have come back. That is a new match
    -- period, which invariant 5 itself says the current policy governs —
    -- "Turning review on applies to matches created afterwards."
    new.communication_state :=
      app.required_communication_state(new.user_a_id, new.user_b_id);
    new.communication_state_at := now();
  end if;
  return new;
end;
$$;

comment on function app.gate_new_match_period() is
  'BEFORE INSERT OR UPDATE on matches. Sets communication_state at the birth '
  'of a match period — a fresh insert, or the revival of an ended row — and '
  'never on a live match, so no settings change re-gates a conversation that '
  'is already running (ERD §21 invariant 5).';

create trigger matches_gate_new_period
  before insert or update on public.matches
  for each row execute function app.gate_new_match_period();

comment on column public.matches.communication_state is
  'Writing is permitted in open, family_approved and (derived) active. Set at '
  'the birth of each match period by app.gate_new_match_period(), from the two '
  'sides'' communication_policy; moved thereafter only by Phase 6b review '
  'transitions. The column default is now unreachable, and is kept only so the '
  'column is never momentarily without a legal value.';
