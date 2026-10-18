-- =============================================================================
-- 0019 — ending a match
--
-- Phase 6 Slice 4. `POST /matches/{matchId}/unmatch`.
--
-- ENDING IS NOT A COMMUNICATION-STATE TRANSITION. ERD §10 gives `matches`
-- three dedicated columns for this — `ended_at`, `ended_by_user_id`,
-- `end_reason` — separately from `communication_state`, which is the Family
-- Safety gate (ADR 0011). Unmatching is the member's own decision about the
-- relationship, not a family decision about whether they may write, so the
-- gate is left exactly as it was and `ended_at` is the authoritative marker.
-- `app.relationship()` already keys off `ended_at is null`, so nothing about
-- the relationship model changes.
--
-- The consequence for the conversation slice, stated here so it is not
-- discovered later: a write check must test `ended_at is null` AS WELL AS the
-- communication state. An ended match can still be sitting in `open`.
-- =============================================================================

alter table public.match_events
  drop constraint match_events_event_valid;

alter table public.match_events
  add constraint match_events_event_valid check (
    event in ('created', 'ended')
  );

comment on constraint match_events_event_valid on public.match_events is
  'Only transitions something can perform. Family approval and revocation '
  'arrive with the slices that can cause them.';

-- The contract caps the optional reason at 300 characters.
alter table public.matches
  add constraint matches_end_reason_len
  check (end_reason is null or char_length(end_reason) <= 300);

-- A reason without an ending is a field describing something that did not
-- happen. `matches_ended_consistent` already pairs `ended_at` with
-- `ended_by_user_id`; this extends the same idea to the reason.
alter table public.matches
  add constraint matches_end_reason_requires_end
  check (end_reason is null or ended_at is not null);

comment on column public.matches.ended_at is
  'The authoritative end marker. Set by unmatching; communication_state is '
  'left untouched because ending is not a Family Safety decision.';
