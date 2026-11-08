# Legacy content runbook (review N3)

Before reviews B5, B6 and B12, every uploaded photo and submitted profile was approved
automatically, and stored original photos kept their EXIF metadata, including GPS. This
describes how to find and clean that content on a live project.

**None of this has been run against a real project.** The tool is tested against real
migrations and real image files on a local database with in-memory storage. Read the
company decisions below before any step that changes anything.

## What protects members before anyone runs this

Migration 0033 marks every photo present when it runs (`original_needs_strip`). A marked
original is never served to another member, and moderators see the metadata-free thumbnail
instead. Applying 0033 hides nothing else: thumbnails and blurred copies, which have never
carried metadata, keep working.

Auto-approved content stays visible until someone decides otherwise. That is the decision
below.

## The tool

```bash
pnpm --filter @nikahmate/api legacy-content report
pnpm --filter @nikahmate/api legacy-content scan-originals --limit=50
pnpm --filter @nikahmate/api legacy-content strip-originals --limit=50 --apply
pnpm --filter @nikahmate/api legacy-content requeue --limit=100 --apply
```

- **Dry run by default.** Nothing changes without `--apply`.
- **Prints counts and photo ids only.** Never a coordinate, an image, a name or a URL.
- **Safe to repeat.** Finished items no longer match.

| Counts as legacy | Rule                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| Photo            | Approved, with no `human` / `approved` row in `media_moderation_results` |
| Profile          | Approved, with no `profile.approve` row in `admin_action_audit`          |
| Original         | `original_needs_strip` is set                                            |

`scan-originals` and `strip-originals` read and rewrite files, so they need the Storage
service-role key in `LEGACY_TOOL_STORAGE_KEY`, with `SUPABASE_URL`. The API refuses to run
with such a key, so run this as a separate, supervised process from a trusted machine, and
keep the key out of every other environment.

## Order

Take a database backup first, and confirm a Storage copy exists: `strip-originals`
overwrites files in place and the original metadata cannot be recovered. That is the point
of it, but it should be a decision.

1. `report`. How much is there? How long is the moderation queue already?
2. `scan-originals` on a small `--limit`. Does it find what you expect?
3. `strip-originals --limit=20 --apply`. Check some of those photos still look right.
4. `strip-originals --apply`, repeated until `report` shows `originalsToClean: 0`. Any id in
   `failedPhotoIds` keeps its mark and stays withheld. Investigate those by hand.
5. Only after that, and only if the company has decided to: `requeue`, in batches a
   moderator can get through.

Cleaning comes before re-review so that moderators see the full photo rather than the
thumbnail.

## Company decisions required

1. **Should legacy content be re-reviewed at all?** Nobody has checked it. Requeueing hides
   it from other members until a moderator decides, which could empty discovery.
2. **How fast?** The `--limit` paces it to what moderators can review.
3. **Should members be told?** Their profile disappears from discovery while it waits. The
   tool sends no notification, because no wording has been decided.
4. **What is the retention position** on the EXIF already exposed to anyone who downloaded
   an original before B12? The tool cannot undo that. Whether it needs a notification is a
   question for counsel.

An approved main photo that is re-queued gets its place back if approved again, unless the
member has chosen another in the meantime.
