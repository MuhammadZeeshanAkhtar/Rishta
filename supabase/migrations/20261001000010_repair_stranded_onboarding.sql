-- =============================================================================
-- 0010 — repair accounts stranded by a submission that never completed
--
-- `POST /me/profile/submit` set `profiles.review_status = 'pending'` but never
-- `users.status` or `users.profile_completed_at`. The app's session gate reads
-- those two columns, so a profile could be submitted successfully — 202, score
-- 100, review pending — and the person would still be routed back to step 1 of
-- onboarding on the next render. Onboarding could not be completed by anyone.
--
-- The route now writes both in one transaction. This migration repairs the
-- accounts that submitted before it did, because they cannot repair
-- themselves: resubmitting is refused with 409 while a review is pending, so
-- there is no path out from the client side.
--
-- Scope is deliberately narrow. Only an account that
--
--   * is still `onboarding`, and
--   * has a profile that has actually left `draft`, and
--   * carries the identity the `users_identity_complete` constraint requires
--
-- is moved. A suspended or banned account is untouched, and an account that
-- genuinely has not submitted keeps its onboarding state.
-- =============================================================================

update public.users u
   set status = 'active',
       profile_completed_at = coalesce(u.profile_completed_at, p.submitted_at, now()),
       onboarding_step = null
  from public.profiles p
 where p.user_id = u.id
   and u.status = 'onboarding'
   and p.review_status <> 'draft'
   and u.display_name is not null
   and u.gender is not null
   and u.date_of_birth is not null
   and u.country_code is not null;
