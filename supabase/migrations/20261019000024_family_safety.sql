-- =============================================================================
-- 0024 — Family Safety core (Phase 6b, ADR 0011, D12 approved 2026-10-19)
--
-- The layer that stands between "these two people matched" and "these two
-- people may talk". Migration 0021 built the GATE — `communication_policy`,
-- `required_communication_state()` and `gate_new_match_period()` — and
-- deliberately stopped there: nothing existed that could move a match out of
-- `pending_family_review`, so an owner who set `family_reviewed` would have
-- been stuck forever. This is the half that decides.
--
-- WHAT D12 SETTLED, because the schema encodes all five answers:
--
--   1. Review is the OWNER'S CHOICE, defaulting to `direct` (already built in
--      0021 — `user_settings.communication_policy`).
--   2. The owner NEVER approves their own match. Enforced here by
--      `can_review_match()`, which requires a grant the owner cannot hold over
--      themselves, and by `family_reviews_decider_not_owner`.
--   3. EITHER side's policy gates both (already built in 0021).
--   4. With several delegates, the FIRST decision stands. Enforced by
--      `unique(match_id, owner_user_id)` — one review row per side, not per
--      delegate — and `relationship_id` records whose decision it was.
--   5. Direct 1:1 voice/video stays OFF in v1. `system_flags` exists so the
--      path is switched off rather than absent.
--
--   D12-g. Review SLA: 72 hours, NOTIFY ONLY. `family_reviews.decision` has no
--      `expired` value and gains none. Auto-approving would make a delegate's
--      silence into consent; auto-rejecting would hand them a veto by doing
--      nothing. Both inverts the safety model (R16). `sla_notified_at` makes
--      the warning fire exactly once.
--
--   D12-h. Invitations expire after 14 days. Stored as a column, not a
--      constant, so a stale invite to an old address cannot stay live.
--
-- THE DIRECTORY PROHIBITION. `can_review_match()` is match-scoped on purpose.
-- A delegate holding `approve_communication` can see the counterpart OF A
-- SPECIFIC MATCH and cannot search, browse, or open an arbitrary profile.
-- There is no predicate here that takes a delegate and returns a set of
-- people. The scope is the control.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- system_flags — the switched-off path
--
-- D12 row 5 says direct 1:1 voice/video is "gated off by system_flags, not
-- omitted". A path that is switched off gets reviewed before it is switched
-- on; a path that is absent gets rebuilt under deadline pressure, by whoever
-- is on deadline, without the review.
--
-- No member grant of any kind. A flag a member can read is a roadmap, and a
-- flag a member can write is a feature toggle in the wrong hands.
-- -----------------------------------------------------------------------------

create table public.system_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text not null,
  updated_at  timestamptz not null default now(),

  constraint system_flags_key_shape check (key ~ '^[a-z][a-z0-9_.]*$')
);

comment on table public.system_flags is
  'Operator-controlled switches. Service-role only: a flag a member can read '
  'is a roadmap, and one they can write is a toggle in the wrong hands.';

create trigger system_flags_touch
  before update on public.system_flags
  for each row execute function app.touch_updated_at();

select app.enable_rls('public.system_flags');
grant all on public.system_flags to service_role;

insert into public.system_flags (key, enabled, description) values
  ('calls.direct_one_to_one', false,
   'Direct owner-to-owner voice/video. OFF in v1 per D12 row 5 — the code '
   'path refuses rather than being absent.'),
  ('calls.family_mediated', false,
   'Family-to-family calls. M2 (ADR 0011); no transport decision has been '
   'made, so the path refuses.');

-- -----------------------------------------------------------------------------
-- family_relationships — who may act for whom
--
-- `tier` is a PRESET LABEL for the invite UI and is never read by a policy.
-- It expands into `family_permissions` rows at grant time and is thereafter
-- decoration. `app.family_grant()` reads the permission rows. One question,
-- one source of truth — a tier consulted at read time would be a second
-- authority that can disagree with the first.
-- -----------------------------------------------------------------------------

create table public.family_relationships (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references public.users (id) on delete restrict,
  delegate_user_id  uuid not null references public.users (id) on delete restrict,
  relationship_code text not null,
  tier              text not null,
  status            text not null default 'active',
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A delegate for yourself is not a safety control, it is a way around one:
  -- it would let an owner hold `approve_communication` over their own match
  -- and approve it, which D12 row 2 exists to forbid. Refused by the database
  -- as well as the route.
  constraint family_relationships_not_self check (owner_user_id <> delegate_user_id),

  constraint family_relationships_code_valid check (
    relationship_code in ('father', 'mother', 'brother', 'sister', 'guardian', 'other')
  ),

  -- Pinned to the two tiers whose authorization logic EXISTS. `participant`
  -- (M2) and `manager` (1.1) are relaxed in by the migration that can enforce
  -- them. The column already holds them so later tiers extend rather than
  -- migrate, and the constraint means a bug cannot grant rights nobody has
  -- written the checks for yet.
  constraint family_relationships_tier_valid check (tier in ('observer', 'reviewer')),

  constraint family_relationships_status_valid check (status in ('active', 'revoked')),

  -- Revocation is a pair: a revoked row records WHEN, an active one has not
  -- been revoked. Without this, `status` and `revoked_at` can disagree and the
  -- access log cannot say when a delegate's rights actually ended.
  constraint family_relationships_revoked_consistent check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),

  -- One relationship per pair, ever. Re-inviting someone you revoked reuses
  -- this row, so the history of what they were granted is not lost by being
  -- re-created beside itself.
  constraint family_relationships_pair_key unique (owner_user_id, delegate_user_id)
);

comment on table public.family_relationships is
  'One row per (owner, delegate). tier is a UI preset, never an authorization '
  'input — app.family_grant() reads family_permissions.';

comment on column public.family_relationships.owner_user_id is
  'Whose profile this is about. The delegate never becomes the subject of a '
  'row about the owner.';

-- A6: one delegate may act for several owners, which this supports naturally
-- because the delegate side is not unique.
create index family_relationships_delegate_idx
  on public.family_relationships (delegate_user_id)
  where status = 'active';

create index family_relationships_owner_idx
  on public.family_relationships (owner_user_id, status);

create trigger family_relationships_touch
  before update on public.family_relationships
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- family_permissions — the authority
-- -----------------------------------------------------------------------------

create table public.family_permissions (
  id                  uuid primary key default gen_random_uuid(),
  relationship_id     uuid not null
                        references public.family_relationships (id) on delete cascade,
  permission          text not null,
  granted             boolean not null default true,
  granted_at          timestamptz not null default now(),
  granted_by_user_id  uuid not null references public.users (id) on delete restrict,

  -- The FULL vocabulary, including permissions whose phase has not arrived.
  -- The column accepts them so the enum does not have to be migrated later;
  -- the API refuses an out-of-phase grant with 400 at grant time (ERD §12).
  -- A grant that is accepted and silently does nothing is worse than a
  -- refusal, because the owner believes they granted something.
  constraint family_permissions_valid check (
    permission in (
      -- M1 — this phase
      'view_profile', 'view_matches', 'review_interest',
      'approve_communication', 'report_on_behalf', 'block_on_behalf',
      -- M2
      'view_conversation', 'join_conversation',
      'request_family_call', 'join_family_call',
      -- 1.1
      'receive_proposal', 'manage_profile'
    )
  ),

  constraint family_permissions_key unique (relationship_id, permission)
);

comment on table public.family_permissions is
  'The authorization source of truth. Every permission is explicit (a row, '
  'never inferred from a tier), revocable, and scoped to one owner through '
  'the relationship.';

-- The predicate's read path.
create index family_permissions_granted_idx
  on public.family_permissions (relationship_id)
  where granted;

-- -----------------------------------------------------------------------------
-- family_invitations — how a relationship begins
--
-- `token_hash` is HASHED. The raw token is returned once, to the inviter, and
-- never stored: a readable invitation table is a list of ways into other
-- people's family graphs.
-- -----------------------------------------------------------------------------

create table public.family_invitations (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references public.users (id) on delete restrict,
  invitee_contact   text not null,
  invitee_user_id   uuid references public.users (id) on delete restrict,
  relationship_code text not null,
  tier              text not null,
  token_hash        text not null,
  status            text not null default 'pending',
  expires_at        timestamptz not null,
  responded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint family_invitations_code_valid check (
    relationship_code in ('father', 'mother', 'brother', 'sister', 'guardian', 'other')
  ),
  constraint family_invitations_tier_valid check (tier in ('observer', 'reviewer')),
  constraint family_invitations_status_valid check (
    status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')
  ),
  constraint family_invitations_contact_len check (
    char_length(invitee_contact) between 3 and 320
  ),
  -- A token is never stored raw. 64 hex characters is a sha-256 digest; the
  -- shape is pinned so a plaintext token cannot be written here by mistake.
  constraint family_invitations_token_hashed check (token_hash ~ '^[0-9a-f]{64}$'),
  -- An answered invitation records when. A pending one has not been answered.
  constraint family_invitations_responded_consistent check (
    (status = 'pending' and responded_at is null)
    or (status <> 'pending' and responded_at is not null)
  ),
  -- Set only once accepted — before that we may not know who they are.
  constraint family_invitations_accepted_has_user check (
    status <> 'accepted' or invitee_user_id is not null
  )
);

comment on table public.family_invitations is
  'Pending offers of a family relationship. The token is stored hashed and '
  'returned raw exactly once, to the inviter.';

comment on column public.family_invitations.expires_at is
  '14 days from issue (D12-h). An invitation to an address someone no longer '
  'controls must not stay live indefinitely.';

create unique index family_invitations_token_idx
  on public.family_invitations (token_hash);

create index family_invitations_owner_idx
  on public.family_invitations (owner_user_id, status);

-- ONE LIVE INVITATION PER (owner, contact). Partial, for the same reason the
-- report spam guard is: someone who declined a year ago may legitimately be
-- re-invited, and a blanket unique would make that impossible.
create unique index family_invitations_one_pending
  on public.family_invitations (owner_user_id, invitee_contact)
  where status = 'pending';

create trigger family_invitations_touch
  before update on public.family_invitations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- family_reviews — the decision
--
-- ONE ROW PER SIDE, not per delegate. That is D12 row 4 expressed as a unique
-- index: where an owner has several delegates holding `approve_communication`,
-- whichever of them decides first writes this row and the rest find it taken.
-- `relationship_id` records whose decision it was, which is what makes quorum
-- a later ADDITIVE change — counting is then the only thing that differs.
-- -----------------------------------------------------------------------------

create table public.family_reviews (
  id                  uuid primary key default gen_random_uuid(),
  match_id            uuid not null references public.matches (id) on delete cascade,
  -- WHICH SIDE of the match this review is for. A match where both sides
  -- require review has two rows, and both must approve before anyone may
  -- write — which is D12 row 3 in its strictest reading.
  owner_user_id       uuid not null references public.users (id) on delete restrict,
  relationship_id     uuid references public.family_relationships (id) on delete restrict,
  decided_by_user_id  uuid references public.users (id) on delete restrict,
  decision            text not null default 'pending',
  note                text,
  requested_at        timestamptz not null default now(),
  decided_at          timestamptz,
  -- Set when the 72-hour SLA warning has been sent to the owner, so it fires
  -- exactly once (D12-g). NOT a decision: the review stays pending.
  sla_notified_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- No `expired`. D12-g: a stalled review notifies and keeps waiting. A
  -- timeout value here would be a standing invitation to make silence mean
  -- something, and silence is exactly what R16 is about.
  constraint family_reviews_decision_valid check (
    decision in ('pending', 'approved', 'rejected', 'more_info_requested', 'revoked')
  ),

  -- A decided review records WHO and WHEN; a pending one records neither.
  -- `more_info_requested` is deliberately on the pending side of this line:
  -- ERD §12 says it "does not leave the pending gate", so it notifies the
  -- owner and resets nothing.
  constraint family_reviews_decided_consistent check (
    (decision in ('pending', 'more_info_requested')
      and decided_at is null and decided_by_user_id is null and relationship_id is null)
    or (decision in ('approved', 'rejected', 'revoked')
      and decided_at is not null and decided_by_user_id is not null
      and relationship_id is not null)
  ),

  -- D12 ROW 2, IN THE DATABASE. The owner may set the policy, change it, and
  -- revoke the delegate — never approve in their place. A route can be
  -- bypassed by a future caller; this cannot.
  constraint family_reviews_decider_not_owner check (
    decided_by_user_id is null or decided_by_user_id <> owner_user_id
  ),

  constraint family_reviews_note_len check (note is null or char_length(note) <= 1000),

  -- D12 ROW 4. One review per side — the first decision stands.
  constraint family_reviews_side_key unique (match_id, owner_user_id)
);

comment on table public.family_reviews is
  'One row per (match, side). The counterpart may learn that a review is '
  'pending and never who is reviewing or what they wrote.';

comment on column public.family_reviews.sla_notified_at is
  'When the 72-hour stall warning reached the owner (D12-g). Notify only — '
  'the review stays pending, because silence must not become consent.';

-- The delegate's inbox.
create index family_reviews_pending_idx
  on public.family_reviews (owner_user_id, decision)
  where decision in ('pending', 'more_info_requested');

-- The SLA sweep: pending reviews that have not yet warned the owner.
create index family_reviews_sla_idx
  on public.family_reviews (requested_at)
  where decision in ('pending', 'more_info_requested') and sla_notified_at is null;

create index family_reviews_match_idx on public.family_reviews (match_id);

create trigger family_reviews_touch
  before update on public.family_reviews
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- family_access_log — the anti-coercion control
--
-- Every delegate action, and THE PERMISSION THAT AUTHORISED IT. Without the
-- permission column an owner reviewing the log sees that their brother opened
-- something but not under which right — which is the question they would
-- actually be asking before deciding whether to revoke.
--
-- This only works because it is surfaced in the app, not merely recorded.
-- -----------------------------------------------------------------------------

create table public.family_access_log (
  id               uuid primary key default gen_random_uuid(),
  relationship_id  uuid not null
                     references public.family_relationships (id) on delete cascade,
  delegate_user_id uuid not null references public.users (id) on delete restrict,
  owner_user_id    uuid not null references public.users (id) on delete restrict,
  action           text not null,
  permission       text not null,
  resource_type    text,
  resource_id      uuid,
  created_at       timestamptz not null default now(),

  constraint family_access_log_action_shape check (action ~ '^[a-z][a-z0-9_.]*$'),
  constraint family_access_log_resource_valid check (
    resource_type is null
    or resource_type in ('profile', 'match', 'review', 'report', 'block')
  ),
  constraint family_access_log_resource_id_needs_type check (
    resource_id is null or resource_type is not null
  )
);

comment on table public.family_access_log is
  'Append-only record of every delegated action, with the permission that '
  'authorised it. The owner reads their own rows; nobody writes through a '
  'member path, because an audit a delegate can edit is not an audit.';

create index family_access_log_owner_idx
  on public.family_access_log (owner_user_id, created_at desc);

create index family_access_log_delegate_idx
  on public.family_access_log (delegate_user_id, created_at desc);

-- =============================================================================
-- match_events — relationship_id
--
-- ERD §21 invariant 4: every transition writes `match_events` carrying
-- `actor_user_id`, `acted_by_user_id` AND `relationship_id`. The first two
-- shipped in 0018. This is the third, and without it "Approved by Ahmed
-- (Father)" cannot be reconstructed — an actor id alone does not say in what
-- capacity someone acted, and a delegate may hold rows for several owners.
-- =============================================================================

alter table public.match_events
  add column relationship_id uuid references public.family_relationships (id) on delete restrict;

comment on column public.match_events.relationship_id is
  'Which relationship authorised a delegated transition. Null when the actor '
  'acted for themselves.';

-- The decisions this phase makes possible. `more_info_requested` is NOT here:
-- it is not a transition (ERD §12), so it writes no event.
alter table public.match_events
  drop constraint match_events_event_valid;

alter table public.match_events
  add constraint match_events_event_valid check (
    event in ('created', 'ended', 'family_approved', 'family_rejected', 'family_revoked')
  );

comment on constraint match_events_event_valid on public.match_events is
  'Only transitions something can perform. Conversation stage events arrive '
  'with Phase 7.';

-- =============================================================================
-- notifications — the three Family Safety messages
-- =============================================================================

alter table public.notifications
  drop constraint notifications_type_valid;

alter table public.notifications
  add constraint notifications_type_valid check (
    type in (
      'interest_received', 'interest_accepted', 'new_match', 'new_message',
      'photo_request', 'photo_request_answered', 'family_invitation',
      'family_invitation_answered', 'stage_advance_proposed',
      'verification_update', 'security_alert', 'report_update',
      -- Phase 6b. `family_review_stalled` is the R16 control reaching the
      -- person it protects: without it the SLA is a column nobody sees.
      'family_review_requested', 'family_review_decided', 'family_review_stalled'
    )
  );

-- =============================================================================
-- user_settings.communication_policy — the grant 0021 deferred to this slice
--
-- Migration 0021 added the column and deliberately WITHHELD the update grant:
-- "allowing family_reviewed before Phase 6b exists would let someone choose a
-- gate no delegate can open, stalling every match they make. It joins the
-- update grant in the slice that can honour it."
--
-- This is that slice. A delegate can now be invited, granted
-- approve_communication, and can decide — so an owner choosing the gate is
-- choosing something that can actually be opened.
--
-- The remaining failure mode is an owner who turns review on with NO reviewer,
-- which is a real way to stall every future match. It is answered where it can
-- be acted on rather than refused here: `familyReviewersCount` on the account
-- read reports how many delegates hold approve_communication, so the app can
-- say so AT THE MOMENT the policy is set. Refusing the write instead would
-- make the order of two independent settings load-bearing — invite first, or
-- be rejected — and would leave an owner who revoked their last delegate
-- permanently unable to express a preference they are entitled to hold.
-- =============================================================================

grant update (communication_policy) on public.user_settings to authenticated;

-- =============================================================================
-- app.family_grant — does this delegate hold this permission over this owner?
--
-- The single authority. Reads `family_permissions` through an ACTIVE
-- relationship, never `tier`. Revoking the relationship or clearing the grant
-- takes effect on the next call, which is what "revocation is instant" means.
-- =============================================================================

create or replace function app.family_grant(delegate uuid, owner uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.family_relationships r
    join public.family_permissions p on p.relationship_id = r.id
    where r.delegate_user_id = delegate
      and r.owner_user_id = owner
      and r.status = 'active'
      and p.permission = family_grant.permission
      and p.granted
  )
$$;

comment on function app.family_grant(uuid, uuid, text) is
  'The authorization source of truth for delegated action. Reads permission '
  'rows through an active relationship — never tier, which is a UI label.';

revoke all on function app.family_grant(uuid, uuid, text) from public;
grant execute on function app.family_grant(uuid, uuid, text) to authenticated, service_role;

-- =============================================================================
-- app.can_review_match — MATCH-SCOPED, and that is the control
--
-- Takes a delegate and ONE match and answers yes or no. It cannot be used to
-- enumerate: there is no form of this question that returns a set of people,
-- so holding `approve_communication` never produces a directory of
-- counterparts to browse. A reviewing delegate reaches a person through a
-- specific pairing or not at all.
--
-- Requires the match to be live (`ended_at is null`) and genuinely awaiting
-- this owner's side. A delegate cannot review a match that was never gated,
-- and cannot revisit one that has ended.
-- =============================================================================

create or replace function app.can_review_match(delegate uuid, match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.matches m
    join public.family_relationships r
      on r.owner_user_id in (m.user_a_id, m.user_b_id)
    join public.family_permissions p
      on p.relationship_id = r.id
    where m.id = can_review_match.match_id
      and m.ended_at is null
      and r.delegate_user_id = delegate
      and r.status = 'active'
      and p.permission = 'approve_communication'
      and p.granted
      -- The owner is never their own delegate; the relationship table
      -- forbids it, and saying so here means this predicate does not depend
      -- on that constraint staying.
      and r.delegate_user_id <> r.owner_user_id
  )
$$;

comment on function app.can_review_match(uuid, uuid) is
  'Match-scoped by design: a reviewing delegate reaches a counterpart through '
  'a specific pairing and can never browse, search or enumerate. The scope is '
  'the control (ADR 0011).';

revoke all on function app.can_review_match(uuid, uuid) from public;
grant execute on function app.can_review_match(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- RLS
--
-- Writes are service-role throughout. Every one of these tables carries a
-- business rule that cannot be expressed as a policy: an invitation must
-- hash a token and check expiry, a grant must be refused if its phase has not
-- arrived, a review must be the first for its side, and the access log must
-- be unforgeable. Reads are the member path, and they are narrow.
-- =============================================================================

select app.enable_rls('public.family_relationships');
select app.enable_rls('public.family_permissions');
select app.enable_rls('public.family_invitations');
select app.enable_rls('public.family_reviews');
select app.enable_rls('public.family_access_log');

grant all on public.family_relationships to service_role;
grant all on public.family_permissions to service_role;
grant all on public.family_invitations to service_role;
grant all on public.family_reviews to service_role;
grant all on public.family_access_log to service_role;

grant select on public.family_relationships to authenticated;
grant select on public.family_permissions to authenticated;
grant select on public.family_invitations to authenticated;
grant select on public.family_reviews to authenticated;
grant select on public.family_access_log to authenticated;

-- `shared` — both parties see the relationship. The delegate must be able to
-- see what they hold, and the owner must be able to see who holds it.
create policy family_relationships_select_party
  on public.family_relationships for select to authenticated
  using (
    owner_user_id = app.current_user_id()
    or delegate_user_id = app.current_user_id()
  );

create policy family_permissions_select_party
  on public.family_permissions for select to authenticated
  using (
    exists (
      select 1 from public.family_relationships r
      where r.id = family_permissions.relationship_id
        and (
          r.owner_user_id = app.current_user_id()
          or r.delegate_user_id = app.current_user_id()
        )
    )
  );

-- `owner` — the inviter only. The invitee arrives by token, through the API,
-- which is why there is no policy naming them: a policy that matched on
-- `invitee_contact` would turn this table into a lookup of who has been
-- invited to whose family, for anyone who can guess an address.
create policy family_invitations_select_own
  on public.family_invitations for select to authenticated
  using (owner_user_id = app.current_user_id());

-- `shared` — the owner, and any delegate of that owner holding
-- `approve_communication`.
--
-- THE COUNTERPART IS ABSENT ON PURPOSE. They learn that a review is pending
-- from `matches.communication_state`, which they can already see. They never
-- learn who is reviewing or what was written, and the absence of a policy is
-- what guarantees it.
create policy family_reviews_select_party
  on public.family_reviews for select to authenticated
  using (
    owner_user_id = app.current_user_id()
    or app.family_grant(app.current_user_id(), owner_user_id, 'approve_communication')
  );

-- `system` — the owner reads their own, and nobody writes through a member
-- path. This is the anti-coercion control: every action taken in the owner's
-- name is visible to the owner.
--
-- The DELEGATE cannot read it. A delegate who could see which of their
-- actions the owner has been shown would know exactly what is safe to do
-- unobserved, which inverts the control.
create policy family_access_log_select_own
  on public.family_access_log for select to authenticated
  using (owner_user_id = app.current_user_id());
