-- =============================================================================
-- 0018 — matches, match_events, and the response transitions
--
-- Phase 6 Slice 2. `POST /interests/{id}/respond` and what accepting produces.
--
-- WHAT THE CONTRACT SAYS, AND WHAT IT DOES NOT.
--
-- "Accepting creates a match. It does **not** necessarily open a
-- conversation (ADR 0011)." A match is therefore created BY an interest —
-- which is why `matches.interest_id` exists and is described as "what created
-- it" — rather than by two interests crossing. One acceptance, one match.
--
-- "If either side has `communicationPolicy: family_reviewed`, the match is
-- created in `pending_family_review` … If neither side does, the match opens
-- directly and a conversation is created at stage 1."
--
-- No `communicationPolicy` exists yet — it arrives with Family Safety
-- (Phase 6b) — so every match created today takes the second branch and opens
-- in `open`. The conversation does NOT follow, because conversations are the
-- chat slice; the Match schema explicitly tolerates this ("A match can exist
-- with no thread"), and `conversation_id` stays null until that slice fills
-- it. The gate is in place and simply has nothing to withhold yet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- matches
--
-- `user_a_id < user_b_id` is enforced by a CHECK, not by convention. ERD §10
-- is explicit about why: "Without it, (A,B) and (B,A) are different rows and
-- duplicate matches become possible." The unique index only means something
-- because the ordering constraint holds.
-- -----------------------------------------------------------------------------

create table public.matches (
  id                      uuid primary key default gen_random_uuid(),
  user_a_id               uuid not null references public.users (id) on delete restrict,
  user_b_id               uuid not null references public.users (id) on delete restrict,
  interest_id             uuid not null references public.interests (id) on delete restrict,
  communication_state     text not null default 'open',
  communication_state_at  timestamptz not null default now(),
  ended_at                timestamptz,
  ended_by_user_id        uuid references public.users (id) on delete restrict,
  end_reason              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- The ordering that makes the unique index total over unordered pairs.
  constraint matches_ordered check (user_a_id < user_b_id),
  -- `user_a_id < user_b_id` already forbids equality, so a self-match is
  -- impossible twice over. Stated anyway, because the intent should not have
  -- to be inferred from an ordering rule.
  constraint matches_not_self check (user_a_id <> user_b_id),
  -- `active` is DERIVED, never stored: it means a writable state plus at least
  -- one message (ADR 0011). Storing it would make it a third source of truth
  -- about whether a thread has traffic.
  constraint matches_communication_state_valid check (
    communication_state in (
      'pending_family_review', 'family_rejected', 'open',
      'family_approved', 'revoked', 'blocked'
    )
  ),
  constraint matches_ended_consistent check (
    (ended_at is null and ended_by_user_id is null)
    or (ended_at is not null and ended_by_user_id is not null)
  ),
  constraint matches_pair_key unique (user_a_id, user_b_id)
);

comment on table public.matches is
  'One row per unordered pair. communication_state is the Family Safety gate '
  '(ADR 0011) — never assume a match means a conversation may be written.';

comment on column public.matches.communication_state is
  'Writing is permitted in open, family_approved and (derived) active. Phase '
  '6b introduces pending_family_review when a side requires review.';

create index matches_user_a_idx on public.matches (user_a_id) where ended_at is null;
create index matches_user_b_idx on public.matches (user_b_id) where ended_at is null;
-- The reviews-awaiting-action query and the SLA sweep (R16), ready for 6b.
create index matches_pending_review_idx
  on public.matches (communication_state, communication_state_at)
  where communication_state = 'pending_family_review';

create trigger matches_touch
  before update on public.matches
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- match_events — the state machine's history
--
-- ERD §10: every `communication_state` transition writes a row carrying the
-- acting delegate and the relationship used, so "Approved by Ahmed (Father) on
-- behalf of Muhammad" is reconstructable from ONE row.
--
-- `relationship_id` is absent for the same reason it is absent from `blocks`:
-- it references `family_relationships`, which does not exist until Phase 6b,
-- and a uuid column with no referent is worse than no column.
-- -----------------------------------------------------------------------------

create table public.match_events (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references public.matches (id) on delete cascade,
  event            text not null,
  actor_user_id    uuid not null references public.users (id) on delete restrict,
  acted_by_user_id uuid references public.users (id) on delete restrict,
  from_state       text,
  to_state         text,
  created_at       timestamptz not null default now(),

  -- Only the transition this slice can perform. Approval, revocation and
  -- ending arrive with the slices that can cause them.
  constraint match_events_event_valid check (event in ('created'))
);

comment on table public.match_events is
  'Append-only state history. No member write path: an audit a participant can '
  'write is not an audit.';

create index match_events_match_idx on public.match_events (match_id, created_at);

-- =============================================================================
-- interests — the response transitions
-- =============================================================================

-- 0017 allowed only the two events that slice could produce. Responding adds
-- three more, each one now performable.
alter table public.interest_events
  drop constraint interest_events_event_valid;

alter table public.interest_events
  add constraint interest_events_event_valid check (
    event in ('sent', 'withdrawn', 'accepted', 'declined', 'maybe_later')
  );

-- The 0017 version of this was weak: its middle branch made every non-pending,
-- non-withdrawn status unconditionally valid, so it asserted nothing about
-- `responded_at`. A constraint that cannot fail is worse than no constraint,
-- because it reads like a guarantee. This one actually holds the invariant:
-- a responded interest records WHEN, a pending one has not been answered, and
-- a withdrawal is the sender's act rather than a response.
--
-- Safe to tighten in place: nothing could reach `accepted`, `declined` or
-- `maybe_later` before this migration, so no existing row can violate it.
alter table public.interests
  drop constraint interests_responded_consistent;

alter table public.interests
  add constraint interests_responded_consistent check (
    (status in ('pending', 'withdrawn') and responded_at is null)
    or (status in ('accepted', 'declined', 'maybe_later') and responded_at is not null)
  );

-- =============================================================================
-- app.relationship — 'match', ABOVE interest_pending
--
-- The order 0011 recorded, now complete apart from the family states:
--
--   self > blocked > match > interest_pending > stranger
--
-- `match` sits above `interest_pending` because a matched pair usually still
-- has the accepted interest row that produced the match; reporting
-- `interest_pending` for them would describe the weaker relationship. `blocked`
-- stays above both, so blocking someone you matched with still wins.
--
-- An ENDED match does not count. `ended_at is null` is what makes unmatching
-- return the pair to whatever they were, rather than leaving a relationship
-- nothing can clear.
--
-- `app.can_view_profile()` is still untouched: it answers self, then blocked,
-- then falls through to discoverability for everything else, so `match` lands
-- exactly where `stranger` did. Widening what a match may see belongs to the
-- slice that has a conversation to justify it.
-- =============================================================================

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
    when exists (
      select 1 from public.matches m
      where m.ended_at is null
        and (
          (m.user_a_id = viewer and m.user_b_id = target)
          or (m.user_a_id = target and m.user_b_id = viewer)
        )
    ) then 'match'
    when exists (
      select 1 from public.interests i
      where i.status = 'pending'
        and (
          (i.sender_user_id = viewer and i.recipient_user_id = target)
          or (i.sender_user_id = target and i.recipient_user_id = viewer)
        )
    ) then 'interest_pending'
    -- PHASE 6b INSERTION POINT — 'own_wali', 'counterpart_wali'.
    else 'stranger'
  end
$$;

comment on function app.relationship(uuid, uuid) is
  'Viewer standing: self | blocked | match | interest_pending | stranger. '
  'Phase 6b adds the wali states at the marked point.';

-- =============================================================================
-- RLS
--
-- `matches` is `shared` (ERD §10): both participants read it. Nobody writes
-- it — a match is system-generated by accepting an interest, and a member who
-- could INSERT one would manufacture a relationship the other person never
-- agreed to. `communication_state` in particular is the Family Safety gate;
-- a member who could UPDATE it could approve their own conversation.
-- =============================================================================

select app.enable_rls('public.matches');
select app.enable_rls('public.match_events');

grant all on public.matches to service_role;
grant all on public.match_events to service_role;

grant select on public.matches to authenticated;

create policy matches_select_participant
  on public.matches for select to authenticated
  using (
    user_a_id = app.current_user_id()
    or user_b_id = app.current_user_id()
  );
