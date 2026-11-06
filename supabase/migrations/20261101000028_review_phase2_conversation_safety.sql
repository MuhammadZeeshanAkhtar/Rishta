-- =============================================================================
-- 0028 — Code review remediation, Phase 2 (review dated 2026-10-28)
--
-- Database half of B16, B24 and B25. Forward-only and additive in effect:
-- every constraint below accepts every row its predecessor accepted, and no
-- earlier migration is edited.
--
--   B16  A stage proposal could be accepted after a block, unmatch or family
--        revocation, and pending proposals outlived the thread that made them.
--   B24  A member could not block someone they had a relationship with once
--        that person stopped being viewable.
--   B25  Leaving a conversation was one-sided: the other participant could
--        still write into a thread the leaver could no longer open.
--
-- RELEASE ORDER: after Phase 1 has completed (0026 -> Phase 1 API -> 0027),
-- then this file, then the Phase 2 API. The Phase 2 API calls
-- app.has_interacted_with(), which exists only from here.
-- =============================================================================

-- =============================================================================
-- B16 — a stage proposal can be CANCELLED
--
-- Until now a proposal was pending, accepted or declined. None of those is
-- true of a proposal whose thread closed under it: nobody accepted it, and
-- nobody declined it. Recording it as `declined` would put a decision in the
-- audit trail that no person made.
--
-- `cancelled` is the system's act, so it has NO responder — only the time.
-- Accepted and declined stay exactly as strict as 0025 made them.
--
-- Safe to replace in place: both new conditions accept every row the old ones
-- did, so no existing row can violate them.
-- =============================================================================

alter table public.stage_transitions
  drop constraint stage_transitions_status_valid;

alter table public.stage_transitions
  add constraint stage_transitions_status_valid
  check (status in ('pending', 'accepted', 'declined', 'cancelled'));

alter table public.stage_transitions
  drop constraint stage_transitions_responded_consistent;

alter table public.stage_transitions
  add constraint stage_transitions_responded_consistent check (
    (status = 'pending' and responded_by_user_id is null and responded_at is null)
    or (status in ('accepted', 'declined')
        and responded_by_user_id is not null and responded_at is not null)
    or (status = 'cancelled' and responded_by_user_id is null and responded_at is not null)
  );

-- =============================================================================
-- B16 — one function cancels, three triggers call it
--
-- Cancellation lives in the database rather than in the four routes that can
-- close a thread, because one of those paths has no route at all: a member can
-- insert into `blocks` directly through the Data API (0011 grants it), and a
-- route-only cancellation would never run for that block.
--
-- WHY THIS CANNOT RECURSE. The only table these functions write is
-- `stage_transitions`, and `stage_transitions` has no triggers. The triggers
-- watch `blocks`, `matches` and `conversation_participants`, none of which is
-- written here. A cancellation therefore fires nothing further.
--
-- WHY THE STAGE CANNOT GO INCONSISTENT. Only `status`/`responded_at` of a
-- PENDING row change; `conversation_stages.current_stage` is never touched, so
-- a cancelled proposal never moves the ladder. A respond racing a cancellation
-- serialises on the row lock: respond selects the pending row FOR UPDATE, and
-- the cancelling UPDATE re-checks `status = 'pending'` after waiting, so
-- exactly one of them wins and the loser changes nothing.
--
-- AFTER triggers, so each one sees the row as committed by every BEFORE
-- trigger (0021's period gate, 0026's family-approval guard), never a value a
-- BEFORE trigger is about to change.
-- =============================================================================

create or replace function app.cancel_pending_stage_proposals(conversation uuid)
returns integer
language sql
volatile
-- Called from triggers that fire on a MEMBER's write (a Data API block), and
-- members hold no grant on stage_transitions. Elevated for the one write it
-- makes: pending -> cancelled, on the thread that just closed.
security definer
set search_path = public, pg_temp
as $$
  with cancelled as (
    update public.stage_transitions
       set status = 'cancelled', responded_at = now()
     where conversation_id = conversation
       and status = 'pending'
    returning 1
  )
  select count(*)::int from cancelled
$$;

comment on function app.cancel_pending_stage_proposals(uuid) is
  'Marks the pending stage proposal of a conversation cancelled. Only ever '
  'pending -> cancelled; never touches the current stage (B16).';

-- Not a member capability. A member who could call this could cancel the
-- pending proposal of any conversation whose id they knew.
revoke all on function app.cancel_pending_stage_proposals(uuid) from public;
grant execute on function app.cancel_pending_stage_proposals(uuid) to service_role;

-- --- on block ----------------------------------------------------------------

create or replace function app.cancel_stage_proposals_on_block()
returns trigger
language plpgsql
-- SECURITY DEFINER for the same reason as app.touch_conversation_on_message
-- (0025): this fires on a member's own insert into `blocks`.
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.cancel_pending_stage_proposals(c.id)
     from public.conversations c
     join public.matches m on m.id = c.match_id
    where (m.user_a_id = new.blocker_user_id and m.user_b_id = new.blocked_user_id)
       or (m.user_a_id = new.blocked_user_id and m.user_b_id = new.blocker_user_id);
  return null;
end;
$$;

comment on function app.cancel_stage_proposals_on_block() is
  'AFTER INSERT on blocks. A block closes every thread between the pair, so '
  'their pending stage proposals are cancelled (B16).';

create trigger blocks_cancel_stage_proposals
  after insert on public.blocks
  for each row execute function app.cancel_stage_proposals_on_block();

-- --- on unmatch, family revocation, or any other loss of a writable state ----

create or replace function app.cancel_stage_proposals_on_match_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Closing means: the match ended (unmatch), or it LEFT a writable state
  -- (family revocation, or any future transition out of open/approved). A
  -- revival (ended_at back to null) is not a closing and cancels nothing new;
  -- its proposals were cancelled when it ended.
  if (old.ended_at is null and new.ended_at is not null)
     or (old.communication_state in ('open', 'family_approved')
         and new.communication_state not in ('open', 'family_approved'))
  then
    perform app.cancel_pending_stage_proposals(c.id)
       from public.conversations c
      where c.match_id = new.id;
  end if;
  return null;
end;
$$;

comment on function app.cancel_stage_proposals_on_match_close() is
  'AFTER UPDATE OF ended_at, communication_state on matches. Cancels pending '
  'stage proposals when the match ends or stops being writable (B16).';

create trigger matches_cancel_stage_proposals
  after update of ended_at, communication_state on public.matches
  for each row execute function app.cancel_stage_proposals_on_match_close();

-- --- on leaving --------------------------------------------------------------

create or replace function app.cancel_stage_proposals_on_leave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.left_at is null and new.left_at is not null then
    perform app.cancel_pending_stage_proposals(new.conversation_id);
  end if;
  return null;
end;
$$;

comment on function app.cancel_stage_proposals_on_leave() is
  'AFTER UPDATE OF left_at on conversation_participants. Leaving closes the '
  'thread for both sides (B25), so its pending proposal is cancelled (B16).';

create trigger conversation_participants_cancel_stage_proposals
  after update of left_at on public.conversation_participants
  for each row execute function app.cancel_stage_proposals_on_leave();

-- --- proposals already stranded before this migration -----------------------
--
-- A thread that closed before the triggers existed may still hold a pending
-- proposal. Cancelled once here, by the same rule the triggers apply, so the
-- data does not depend on when a thread happened to close.

update public.stage_transitions st
   set status = 'cancelled', responded_at = now()
 where st.status = 'pending'
   and exists (
     select 1
       from public.conversations c
       join public.matches m on m.id = c.match_id
      where c.id = st.conversation_id
        and (
          m.ended_at is not null
          or m.communication_state not in ('open', 'family_approved')
          or app.is_blocked(m.user_a_id, m.user_b_id)
          or exists (
            select 1 from public.conversation_participants p
             where p.conversation_id = c.id and p.left_at is not null
          )
        )
   );

-- =============================================================================
-- B25 — once anyone has left, nobody writes
--
-- app.can_write_message() checked only the WRITER's own participant row, so
-- after one person left, the other could keep writing into a thread the leaver
-- could no longer open — and every message raised a notification for someone
-- who had walked away. Decision (2026-11-01): leaving closes the conversation
-- for both participants, permanently. There is no rejoin.
--
-- One added clause. Everything else is 0025's definition unchanged. Because
-- the message insert policy calls this function, the Data API path closes too.
-- `create or replace` with the same signature keeps the existing grants.
-- =============================================================================

create or replace function app.can_write_message(viewer uuid, conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversation_participants p
    join public.conversations c on c.id = p.conversation_id
    join public.matches m on m.id = c.match_id
    where p.conversation_id = conversation
      and p.user_id = viewer
      and p.left_at is null
      and p.can_write
      and c.status = 'active'
      and m.ended_at is null
      and m.communication_state in ('open', 'family_approved')
      and not app.is_blocked(m.user_a_id, m.user_b_id)
      -- B25: a thread anyone has left is closed for everyone in it.
      and not exists (
        select 1 from public.conversation_participants other
         where other.conversation_id = conversation
           and other.left_at is not null
      )
  )
$$;

comment on function app.can_write_message(uuid, uuid) is
  'Membership AND an open gate AND a live match AND no block AND nobody has '
  'left (B25). The read policy asks a different question deliberately (ERD '
  'section 11).';

-- =============================================================================
-- B24 — may the caller block this person even though they cannot see them?
--
-- The block route required app.can_view_profile(), which is false for anyone
-- suspended, unapproved or otherwise hidden — so a member could not block
-- someone they were already talking to, at exactly the moment it matters.
--
-- Answers one question about the CALLER only: have they had any interest
-- (either direction, any status) or any match (live or ended) with `target`?
-- A conversation always belongs to a match, so a match covers it.
--
-- Deliberately takes no viewer argument. It reads app.current_user_id(), so it
-- can describe only the caller's own relationships and never a third party's.
-- =============================================================================

create or replace function app.has_interacted_with(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.current_user_id() is not null
     and target is not null
     and target <> app.current_user_id()
     and (
       exists (
         select 1 from public.interests i
          where (i.sender_user_id = app.current_user_id() and i.recipient_user_id = target)
             or (i.sender_user_id = target and i.recipient_user_id = app.current_user_id())
       )
       or exists (
         select 1 from public.matches m
          where (m.user_a_id = app.current_user_id() and m.user_b_id = target)
             or (m.user_a_id = target and m.user_b_id = app.current_user_id())
       )
     )
$$;

comment on function app.has_interacted_with(uuid) is
  'True when the CALLER has had any interest or match with target, whatever '
  'its state. Lets a member block someone they know but can no longer see '
  '(B24). Caller-scoped: it cannot describe a third party.';

revoke all on function app.has_interacted_with(uuid) from public;
grant execute on function app.has_interacted_with(uuid) to authenticated, service_role;
