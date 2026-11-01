-- =============================================================================
-- 0026 — Code review remediation, Phase 1 (review dated 2026-10-28)
--
-- Database half of B1, B3 and B7. Every change here is forward-only and
-- additive in effect: nothing is dropped that a correct caller uses, and no
-- earlier migration is edited.
--
--   B1  One family's approval could override the other family's rejection.
--       The route is fixed too, but a state machine that is only enforced in
--       TypeScript is one future caller away from being wrong again.
--
--   B3  "Pause discovery" and "Incognito" were stored and never read.
--       Incognito is also a PAID entitlement that any member could set.
--
--   B7  Members can reach the Supabase Data API directly with their own JWT.
--       The complete fix is a dashboard setting (remove `public` from the
--       exposed schemas), which is a live project change and is NOT made here.
--       This closes the specific bypasses that matter regardless of that
--       setting, so the database stays correct even while the API is exposed.
-- =============================================================================

-- =============================================================================
-- B1 — family approval can only follow EVERY side approving
--
-- The defect: the approve path counted sibling reviews still `pending` or
-- `more_info_requested`. A sibling that was already `rejected` matched neither,
-- the count came back zero, and the match moved to `family_approved` — opening
-- a conversation against one household's explicit refusal.
--
-- The invariant, stated where it cannot be skipped: a match may ENTER
-- `family_approved` only when no review for it is anything other than
-- `approved`. A rejected, revoked, pending or more-info review blocks it.
--
-- BEFORE UPDATE OF communication_state, and it only acts on a transition INTO
-- `family_approved`. Every other transition passes untouched, so the gate
-- trigger (0021), revocation and blocking are unaffected.
-- =============================================================================

create or replace function app.guard_family_approval()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.communication_state = 'family_approved'
     and old.communication_state is distinct from 'family_approved'
     and exists (
       select 1 from public.family_reviews r
        where r.match_id = new.id
          and r.decision <> 'approved'
     )
  then
    raise exception 'family_approved requires every family review for this match to be approved'
      using errcode = 'check_violation',
            hint = 'B1: a rejection by one household cannot be overridden by the other.';
  end if;
  return new;
end;
$$;

comment on function app.guard_family_approval() is
  'BEFORE UPDATE OF communication_state on matches. Refuses entry into '
  'family_approved while any family review for the match is not approved — '
  'one household''s rejection is final for that match period (B1).';

create trigger matches_guard_family_approval
  before update of communication_state on public.matches
  for each row execute function app.guard_family_approval();

-- =============================================================================
-- B3 — entitlements, readable by SQL
--
-- The free plan lives in code (`FREE_PLAN_ENTITLEMENTS`), and every boolean
-- flag in it is `false`. So a flag is granted exactly when an unexpired
-- override row holds the JSON boolean `true` — the same rule
-- `loadEntitlements()` applies, where a value of the wrong shape is treated as
-- absent. If a flag ever defaults to true in the free plan, this function must
-- change with it.
-- =============================================================================

create or replace function app.has_entitlement_flag(member uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_entitlements e
     where e.user_id = member
       and e.entitlement_key = key
       and jsonb_typeof(e.value) = 'boolean'
       and e.value = 'true'::jsonb
       and (e.expires_at is null or e.expires_at > now())
  )
$$;

comment on function app.has_entitlement_flag(uuid, text) is
  'True when an unexpired override grants a BOOLEAN entitlement. Mirrors '
  'loadEntitlements(): the free plan grants no flag, and a wrongly shaped '
  'value counts as absent.';

revoke all on function app.has_entitlement_flag(uuid, text) from public;
grant execute on function app.has_entitlement_flag(uuid, text) to authenticated, service_role;

-- =============================================================================
-- B3 — Incognito cannot be switched on without the entitlement
--
-- The route checks first and answers 403 entitlement_required. This is the
-- backstop for the path the route cannot see: a member writing
-- `user_settings.incognito` straight through the Data API, which their column
-- grant (migration 0003) allows.
--
-- Only the transition false -> true is gated. Turning it OFF is always
-- allowed, and a member whose entitlement lapsed while incognito is not
-- trapped in a setting they can no longer change.
-- =============================================================================

create or replace function app.guard_incognito_entitlement()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.incognito
     and (tg_op = 'INSERT' or not coalesce(old.incognito, false))
     and not app.has_entitlement_flag(new.user_id, 'incognito')
  then
    raise exception 'incognito requires the incognito entitlement'
      using errcode = 'insufficient_privilege',
            hint = 'B3: incognito is a paid entitlement and is enforced server-side.';
  end if;
  return new;
end;
$$;

comment on function app.guard_incognito_entitlement() is
  'BEFORE INSERT OR UPDATE OF incognito on user_settings. Turning incognito ON '
  'requires the entitlement; turning it off never does (B3).';

create trigger user_settings_guard_incognito
  before insert or update of incognito on public.user_settings
  for each row execute function app.guard_incognito_entitlement();

-- =============================================================================
-- B3 — app.discoverable_to: may this viewer FIND this member?
--
-- A narrower question than app.can_view_profile(), and deliberately a separate
-- function. can_view_profile() also governs interests, matches and the block
-- list; folding "paused" into it would make a paused member vanish from their
-- own matches and make their incoming interests unanswerable. Pausing hides
-- you from BROWSING. It does not unmake relationships you already have.
--
-- Three rules, all required:
--
--   1. can_view_profile()             — blocks, suspension, review status;
--   2. not discovery_paused           — the member asked to be hidden;
--   3. incognito, if EFFECTIVE        — only members they have expressed
--      interest in may find them.
--
-- "Effective" means switched on AND currently entitled. A member whose
-- subscription lapsed is visible again: the protection is the paid feature,
-- and continuing to provide it unpaid would be the bug.
--
-- "Expressed interest in" is the product's only like-action: an `interests`
-- row SENT by the incognito member TO the viewer, in any state but
-- `withdrawn` — withdrawing is taking the like back. A private shortlist save
-- does not count; the other person is never told about it.
-- =============================================================================

create or replace function app.discoverable_to(viewer uuid, target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.can_view_profile(viewer, target)
     and not exists (
       select 1
         from public.user_settings s
        where s.user_id = target
          and (
            s.discovery_paused
            or (
              s.incognito
              and app.has_entitlement_flag(target, 'incognito')
              and not exists (
                select 1 from public.interests i
                 where i.sender_user_id = target
                   and i.recipient_user_id = viewer
                   and i.status <> 'withdrawn'
              )
            )
          )
     )
$$;

comment on function app.discoverable_to(uuid, uuid) is
  'Discovery-only visibility: can_view_profile() AND not paused AND, when '
  'incognito is effective, only members the target has expressed interest '
  'in. Relationship surfaces keep using can_view_profile() (B3).';

revoke all on function app.discoverable_to(uuid, uuid) from public;
grant execute on function app.discoverable_to(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- B7 — messages: only text, never blank, from a member
--
-- The policy constrained who and where, but not WHAT. A member calling the
-- Data API could insert `kind = 'system'` — a message styled as a platform
-- notice — or a body of nothing but whitespace.
--
-- Three layers, because they close different doors. Two are here:
--
--   * the policy pins kind = 'text'. This is what actually refuses a member's
--     system notice, from the moment this migration lands.
--   * a CHECK refuses a blank body for EVERY role, including the service role:
--     there is no message — system notices included — that should be empty.
--
-- The third — `kind` leaving the member's column grant — is migration 0027,
-- NOT here. The API released before Phase 1 names `kind` (as 'text') in its
-- member insert; revoking the column in this migration would break every
-- message send from the moment it is applied until the new API is deployed.
-- Kept apart, the release is 0026 -> new API -> 0027 with no broken window,
-- and the policy above holds the line in between.
--
-- "Blank" means NO non-whitespace character, tested with `[^[:space:]]`. The
-- obvious `btrim(body) <> ''` is wrong: btrim strips only the space character
-- by default, so a body of tabs or newlines passed it. Found by this
-- migration's own regression test.
-- =============================================================================

alter table public.messages
  add constraint messages_body_not_blank check (body ~ '[^[:space:]]');

drop policy messages_insert_when_permitted on public.messages;

create policy messages_insert_when_permitted
  on public.messages for insert to authenticated
  with check (
    sender_user_id = app.current_user_id()
    and kind = 'text'
    and body ~ '[^[:space:]]'
    and app.can_write_message(app.current_user_id(), conversation_id)
  );

-- =============================================================================
-- B7 — interests: no member write path
--
-- Sending an interest consumes the daily quota in the SAME transaction as the
-- insert (ERD §16), which is only possible through the API's `interest.send`
-- service-role path — and that is the path the API has always used. The member
-- INSERT grant was never exercised by the product, and through the Data API it
-- let a member send interests without touching the quota at all, and without
-- the route's validation of the note.
--
-- The existing insert policy is left in place: with no grant it can never be
-- reached, and keeping it means restoring a grant later would not silently
-- reopen forgery as well.
-- =============================================================================

revoke insert on public.interests from authenticated;

-- =============================================================================
-- B4 — a deferred interest can be withdrawn without erasing the deferral
--
-- Migration 0018 tightened `interests_responded_consistent` so that
-- `withdrawn` requires `responded_at is null`, on the model that "a withdrawal
-- is the sender's act rather than a response". That held while `maybe_later`
-- was a dead end. Review B4 makes a deferred interest withdrawable, and a
-- deferred interest HAS been responded to: the recipient set it aside, at a
-- time that is recorded.
--
-- Clearing `responded_at` on withdrawal would make the row satisfy the old
-- rule by erasing a true fact from it. So the rule changes instead, and only
-- for `withdrawn`: a withdrawal may follow either an unanswered interest
-- (null) or a deferred one (the deferral time, kept). Every other branch stays
-- exactly as strict as 0018 made it — a pending interest is unanswered, and an
-- accepted, declined or deferred one records when.
--
-- Safe to replace in place: the new condition accepts every row the old one
-- did, so no existing row can violate it.
-- =============================================================================

alter table public.interests
  drop constraint interests_responded_consistent;

alter table public.interests
  add constraint interests_responded_consistent check (
    (status = 'pending' and responded_at is null)
    or (status in ('accepted', 'declined', 'maybe_later') and responded_at is not null)
    or status = 'withdrawn'
  );
