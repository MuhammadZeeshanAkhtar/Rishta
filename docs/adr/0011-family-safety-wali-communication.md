# 0011 — Family Safety: the wali communication model

**Status:** Accepted · **Date:** 2026-09-25 · **Ref:** README D12, §4.9, §9.4 · docs/ERD.md §12, §21
**Supersedes in part:** [0005](0005-mvp-scope-option-a.md) — the wali Observer-only reduction

## Context

NikahMate was designed with family involvement as a _feature_: a wali could be
invited, granted read-only sight of a profile and a match, and revoked. ADR 0005
cut that to an Observer tier for v1 specifically to shrink R6, the permission
matrix.

The product owner has reclassified family involvement as a **core safety layer**,
not a feature. That changes what the architecture has to do. Under the old model,
accepting an interest opened a conversation. Under the new one, acceptance and
communication are two different permissions, and the family can stand between
them.

The hard part is not the plumbing. It is holding two commitments at once:

1. **Family involvement must be real.** If a family member's approval can be
   bypassed by the owner flipping a switch, the feature is theatre and the
   families this product is built for will not trust it.
2. **The profile owner owns their identity.** A delegate is not a guardian of the
   account. A mandatory family gate is also a mechanism for keeping an adult from
   ever speaking to anyone — which is exactly the coercion this product's own
   anti-coercion controls exist to prevent.

Those pull in opposite directions and the resolution is the substance of this ADR.

## Options

| Option                          | Model                                                                                              | Cost                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — owner-elected gate**      | The owner chooses whether their communication requires family approval. Delegates decide within it | Family gate is real but voluntary. An owner under pressure can be pressured into enabling it                                                                  |
| B — mandatory gate for everyone | Every match requires family approval                                                               | Simple and consistent; makes the platform unusable for anyone without family, and hands any delegate an indefinite veto over an adult's life                  |
| C — gate by gender              | Required for women, optional for men                                                               | Matches some cultural expectations; encodes them in the schema, is indefensible under equality law in several target markets, and cannot be varied per family |

## Decision

**Option A.** Three rules carry the whole model.

### 1. The gate is the owner's, the decision is the family's

`user_settings.communication_policy` is `direct` or `family_reviewed`, set by the
owner. When it is `family_reviewed`, no conversation opens on their side until a
delegate holding `approve_communication` decides. **The owner cannot make that
decision themselves** — that is what makes the approval mean something.

The owner can change the policy at any time, and doing so notifies every delegate
who holds a review grant. It is a visible act, not a silent one. What the owner
can never do is approve in a delegate's place.

**A match is gated if _either_ side requires review.** Both sides' families are
protected by one person's setting, which is the correct default for a product
where the counterpart cannot see what the other household expects.

### 2. Communication state is a property of the match, not the conversation

`matches.communication_state` is the single authorization gate:

| Stored state            | May text | Meaning                                                |
| ----------------------- | -------- | ------------------------------------------------------ |
| `pending_family_review` | ✗        | At least one side requires review; awaiting a decision |
| `family_rejected`       | ✗        | A reviewing delegate declined                          |
| `open`                  | ✓        | Neither side required review                           |
| `family_approved`       | ✓        | Every side that required review approved               |
| `revoked`               | ✗        | Approval withdrawn, or the owner paused it             |
| `blocked`               | ✗        | A block exists in either direction                     |

`open` and `family_approved` are the same _authorization_ state and different
_provenance_. They are kept apart because the UI must be able to say "Approved by
Ahmed (Father) on 12 March" rather than silently behaving the same way in both
cases. Provenance that is not stored cannot be displayed.

**`active` is derived, not stored.** The API reports `active` when the state
permits writing and `conversations.last_message_at is not null`. Storing it would
duplicate what `messages` already knows, and a duplicated state is a state that
can disagree with itself.

`interest pending` and `interest accepted` remain on `interests.status`. They are
properties of an interest, and folding them into a match column would mean a
column whose values describe a row that does not exist yet.

### 3. A delegate's sight is an intersection, never a union

```
delegate_view(target) = owner_view(target) ∩ delegate_grants
```

A delegate reviewing a counterpart can never see more of that counterpart than
their own principal can. `profile_sensitive`, `user_geo` and `private` photos are
out of reach of every delegate at every tier, because they are out of reach of the
API's shared read path entirely — they are `restricted` tables, and that boundary
does not move for family (README §9.2).

This is stated as an intersection rather than a permission list because a list
grows and an invariant does not. It is a mandatory test in the RLS matrix.

## Permissions

`family_permissions` is the authority. `family_relationships.tier` is a **preset
label** for the invite UI, not an authorization input — a tier expands to
permissions at grant time and is never consulted again.

| Permission              | Grants                                                       | Ships |
| ----------------------- | ------------------------------------------------------------ | ----- |
| `view_profile`          | The owner's own profile, per field visibility                | M1    |
| `view_matches`          | The owner's matches, from stage 4 (ERD E5)                   | M1    |
| `review_interest`       | See an accepted interest and the counterpart's review packet | M1    |
| `approve_communication` | Approve · reject · request more information · revoke         | M1    |
| `report_on_behalf`      | File a report attributed to both owner and delegate          | M1    |
| `block_on_behalf`       | Block a counterpart, attributed                              | M1    |
| `view_conversation`     | Read message history — supervised view                       | M2    |
| `join_conversation`     | Write in the thread, visibly attributed                      | M2    |
| `request_family_call`   | Request or accept a family call                              | M2    |
| `join_family_call`      | Be a participant in a family call                            | M2    |
| `receive_proposal`      | Be a recipient of a formal proposal                          | 1.1   |
| `manage_profile`        | Edit the profile and preferences on the owner's behalf       | 1.1   |

Tier presets: `observer` → view only · `reviewer` → adds the four M1 review and
safety grants · `participant` → adds conversation and call grants · `manager` →
adds proposals and profile management.

Every permission is **explicit** (a row, never inferred from a tier at read time),
**revocable** (deleting the grant takes effect on the next request, and revoking
the relationship cascades to every in-flight approval), **auditable** (used
permission recorded on every delegated action) and **scoped to one owner**
(`relationship_id` carries `owner_user_id`; a delegate for two people holds two
independent grant sets).

**Enforcement is server-side in the authorization service, with RLS as backstop.**
Two new predicates join the three in ERD §2.3:

```sql
app.family_grant(delegate uuid, owner uuid, permission text) returns boolean
app.can_review_match(delegate uuid, match_id uuid) returns boolean
```

`can_review_match` is deliberately match-scoped. A reviewing delegate can see the
counterpart of _this match_; they cannot browse, search, or open an arbitrary
profile. The scope is the control.

## Family-mediated calls

Voice and video do **not** open a private channel between two profile owners.
A call is a `family_calls` session attached to a match, and it may not start
unless **at least one family participant is present on each side**.

```
requested ──accept──> accepted ──all sides present──> active ──> ended
    │                                                              ▲
    ├──decline──> declined                                         │
    ├──cancel───> cancelled                    any participant ────┘
    └──expire───> expired                      may leave; the last
                                               principal leaving ends it
```

`family_call_participants` records every person in the session with their side,
their role (`principal` or `family`), the relationship used, and join/leave
timestamps. The participant list is visible to everyone in the call. **The system
knows who is in the room, and so does everybody else in it.**

Direct owner-to-owner calling is refused by a server-side rule, not by omission —
the code path exists and is gated on a `system_flags` entry that is off. That is
deliberate: a feature that is absent gets rebuilt badly under deadline pressure,
whereas a feature that is switched off gets reviewed before it is switched on.

**Media transport is not decided here.** The schema and the contract are
transport-neutral; joining returns an opaque token. Choosing a WebRTC provider is
a Phase 9 decision with its own cost and data-residency analysis, and making it
now would bind the contract to a vendor for no benefit.

## Audit requirements

Every delegated action carries the full chain, because "Approved by Ahmed (Father)
on behalf of Muhammad" cannot be reconstructed from an actor id alone:

| Recorded              | Where                                                        |
| --------------------- | ------------------------------------------------------------ |
| Profile owner         | `owner_user_id`                                              |
| Acting family member  | `acted_by_user_id` — the existing A7 concept, unchanged      |
| Relationship to owner | `relationship_id` → `family_relationships.relationship_code` |
| Timestamp             | `created_at` / `decided_at`                                  |
| Permission used       | `family_access_log.permission`                               |

State transitions land in `match_events`, which already exists for exactly this.
Delegate reads land in `family_access_log`, which the owner can read — that is the
anti-coercion control and it only works because it is a screen, not a table.

## Privacy rules

1. The intersection rule above, tested in both directions.
2. A delegate never sees `profile_sensitive` (phone, email, employer), `user_geo`
   (exact location), or photos outside their principal's own grants.
3. The **review packet** is an enumerated projection — basics, marriage
   preferences, compatibility summary, verification badges, photo set as the
   principal sees it, block/report signals. It is a distinct response schema, not
   a profile read with fields removed, so a new profile column cannot leak into it
   by default.
4. A delegate without `view_conversation` never receives message bodies — not in
   a review packet, not in a notification, not in a push payload.
5. The owner's support channel (README §4.9) is invisible to every delegate, and
   no delegate grant can reach it.

## Consequences

**Positive.** Family involvement becomes the product's differentiator rather than
a side feature, and it is enforced where it cannot be bypassed. The permission
vocabulary, the attribution chain and the audit trail were already designed for
this — `acted_by_user_id`, `family_permissions`, `family_access_log` and
`match_events` are reused as built, not replaced.

**Negative.** This reverses the R6 reduction that ADR 0005 bought. The closed beta
grows from 47 tables to 52, the permission matrix regains the dimension that was
deliberately removed, and the family review flow has to be built before
conversation rather than after it — Phase 9 work moves ahead of Phase 7. Realistic
cost: **4–6 weeks added to the closed-beta date**. That is the price of the
decision and it should not be discovered later.

**Negative.** A `family_reviewed` owner whose delegate never responds is stuck.
Mitigated by a review SLA that surfaces the delay to the owner, and by instant
revocation — but the underlying risk is real and is recorded as **R16**.

**Neutral.** Three new tables: `family_reviews`, `family_calls`,
`family_call_participants`. The inventory moves 90 → 93, v1 71 → 74.
No existing table is restructured; `matches` and `user_settings` each gain one
column, and `match_events` gains two.

## Future extensibility

Designed for, not built: multi-delegate quorum approval (the review row already
records which relationship decided, so a count rule is additive); supervised group
modes beyond two families; scheduled calls; direct owner-to-owner calling behind
the existing flag; a delegate acting for several profiles, which the schema
already permits (A6). Call recording is **not** planned — it would require
consent analysis in every jurisdiction in scope and is not needed for the safety
model to work.
