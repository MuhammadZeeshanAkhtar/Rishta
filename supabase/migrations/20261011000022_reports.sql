-- =============================================================================
-- 0022 — reports
--
-- The other half of "report and block". `blocks` has existed since 0011,
-- because `app.can_view_profile()` is built on it; this is the table that lets
-- someone tell us WHY, and the first piece of the safety pipeline that a human
-- will eventually read.
--
-- WHAT THIS IS NOT. There is no moderation queue, no case management, no
-- triage and no admin surface — those are Phase 8. This stores the report
-- truthfully and stops there, because a report that is captured badly cannot
-- be rescued later by a better dashboard.
--
-- `report_evidence` (ERD §14) is DELIBERATELY ABSENT. Its purpose is to
-- snapshot conversation and message content by value, so that a bad actor
-- deleting their messages does not destroy the case against them. No
-- conversation or message exists until Phase 7, so the table would have
-- nothing to snapshot and an empty evidence row would imply evidence was
-- considered and found. It arrives with the content it protects.
-- =============================================================================

create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_user_id uuid not null references public.users (id) on delete restrict,
  reported_user_id uuid not null references public.users (id) on delete restrict,
  -- Null means the owner filed it. Set means a delegate did, under
  -- `report_on_behalf` (ADR 0011 A7) — the report still belongs to the
  -- reporter. Present from the first row for the same reason it is on
  -- `blocks`: retrofitting an actor column onto an audit trail loses every
  -- row written before it.
  acted_by_user_id uuid references public.users (id) on delete restrict,
  category         text not null,
  description      text,
  context_type     text,
  context_id       uuid,
  status           text not null default 'open',
  -- A catalog key, never prose, and never a description of what happened to
  -- the reported member's account. "We reviewed this" is the most that may be
  -- said to a stranger about someone else.
  outcome_key      text,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Reporting yourself is not a safety signal, it is a mistake or a probe.
  -- Refused by the database as well as the route: the route can be bypassed
  -- by a future caller, the constraint cannot.
  constraint reports_not_self check (reporter_user_id <> reported_user_id),

  constraint reports_category_valid check (
    category in (
      'scam', 'harassment', 'impersonation', 'fake_profile',
      'inappropriate_content', 'misrepresented_status', 'other'
    )
  ),
  constraint reports_status_valid check (
    status in ('open', 'triaged', 'actioned', 'dismissed')
  ),
  constraint reports_context_valid check (
    context_type is null
    or context_type in ('profile', 'conversation', 'message', 'photo')
  ),
  -- A context id without a type describes nothing; a type without an id is a
  -- usable signal ("their profile") and stays allowed.
  constraint reports_context_id_needs_type check (
    context_id is null or context_type is not null
  ),
  constraint reports_description_len check (
    description is null or char_length(description) <= 2000
  ),
  -- The contract caps the outcome at a key, so the length is a sanity bound
  -- rather than a product rule.
  constraint reports_outcome_shape check (
    outcome_key is null or outcome_key ~ '^[a-z][a-z0-9_.]*$'
  ),
  -- Resolution is a pair: a resolved report records WHEN, and an open one has
  -- not been resolved. Without this the queue can contain rows that are
  -- simultaneously open and finished.
  constraint reports_resolved_consistent check (
    (status in ('open', 'triaged') and resolved_at is null)
    or (status in ('actioned', 'dismissed') and resolved_at is not null)
  )
);

comment on table public.reports is
  'Member-filed safety reports. The reported party has no read path: there is '
  'no policy that could return their own row to them, and the absence is the '
  'control.';

-- ONE OPEN REPORT PER PAIR, which is the spam control.
--
-- Partial on purpose. A blanket unique(reporter, reported) would mean someone
-- who reported a person a year ago, had it dismissed, and is now being
-- harassed by the same person cannot report them again — which punishes the
-- victim for having been wrong once. Restricting it to live reports stops the
-- flood without ever silencing a genuine second complaint.
create unique index reports_one_open_per_pair
  on public.reports (reporter_user_id, reported_user_id)
  where status in ('open', 'triaged');

-- ERD §14's two reads: the moderation queue, and pattern detection across
-- reports about one member.
create index reports_queue_idx on public.reports (status, created_at);
create index reports_reported_idx on public.reports (reported_user_id);
create index reports_reporter_idx on public.reports (reporter_user_id, created_at desc);

create trigger reports_touch
  before update on public.reports
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS — `owner`, read-only, reporter side only (ERD §14)
--
-- NO MEMBER WRITE PATH, and this is the part worth being deliberate about.
-- `blocks` is member-writable because a block is a private preference whose
-- every column the member legitimately owns. A report is not: `status` and
-- `outcome_key` are the moderation pipeline's state, and a member who could
-- write them through the Data API could file a report pre-dismissed, or edit
-- one after a moderator had triaged it. Column-level grants could carve that
-- up, but the route also has to refuse self-reports, refuse invisible targets
-- and enforce one-open-per-pair — so the insert belongs behind the API, where
-- those checks live, exactly as `matches` and `interest_events` do.
--
-- The reporter keeps SELECT, because ERD §14 promises them the outcome.
-- =============================================================================

select app.enable_rls('public.reports');

grant all on public.reports to service_role;
grant select on public.reports to authenticated;

create policy reports_select_own
  on public.reports for select to authenticated
  using (reporter_user_id = app.current_user_id());
