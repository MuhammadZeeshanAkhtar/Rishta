-- =============================================================================
-- 0020 — notifications
--
-- Phase 6 Slice 5. The in-app inbox, which the contract calls "the source of
-- truth; push is one delivery channel". Push, email and quiet hours are not
-- in this slice and nothing here assumes them.
--
-- SHAPE follows ERD §17 exactly: `user_id` · `type` · `payload jsonb` ·
-- `read_at`, with the two indexes it names — the inbox read and the unread
-- badge count.
--
-- THE TYPE LIST is the contract's `Notification.type` enum in full, not a
-- subset. Unlike `interest_events`, where an unproducible value would describe
-- a transition nothing can perform, these are a product taxonomy: every one of
-- the twelve is a real notification this product will send, and constraining
-- to the three Phase 6 can produce today would mean a migration per slice for
-- no safety gained.
-- =============================================================================

create table public.notifications (
  user_id     uuid not null references public.users (id) on delete restrict,
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  -- Idempotency. See the unique constraint below.
  dedupe_key  text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint notifications_type_valid check (
    type in (
      'interest_received', 'interest_accepted', 'new_match', 'new_message',
      'photo_request', 'photo_request_answered', 'family_invitation',
      'family_invitation_answered', 'stage_advance_proposed',
      'verification_update', 'security_alert', 'report_update'
    )
  ),
  constraint notifications_payload_object check (jsonb_typeof(payload) = 'object'),

  -- THE DUPLICATE GUARD, and the reason it is keyed this way.
  --
  -- The originating transactions already make a repeat impossible — a second
  -- acceptance is refused with 409 before anything is written, and a match is
  -- only notified when a row was actually created or revived. This is the
  -- backstop for that, so a future call site cannot quietly double-send.
  --
  -- The key must identify the EVENT, not the entity. A rematched pair reuses
  -- its `matches` row (created -> ended -> created), so keying `new_match` on
  -- the match id alone would silently swallow the second match — the one thing
  -- the people involved would most want to hear about. The revival writes a
  -- new `interest_id`, so the key carries both and the second notification is
  -- a different event.
  constraint notifications_dedupe_key unique (user_id, type, dedupe_key)
);

comment on table public.notifications is
  'In-app inbox, and the source of truth. Push is a delivery channel over the '
  'same rows, not a second store.';

comment on column public.notifications.payload is
  'IDENTIFIERS ONLY. A notification is delivered once and read later, so a '
  'name or photo copied in here would outlive the permission that allowed it. '
  'The client resolves the actor through the normal reads, which re-apply '
  'visibility at the moment of reading.';

comment on column public.notifications.dedupe_key is
  'Identifies the EVENT, not the entity — a rematch reuses its match row and '
  'must still notify.';

-- The inbox read.
create index notifications_inbox_idx on public.notifications (user_id, created_at desc);
-- The unread badge count.
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- =============================================================================
-- RLS — owner, and system-written
--
-- A member reads their own and marks them read. They cannot INSERT one: a
-- member who could would forge a "you have a new match" from someone who never
-- matched them. They cannot DELETE one either, because `security_alert` is in
-- this table and an alert the subject can erase is not an alert.
--
-- The write grant is COLUMN-LEVEL on `read_at` alone, so marking something
-- read cannot become rewriting its type or payload.
-- =============================================================================

select app.enable_rls('public.notifications');

grant all on public.notifications to service_role;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy notifications_select_own
  on public.notifications for select to authenticated
  using (user_id = app.current_user_id());

-- The row stays visible to the SELECT policy after the update, which is what
-- FORCE ROW LEVEL SECURITY requires (the lesson migration 0008 records).
create policy notifications_update_own
  on public.notifications for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
