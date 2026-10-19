-- =============================================================================
-- 0025 — conversations and messages (Phase 7)
--
-- The thing the Family Safety gate has been gating. Every piece of this was
-- designed before it could be built: `matches.communication_state` has carried
-- the six-state machine since 0018, 0021 added the policy that drives it, and
-- 0024 built the review that moves it. Nothing until now could read it.
--
-- THE ONE THING EASIEST TO GET WRONG, stated by the ERD before a line existed:
-- "the read policy and the write policy answer different questions here."
--
--   READ  = are you a participant?
--   WRITE = are you a participant AND does the gate currently permit writing?
--
-- Membership is necessary and not sufficient. A revoked approval leaves the
-- participant rows intact and the thread READABLE while closing writes — a
-- family can stop a conversation continuing without deleting what two people
-- already said to each other, and without the silent data loss that would be.
--
-- WHY A TRIGGER CREATES THE CONVERSATION. ERD §11: "A row exists only once
-- `matches.communication_state` permits writing. Putting the gate on the
-- thread would mean creating a thread in order to forbid it." Doing it in the
-- API would mean every path that can open the gate — accepting an interest, a
-- delegate approving, a policy change before the first match — has to remember
-- to create one. A trigger on `matches` cannot forget.
-- =============================================================================

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  match_id        uuid not null unique references public.matches (id) on delete cascade,
  -- The participants' own archive control, INDEPENDENT of the family gate. A
  -- conversation can be archived while fully approved, and frozen by a
  -- revocation while still `active`. Two different questions, two columns.
  status          text not null default 'active',
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint conversations_status_valid check (status in ('active', 'archived', 'ended'))
);

comment on table public.conversations is
  'One thread per match, created by trigger once the communication gate '
  'permits writing. `status` is the participants'' archive control and says '
  'nothing about the family gate.';

comment on column public.conversations.last_message_at is
  'Null until the first message. What makes the exposed `active` state '
  'DERIVABLE rather than stored — `messages` already knows.';

create index conversations_recent_idx on public.conversations (last_message_at desc nulls last);

create trigger conversations_touch
  before update on public.conversations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- conversation_participants — the membership check every message policy runs
--
-- `role` and `can_write` exist now though only `principal`/true is reachable:
-- a delegate holding `view_conversation` but not `join_conversation` is a
-- participant who may read and not write (M2), and retrofitting that column
-- onto a live `messages` policy is the kind of change that gets made wrong.
-- -----------------------------------------------------------------------------

create table public.conversation_participants (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.users (id) on delete restrict,
  role            text not null default 'principal',
  can_write       boolean not null default true,
  joined_at       timestamptz not null default now(),
  left_at         timestamptz,

  constraint conversation_participants_role_valid check (role in ('principal', 'wali')),
  constraint conversation_participants_key unique (conversation_id, user_id)
);

comment on table public.conversation_participants is
  'Membership. `can_write` is false for a delegate who may watch but not '
  'speak (M2); `left_at` ends participation without deleting the history.';

create index conversation_participants_user_idx
  on public.conversation_participants (user_id)
  where left_at is null;

-- -----------------------------------------------------------------------------
-- conversation_stages and stage_transitions
--
-- Advancement is MUTUAL: a proposal the counterpart must accept. One side
-- cannot move a conversation to a stage that unlocks more of the other
-- person, which is the entire reason stages exist rather than a timer.
-- -----------------------------------------------------------------------------

create table public.conversation_stages (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  current_stage   integer not null default 1,
  updated_at      timestamptz not null default now(),

  constraint conversation_stages_range check (current_stage between 1 and 5)
);

create trigger conversation_stages_touch
  before update on public.conversation_stages
  for each row execute function app.touch_updated_at();

create table public.stage_transitions (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references public.conversations (id) on delete cascade,
  from_stage           integer not null,
  to_stage             integer not null,
  proposed_by_user_id  uuid not null references public.users (id) on delete restrict,
  status               text not null default 'pending',
  responded_by_user_id uuid references public.users (id) on delete restrict,
  responded_at         timestamptz,
  created_at           timestamptz not null default now(),

  constraint stage_transitions_status_valid check (status in ('pending', 'accepted', 'declined')),
  constraint stage_transitions_range check (
    from_stage between 1 and 5 and to_stage between 1 and 5
  ),
  -- Forward by exactly one. A proposal to jump two stages, or to go back,
  -- would make "what does this stage unlock" unanswerable.
  constraint stage_transitions_forward check (to_stage = from_stage + 1),
  -- The responder is recorded exactly when there is a response.
  constraint stage_transitions_responded_consistent check (
    (status = 'pending' and responded_by_user_id is null and responded_at is null)
    or (status <> 'pending' and responded_by_user_id is not null and responded_at is not null)
  ),
  -- Nobody accepts their own proposal. The mutuality IS the control.
  constraint stage_transitions_not_self_accepted check (
    responded_by_user_id is null or responded_by_user_id <> proposed_by_user_id
  )
);

-- One live proposal per conversation. Partial, so a declined proposal can be
-- made again later without the index refusing it.
create unique index stage_transitions_one_pending
  on public.stage_transitions (conversation_id)
  where status = 'pending';

create index stage_transitions_recent_idx
  on public.stage_transitions (conversation_id, created_at desc);

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------

create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  sender_user_id    uuid not null references public.users (id) on delete restrict,
  -- A7. Null means the principal wrote it; set means a delegate did, under
  -- `join_conversation` (M2). Present from the first row for the same reason
  -- it is on `interests` and `blocks`: retrofitting an actor column onto an
  -- audit trail loses every row written before it.
  acted_by_user_id  uuid references public.users (id) on delete restrict,
  body              text not null,
  kind              text not null default 'text',
  moderation_status text not null default 'clean',
  edited_at         timestamptz,
  -- Soft delete. `report_evidence` (Phase 8) snapshots by value precisely so
  -- a bad actor deleting their messages does not destroy the case.
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),

  constraint messages_kind_valid check (kind in ('text', 'voice', 'system')),
  constraint messages_moderation_valid check (
    moderation_status in ('clean', 'flagged', 'blocked')
  ),
  -- A message with nothing in it is a tap, not a message. Capped where the
  -- contract caps it.
  constraint messages_body_len check (char_length(body) between 1 and 4000)
);

comment on table public.messages is
  'Text in M1. READ is membership; WRITE additionally requires the '
  'communication gate to permit it — a revoked approval leaves the thread '
  'readable and closes writes.';

-- The only read pattern that matters.
create index messages_thread_idx on public.messages (conversation_id, created_at desc);
create index messages_flagged_idx
  on public.messages (moderation_status)
  where moderation_status = 'flagged';

-- -----------------------------------------------------------------------------
-- message_reads — unread counts, and read receipts the owner can suppress
--
-- The row exists REGARDLESS of `send_read_receipts`: unread counts are the
-- reader's own feature and must work whether or not they tell anyone. The
-- suppression is applied by the API when reporting the OTHER side's position.
-- -----------------------------------------------------------------------------

create table public.message_reads (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references public.conversations (id) on delete cascade,
  user_id              uuid not null references public.users (id) on delete restrict,
  last_read_message_id uuid references public.messages (id) on delete set null,
  last_read_at         timestamptz not null default now(),

  constraint message_reads_key unique (conversation_id, user_id)
);

-- =============================================================================
-- app.conversation_member — membership, and nothing more
--
-- The READ question. Deliberately says nothing about the gate: a participant
-- whose approval was revoked may still read what was already said.
-- =============================================================================

create or replace function app.conversation_member(viewer uuid, conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.conversation_participants p
    where p.conversation_id = conversation
      and p.user_id = viewer
      and p.left_at is null
  )
$$;

comment on function app.conversation_member(uuid, uuid) is
  'Membership only. Answers the READ question; says nothing about whether '
  'the gate currently permits writing.';

revoke all on function app.conversation_member(uuid, uuid) from public;
grant execute on function app.conversation_member(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- app.can_write_message — the WRITE question, which is a different one
--
-- Four conditions, and every one of them has closed a real hole somewhere in
-- this schema already:
--
--   1. a participant who has not left, and who may write at all;
--   2. the match is NOT ended — 0019 warned that an ended match can still be
--      sitting in `open`, so the state alone is not enough;
--   3. the communication gate permits it — `open` or `family_approved`, never
--      `pending_family_review`, `family_rejected`, `revoked` or `blocked`;
--   4. no block exists in either direction.
--
-- Mirrored in the insert policy AND enforced in the route. Belt and braces on
-- purpose: this is the predicate that decides whether a family's decision
-- means anything.
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
  )
$$;

comment on function app.can_write_message(uuid, uuid) is
  'Membership AND an open gate AND a live match AND no block. The read '
  'policy asks a different question deliberately (ERD section 11).';

revoke all on function app.can_write_message(uuid, uuid) from public;
grant execute on function app.can_write_message(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- app.open_conversation_for_match — the trigger that cannot forget
--
-- Fires when a match's state first permits writing, from whichever direction:
-- a match created `open`, a delegate approving, or a revival. Creates the
-- thread, its stage row and both participants, once.
-- =============================================================================

create or replace function app.open_conversation_for_match()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- NOT `conversation_id`: that is also a column name on three of the tables
  -- written below, and PL/pgSQL resolves the variable first, so every
  -- reference became "column reference is ambiguous" at runtime.
  conv_id uuid;
begin
  if new.communication_state not in ('open', 'family_approved') then
    return new;
  end if;

  -- `do nothing` and then select: one thread per match forever, and a
  -- re-approval after a revocation must reuse it rather than start a second
  -- thread beside the history.
  insert into public.conversations (match_id)
  values (new.id)
  on conflict (match_id) do nothing;

  select id into conv_id
  from public.conversations
  where match_id = new.id;

  insert into public.conversation_stages (conversation_id)
  values (conv_id)
  on conflict (conversation_id) do nothing;

  insert into public.conversation_participants (conversation_id, user_id)
  values (conv_id, new.user_a_id), (conv_id, new.user_b_id)
  on conflict (conversation_id, user_id) do update set left_at = null;

  return new;
end;
$$;

comment on function app.open_conversation_for_match() is
  'AFTER INSERT OR UPDATE on matches. Creates the thread the first time the '
  'gate permits writing, from whichever path opened it — a route cannot be '
  'relied on to remember, and a thread created in order to forbid it would '
  'put the gate in the wrong place.';

create trigger matches_open_conversation
  after insert or update of communication_state on public.matches
  for each row execute function app.open_conversation_for_match();

-- =============================================================================
-- last_message_at, maintained by the database
--
-- Derived state the API would otherwise have to remember to write on every
-- send path. One trigger, and `active` stays derivable.
-- =============================================================================

create or replace function app.touch_conversation_on_message()
returns trigger
language plpgsql
-- SECURITY DEFINER because this fires on a MEMBER's insert, and members hold
-- SELECT on `conversations` and nothing else. Without it the trigger runs as
-- the sender and every legitimate send fails with "permission denied for
-- table conversations" — the member is not being denied their message, they
-- are being denied the bookkeeping that follows it.
--
-- Safe to elevate: it writes one derived column on the conversation the
-- message was just accepted into, and that acceptance already passed
-- `messages_insert_when_permitted`.
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id
     and (last_message_at is null or last_message_at < new.created_at);
  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function app.touch_conversation_on_message();

-- =============================================================================
-- RLS
--
-- `messages` is the one table where a member holds BOTH select and insert, so
-- the two policies are written next to each other and answer the two
-- different questions on purpose.
--
-- No member UPDATE or DELETE on `messages`: editing and deleting are server
-- state (`edited_at`, `deleted_at`) that `report_evidence` depends on, and a
-- member who could delete rows could destroy the case against themselves
-- before a moderator ever saw it.
-- =============================================================================

select app.enable_rls('public.conversations');
select app.enable_rls('public.conversation_participants');
select app.enable_rls('public.conversation_stages');
select app.enable_rls('public.stage_transitions');
select app.enable_rls('public.messages');
select app.enable_rls('public.message_reads');

grant all on public.conversations to service_role;
grant all on public.conversation_participants to service_role;
grant all on public.conversation_stages to service_role;
grant all on public.stage_transitions to service_role;
grant all on public.messages to service_role;
grant all on public.message_reads to service_role;

grant select on public.conversations to authenticated;
grant select on public.conversation_participants to authenticated;
grant select on public.conversation_stages to authenticated;
grant select on public.messages to authenticated;
grant select on public.message_reads to authenticated;
-- `stage_transitions` is RLS `system` per ERD §11: a proposal is read through
-- the API, which decides what each side may see about it.

create policy conversations_select_member
  on public.conversations for select to authenticated
  using (app.conversation_member(app.current_user_id(), id));

create policy conversation_participants_select_member
  on public.conversation_participants for select to authenticated
  using (app.conversation_member(app.current_user_id(), conversation_id));

create policy conversation_stages_select_member
  on public.conversation_stages for select to authenticated
  using (app.conversation_member(app.current_user_id(), conversation_id));

-- READ: membership. A revoked thread stays readable.
create policy messages_select_member
  on public.messages for select to authenticated
  using (app.conversation_member(app.current_user_id(), conversation_id));

-- WRITE: membership AND the gate. The sender must also be themselves —
-- `sender_user_id` is checked here as well as in the route, so a direct Data
-- API insert cannot put words in the counterpart's mouth.
grant insert (conversation_id, sender_user_id, body, kind) on public.messages to authenticated;

create policy messages_insert_when_permitted
  on public.messages for insert to authenticated
  with check (
    sender_user_id = app.current_user_id()
    and app.can_write_message(app.current_user_id(), conversation_id)
  );

create policy message_reads_select_member
  on public.message_reads for select to authenticated
  using (app.conversation_member(app.current_user_id(), conversation_id));

-- =============================================================================
-- Realtime
--
-- Supabase Realtime replays changes to subscribers through this publication,
-- and applies RLS per subscriber — so a member receives only messages in
-- threads `messages_select_member` already lets them read. Adding the table
-- here is what makes the subscription possible; it grants nothing that a
-- SELECT did not already grant.
--
-- `conversations` rides along so an unread badge updates without polling.
--
-- Wrapped because the publication is created by the Supabase platform and
-- does not exist in a bare Postgres — the migration tests run against PGlite,
-- where skipping this is correct rather than a failure.
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.messages';
    execute 'alter publication supabase_realtime add table public.conversations';
  end if;
end;
$$;
