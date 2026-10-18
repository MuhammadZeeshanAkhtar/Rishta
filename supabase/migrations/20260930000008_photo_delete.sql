-- =============================================================================
-- 0008 — soft-deleting a photo belongs to the server
--
-- 0006 granted `update (deleted_at)` on `photos` to `authenticated`. That
-- grant cannot work, and the reason is worth recording because it applies to
-- every soft-deletable table this schema will ever add.
--
-- Under FORCE ROW LEVEL SECURITY, PostgreSQL requires the row produced by an
-- UPDATE to still be visible under the table's SELECT policy. `photos_select_own`
-- filters `deleted_at is null`, so the moment a member sets `deleted_at` the new
-- row becomes invisible to them and the statement is refused with
-- "new row violates row-level security policy". Verified directly: with the
-- `deleted_at is null` clause removed from the SELECT policy the same update
-- succeeds, and with it present it fails.
--
-- The fix is not to loosen the SELECT policy — that would show members their
-- own deleted photos and, worse, set the precedent for every later table. It
-- is to put the operation where it belongs. Deleting a photo is a workflow
-- with retention consequences (ERD E1): the row survives for abuse
-- investigation while the bytes are purged from the bucket. That is a server
-- action, like `review_status` and `moderation_status`, not a field edit.
--
-- `profiles` is already correct in this respect — `deleted_at` was never in
-- its update grant — so this is the only table that needs the change.
-- =============================================================================

revoke update (deleted_at) on public.photos from authenticated;

comment on column public.photos.deleted_at is
  'Soft delete. Written by the server only: a member-run UPDATE would produce '
  'a row invisible under photos_select_own, which FORCE RLS refuses.';
