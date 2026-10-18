-- =============================================================================
-- 0017 — interests, interest_events, usage_counters
--
-- Phase 6 Slice 1. The three tables `POST /interests` needs, and the extension
-- of `app.relationship()` that migration 0011 left an insertion point for.
--
-- COLUMN NAMES follow ERD §10 exactly: `sender_user_id` and
-- `recipient_user_id`. They are the names every index, policy and later
-- `matches.interest_id` join in that document already assumes.
--
-- NO MATCH IS CREATED HERE. Mutual interest is detectable from these rows, and
-- `app.relationship()` reports `interest_pending` either way round, but
-- `matches` and the communication state machine belong to a later slice. A
-- match row written now would have no `communication_state` machine to govern
-- it, which is the one thing ADR 0011 says must never be assumed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- interests
-- -----------------------------------------------------------------------------

create table public.interests (
  id                uuid primary key default gen_random_uuid(),
  sender_user_id    uuid not null references public.users (id) on delete restrict,
  recipient_user_id uuid not null references public.users (id) on delete restrict,
  -- A7 (ADR 0011). Null means the owner acted; set means a delegate did, and
  -- the recipient is always shown which. Delegation is never covert.
  acted_by_user_id  uuid references public.users (id) on delete restrict,
  status            text not null default 'pending',
  note              text,
  responded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint interests_not_self check (sender_user_id <> recipient_user_id),
  constraint interests_status_valid check (
    status in ('pending', 'accepted', 'declined', 'maybe_later', 'withdrawn')
  ),
  constraint interests_note_len check (note is null or char_length(note) <= 500),
  -- A terminal status must carry the moment it became terminal, and a pending
  -- one must not pretend to have been answered.
  constraint interests_responded_consistent check (
    (status = 'pending' and responded_at is null)
    or (status <> 'pending' and status <> 'withdrawn')
    or status = 'withdrawn'
  )
);

comment on table public.interests is
  'Expressed interest, sender to recipient. Withdrawn rows are kept rather '
  'than deleted so the audit trail and abuse signals survive a change of mind.';

-- THE CONCURRENCY CONTROL. Partial, so a withdrawn interest does not block a
-- later one to the same person — someone may reconsider — while two concurrent
-- sends of the SAME interest cannot both land. This is what makes the endpoint
-- safe under a double tap without a read-then-write race.
create unique index interests_active_pair_key
  on public.interests (sender_user_id, recipient_user_id)
  where status <> 'withdrawn';

-- The inbox read.
create index interests_inbox_idx
  on public.interests (recipient_user_id, status, created_at desc);
create index interests_outbox_idx
  on public.interests (sender_user_id, status, created_at desc);

create trigger interests_touch
  before update on public.interests
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- interest_events — append-only history
--
-- ERD §10: `interest_id` · `event` · `actor_user_id` · `acted_by_user_id`.
-- Every state change writes one, which is what makes an abuse pattern visible
-- later: a member who sends and withdraws repeatedly leaves a trail even
-- though the interest row only ever shows its latest state.
-- -----------------------------------------------------------------------------

create table public.interest_events (
  id               uuid primary key default gen_random_uuid(),
  interest_id      uuid not null references public.interests (id) on delete cascade,
  event            text not null,
  actor_user_id    uuid not null references public.users (id) on delete restrict,
  acted_by_user_id uuid references public.users (id) on delete restrict,
  created_at       timestamptz not null default now(),

  -- Only the transitions this slice can produce. `accepted`, `declined` and
  -- `maybe_later` arrive with the respond endpoint; naming them now would
  -- allow a row describing a transition nothing can perform.
  constraint interest_events_event_valid check (event in ('sent', 'withdrawn'))
);

comment on table public.interest_events is
  'Append-only state history. No member write path exists at all: an audit a '
  'participant can write is not an audit.';

create index interest_events_interest_idx
  on public.interest_events (interest_id, created_at);

-- -----------------------------------------------------------------------------
-- usage_counters
--
-- ERD §16, and the note beside it is the design: incrementing is an atomic
-- `insert ... on conflict do update set count = count + 1` INSIDE the same
-- transaction as the interest, "otherwise two concurrent requests both read 4
-- and both succeed, and the quota is advisory rather than real".
--
-- `period_start` is a date, so the daily window rolls without a job and
-- yesterday's rows stay readable for support rather than being overwritten.
-- -----------------------------------------------------------------------------

create table public.usage_counters (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete restrict,
  counter_key  text not null,
  period_start date not null,
  count        integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint usage_counters_key_valid check (counter_key in ('daily_interests')),
  -- A counter that can go negative is a counter that can be used to mint
  -- quota, so the floor is a constraint rather than a convention.
  constraint usage_counters_count_non_negative check (count >= 0),
  constraint usage_counters_period_key unique (user_id, counter_key, period_start)
);

comment on table public.usage_counters is
  'Quota consumption per member per day. Incremented in the same transaction '
  'as the action it limits, so the limit is real rather than advisory.';

create trigger usage_counters_touch
  before update on public.usage_counters
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- app.relationship — the Phase 6 insertion point
--
-- 0011 left this marked, and stated the contract the insertion has to honour:
--
--   self > blocked > match > interest_pending > stranger
--
-- `blocked` stays above, so blocking someone you have a pending interest with
-- still wins. `match` is not inserted — that slice has not happened, and a
-- state whose table does not exist would be a claim the visibility system is
-- built on.
--
-- BIDIRECTIONAL. A pending interest in EITHER direction reports
-- `interest_pending`, because the relationship is a property of the pair
-- rather than of whoever asked. The recipient of an interest is as much in
-- that relationship as the sender.
--
-- `app.can_view_profile()` is deliberately NOT changed. It answers self, then
-- blocked, then falls through to the discoverability test for everything else,
-- so `interest_pending` lands exactly where `stranger` did and no visibility
-- decision moves. Widening what a pending interest can see is a product
-- decision for the slice that has a reveal flow to go with it.
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
    -- PHASE 6 INSERTION POINT — 'match' goes here, ABOVE interest_pending.
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
  'Viewer standing: self | blocked | interest_pending | stranger. Phase 6 adds '
  'match ABOVE interest_pending; blocked must remain above both.';

-- =============================================================================
-- RLS
--
-- `interests` is `shared` (ERD §10): both parties read it, because an interest
-- is a fact about the pair. Everything else is closed.
--
-- NO MEMBER UPDATE GRANT. Status is server state, exactly like
-- `profiles.review_status` and `photos.moderation_status`. A member who could
-- UPDATE this table could mark an interest `accepted` without the recipient
-- ever seeing it — which, once matches exist, would manufacture a match.
-- Withdrawing goes through the API, which writes the row and its event
-- together.
--
-- `interest_events` has NO member grant of any kind. An audit a participant
-- can write is not an audit, and one they can read tells them more about the
-- other party's behaviour than an interest is supposed to disclose.
-- =============================================================================

select app.enable_rls('public.interests');
select app.enable_rls('public.interest_events');
select app.enable_rls('public.usage_counters');

grant all on public.interests to service_role;
grant all on public.interest_events to service_role;
grant all on public.usage_counters to service_role;

grant select, insert on public.interests to authenticated;
grant select on public.usage_counters to authenticated;

-- Shared read: the sender and the recipient, and nobody else. Blocks are not
-- re-checked here — an interest sent before a block is still a fact both
-- parties may see, and hiding it would make a withdrawal impossible to observe.
create policy interests_select_participant
  on public.interests for select to authenticated
  using (
    sender_user_id = app.current_user_id()
    or recipient_user_id = app.current_user_id()
  );

-- Ownership at the database. Even though the send path runs through the
-- trusted boundary (the quota counter and the interest must land in one
-- transaction), this is what stops a direct insert naming someone else as the
-- sender.
create policy interests_insert_own
  on public.interests for insert to authenticated
  with check (sender_user_id = app.current_user_id());

create policy usage_counters_select_own
  on public.usage_counters for select to authenticated
  using (user_id = app.current_user_id());
