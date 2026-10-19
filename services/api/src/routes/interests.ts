import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict, notFound, quotaExhausted } from '../errors';
import { requireAuthContext } from '../auth/plugin';
import { loadEntitlements, valueOf } from '../entitlements/service';
import { interestAccepted, interestReceived, newMatch, notify } from '../notifications/service';
import type { Db, DbSession } from '../db/types';
import {
  CARDS_BY_USER_IDS,
  buildCards,
  decodeCursor,
  encodeCursor,
  parseLimit,
  type CardRow,
} from '../discovery/cards';

/**
 * Interests — send, withdraw and read.
 *
 * THE ORDER OF CHECKS IS THE CONTRACT. `POST /interests` states it exactly:
 * block (either direction), gender eligibility, profile approved, daily quota,
 * existing interest — then the insert. It is implemented in that order rather
 * than a convenient one, and the quota lands in the same transaction as the
 * interest.
 *
 * WHY ONE TRANSACTION. "Quota consumption happens in the same transaction as
 * the insert — otherwise two concurrent requests both read the same remaining
 * count and the limit is advisory." That rules out checking the counter and
 * then writing: the counter is INCREMENTED first and the new value inspected,
 * so two concurrent senders cannot both see room. If anything afterwards fails
 * — a duplicate, a constraint, a dropped connection — the whole transaction
 * rolls back and the increment goes with it. Quota is therefore never spent on
 * an interest that was not created.
 *
 * NO MATCH IS CREATED. Mutual interest is visible in these rows and
 * `app.relationship()` reports `interest_pending` either way, but `matches`,
 * the communication state machine, chat and notifications belong to later
 * slices. ADR 0011 is explicit that accepting does not necessarily open a
 * conversation, so manufacturing a match here would prejudge a decision the
 * family-review gate is supposed to make.
 */

export interface InterestRoutesOptions {
  db: Db;
}

const sendInterestSchema = z.object({
  recipientUserId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

const DAILY_INTERESTS = 'daily_interests';

/** The contract's InterestStatus enum, for the list filter. */
const INTEREST_STATUSES = ['pending', 'accepted', 'declined', 'maybe_later', 'withdrawn'];

const respondSchema = z.object({
  decision: z.enum(['accept', 'decline', 'maybe_later']),
});

/** decision -> the status it writes, and the event it records. */
const DECISIONS = {
  accept: { status: 'accepted', event: 'accepted' },
  decline: { status: 'declined', event: 'declined' },
  maybe_later: { status: 'maybe_later', event: 'maybe_later' },
} as const;

interface InterestRow {
  id: string;
  sender_user_id: string;
  recipient_user_id: string;
  acted_by_user_id: string | null;
  status: string;
  note: string | null;
  created_at: string;
  responded_at: string | null;
}

/** The contract's `Interest`, minus the counterpart card the reader supplies. */
function toInterest(row: InterestRow, viewerUserId: string): Record<string, unknown> {
  return {
    id: row.id,
    direction: row.sender_user_id === viewerUserId ? 'sent' : 'received',
    counterpartUserId:
      row.sender_user_id === viewerUserId ? row.recipient_user_id : row.sender_user_id,
    status: row.status,
    note: row.note,
    // A7: always returned, so a delegate's action is never covert.
    actedBy: row.acted_by_user_id,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

/**
 * Profile cards for a set of counterparts, keyed by user id.
 *
 * Uses the SAME builder discovery uses, so an interest and a search result
 * disclose exactly the same fields — a second serializer is how a privacy rule
 * gets fixed in one place and left wrong in the other.
 *
 * Runs under `discovery.read_cards` because a card needs the display name and
 * the derived age from `users`, which is owner-only and holds the birth date
 * the product promises never to expose. `app.can_view_profile()` inside the
 * select drops a counterpart who has since blocked the viewer, been suspended
 * or lost approval, so a stale interest cannot resurrect a profile.
 *
 * A dropped counterpart yields `null` rather than removing the row. A member's
 * own outgoing interest vanishing with no explanation would be worse than a
 * card they cannot see: they are still entitled to know they sent it.
 */
async function counterpartCards(
  db: Db,
  viewerUserId: string,
  counterpartIds: readonly string[],
): Promise<Map<string, unknown>> {
  const ids = [...new Set(counterpartIds)];
  if (ids.length === 0) return new Map();

  return db.asService('discovery.read_cards', async (session) => {
    const rows = await session.query<CardRow>(CARDS_BY_USER_IDS, [viewerUserId, ids]);
    const built = (await buildCards(session, viewerUserId, rows)) as Array<{ userId: string }>;
    return new Map<string, unknown>(built.map((card) => [card.userId, card]));
  });
}

export const interestRoutes: FastifyPluginAsync<InterestRoutesOptions> = async (
  fastify,
  { db },
) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  // --- POST /interests -------------------------------------------------------

  fastify.post('/interests', { preHandler: fastify.requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const parsed = sendInterestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid interest');

    const { recipientUserId, note } = parsed.data;

    const senderUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!senderUserId) throw notFound('Profile not found');
    // Checked before the transaction because it needs no data: a self-interest
    // is refused by a constraint too, but failing here keeps the counter
    // untouched without relying on a rollback.
    if (recipientUserId === senderUserId) throw notFound('Profile not found');

    // The limit comes from the Phase 5 entitlement service, so a granted
    // override or a future paid plan raises it without this route changing.
    // Read outside the transaction: it is the member's own allowance, not
    // contended state, and the enforcement below is what makes it real.
    const entitlements = await loadEntitlements(db, auth.authUserId, senderUserId);
    const allowance = valueOf(entitlements, DAILY_INTERESTS);
    const limit = typeof allowance === 'number' ? allowance : 0;

    const created = await db.asService('interest.send', async (session) => {
      // 1. BLOCK, in either direction, and the target must be visible at all.
      //    `app.can_view_profile()` already folds in blocks both ways, the
      //    account being active and non-deleted, and the profile having passed
      //    review — so approval, activity and discoverability are this one
      //    call rather than four re-implemented conditions.
      const visible = await session.query<{ ok: boolean }>(
        `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
        [senderUserId, recipientUserId],
      );
      if (!visible[0]?.ok) {
        // Indistinguishable from a target that does not exist. A 403 here
        // would confirm the member exists, which is what a block must not
        // let the blocked party learn.
        throw notFound('Profile not found');
      }

      // 2. GENDER eligibility. The matrimonial assumption, applied as it is in
      //    candidate generation rather than as a preference.
      const genders = await session.query<{ sender: string | null; recipient: string | null }>(
        `select
           (select gender from public.users where id = $1::uuid) as sender,
           (select gender from public.users where id = $2::uuid) as recipient`,
        [senderUserId, recipientUserId],
      );
      const sender = genders[0]?.sender ?? null;
      const recipient = genders[0]?.recipient ?? null;
      if (!sender || !recipient || sender === recipient) {
        throw badRequest('This profile is not eligible');
      }

      // 3. QUOTA — incremented, then inspected. Never read-then-write.
      //    Two concurrent senders each get their own post-increment value, so
      //    only one of them can be the sixth.
      if (limit <= 0) throw quotaExhausted('Daily interest limit reached');

      const counted = await session.query<{ count: number }>(
        `insert into public.usage_counters (user_id, counter_key, period_start, count)
         values ($1::uuid, $2::text, current_date, 1)
         on conflict (user_id, counter_key, period_start)
           do update set count = public.usage_counters.count + 1
         returning count`,
        [senderUserId, DAILY_INTERESTS],
      );
      const used = counted[0]?.count ?? 0;
      if (used > limit) {
        // Throwing rolls the transaction back, which un-does the increment —
        // so a refused send does not quietly burn an allowance.
        throw quotaExhausted('Daily interest limit reached');
      }

      // 4. EXISTING INTEREST. The partial unique index is the real guard
      //    against two concurrent sends; this read turns the ordinary case
      //    into the contract's 409 rather than a constraint error.
      const existing = await session.query<{ id: string }>(
        `select id from public.interests
          where sender_user_id = $1::uuid and recipient_user_id = $2::uuid
            and status <> 'withdrawn'`,
        [senderUserId, recipientUserId],
      );
      if (existing.length > 0) throw conflict('An interest has already been sent');

      // 5. INSERT, with the event beside it. Both in this transaction, so an
      //    interest without its audit row cannot exist.
      let rows: InterestRow[];
      try {
        rows = await session.query<InterestRow>(
          `insert into public.interests (sender_user_id, recipient_user_id, note)
           values ($1::uuid, $2::uuid, $3::text)
           returning id, sender_user_id, recipient_user_id, acted_by_user_id,
                     status, note, created_at, responded_at`,
          [senderUserId, recipientUserId, note ?? null],
        );
      } catch (error) {
        // The race the index exists for: another request inserted between the
        // read above and this write. Same answer as the sequential case.
        if (String(error).includes('interests_active_pair_key')) {
          throw conflict('An interest has already been sent');
        }
        throw error;
      }

      const row = rows[0]!;
      await session.query(
        `insert into public.interest_events (interest_id, event, actor_user_id)
         values ($1::uuid, 'sent', $2::uuid)`,
        [row.id, senderUserId],
      );

      // Same transaction as the interest and the quota. A notification about
      // an interest that rolled back would be a message about something that
      // did not happen.
      await notify(session, [interestReceived(recipientUserId, senderUserId, row.id)]);
      return row;
    });

    return reply.code(201).send(toInterest(created, senderUserId));
  });

  // --- POST /interests/:interestId/respond -----------------------------------

  /**
   * Accept, decline or defer.
   *
   * ONLY THE RECIPIENT. A sender responding to their own interest would be
   * self-matching by proxy, so it is refused with the same 404 a stranger
   * gets — there is nothing useful in telling them the row exists when they
   * already know, and nothing safe in confirming it to anyone else.
   *
   * ACCEPTING CREATES A MATCH. The contract is explicit, and
   * `matches.interest_id` records which interest created it. It does NOT open
   * a conversation: ADR 0011 separates the two, and the communication gate is
   * what decides. `conversation_id` stays null until the chat slice.
   *
   * THE GATE IS NOT SET HERE. `communication_state` is chosen by
   * `app.gate_new_match_period()` from both sides' `communication_policy`
   * (migration 0021), for a fresh match and for the revival of one the pair
   * ended alike. This route reads the result back and reports it; it does not
   * get an opinion. Everything still opens in `open` today because nothing can
   * yet set `family_reviewed` — but the decision has moved to one place, so a
   * route that forgets it cannot reopen the hole.
   *
   * NO QUOTA MOVES. `daily_interests` limits EXPRESSING interest. Responding
   * is not expressing, and declining refunds nothing — a refund would make the
   * limit bypassable by sending to someone certain to decline.
   */
  fastify.post(
    '/interests/:interestId/respond',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const params = request.params as { interestId?: string };
      const interestId = params.interestId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(interestId)) throw badRequest('Invalid interest id');

      const parsed = respondSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('decision must be accept, decline or maybe_later');
      const decision = DECISIONS[parsed.data.decision];

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('Interest not found');

      return db.asService('interest.respond', async (session) => {
        const rows = await session.query<InterestRow>(
          `select id, sender_user_id, recipient_user_id, acted_by_user_id,
                  status, note, created_at, responded_at
             from public.interests where id = $1::uuid`,
          [interestId],
        );
        const row = rows[0];

        // Not addressed to this member — including the sender's own interest.
        if (!row || row.recipient_user_id !== viewerUserId) {
          throw notFound('Interest not found');
        }
        if (row.status !== 'pending') {
          // Already resolved or withdrawn. The contract defines 409 here, and
          // answering 200 would write a second event for one decision.
          throw conflict('This interest has already been answered');
        }

        // Blocks, suspension and unapproval all at once, and in both
        // directions. A pair that can no longer see each other cannot match.
        const visible = await session.query<{ ok: boolean }>(
          `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
          [viewerUserId, row.sender_user_id],
        );
        if (!visible[0]?.ok) throw notFound('Interest not found');

        const updated = await session.query<InterestRow>(
          `update public.interests
              set status = $2::text, responded_at = now()
            where id = $1::uuid
            returning id, sender_user_id, recipient_user_id, acted_by_user_id,
                      status, note, created_at, responded_at`,
          [interestId, decision.status],
        );
        await session.query(
          `insert into public.interest_events (interest_id, event, actor_user_id)
           values ($1::uuid, $2::text, $3::uuid)`,
          [interestId, decision.event, viewerUserId],
        );

        // Only acceptance notifies. The contract's type enum has no
        // `interest_declined` and no `match_ended`, and that absence is a
        // decision rather than an omission: "a decline tells the sender it was
        // declined and nothing more". A push the moment someone says no is the
        // opposite of that.
        if (parsed.data.decision === 'accept') {
          await notify(session, [interestAccepted(row.sender_user_id, viewerUserId, interestId)]);
        }

        let match: Record<string, unknown> | null = null;
        if (parsed.data.decision === 'accept') {
          // Ordered pair, which is what makes the unique index total over
          // unordered pairs rather than over (A,B) and (B,A) separately.
          const [userA, userB] =
            row.sender_user_id < row.recipient_user_id
              ? [row.sender_user_id, row.recipient_user_id]
              : [row.recipient_user_id, row.sender_user_id];

          // `do nothing` rather than a prior existence check: the constraint
          // is the race control, and a pair who sent interests both ways can
          // reach this twice. One match per pair, whichever arrives first.
          const inserted = await session.query<{ id: string; communication_state: string }>(
            `insert into public.matches (user_a_id, user_b_id, interest_id)
             values ($1::uuid, $2::uuid, $3::uuid)
             on conflict (user_a_id, user_b_id) do nothing
             returning id, communication_state`,
            [userA, userB, interestId],
          );

          let matchRow = inserted[0];
          if (matchRow) {
            await session.query(
              `insert into public.match_events (match_id, event, actor_user_id, to_state)
               values ($1::uuid, 'created', $2::uuid, $3::text)`,
              [matchRow.id, viewerUserId, matchRow.communication_state],
            );
            // Both sides. Notified here and not below, so an acceptance that
            // finds an ALREADY ACTIVE match — which is what happens when two
            // people accept crossing interests at the same moment — sends
            // nothing a second time.
            await notify(session, newMatch(matchRow.id, interestId, userA, userB));
          } else {
            // A row already exists for this pair. `matches_pair_key` is unique
            // over the unordered pair with no partial clause, so there is one
            // row per pair FOREVER — including after an unmatch.
            //
            // Two cases, and the second only became reachable once unmatching
            // existed:
            //
            //   * still active — the acceptance is valid, there is simply
            //     nothing new to create, and a second row must never exist;
            //   * ENDED — the pair unmatched and have since come back through
            //     a fresh interest. Reviving the row is what "one row per
            //     pair" means. Returning it ended would report a successful
            //     acceptance while `app.relationship()` said `stranger`.
            //
            // `communication_state` is deliberately NOT in the SET list.
            // Clearing `ended_at` is what tells the database a new match
            // period has begun, and `app.gate_new_match_period()` recomputes
            // the gate from both sides' current policy — so a pair who
            // unmatch and rematch cannot launder their way past a review they
            // would otherwise have needed. A line here setting it to `'open'`
            // was that bypass.
            const revived = await session.query<{ id: string; communication_state: string }>(
              `update public.matches
                  set ended_at = null,
                      ended_by_user_id = null,
                      end_reason = null,
                      interest_id = $3::uuid
                where user_a_id = $1::uuid and user_b_id = $2::uuid
                  and ended_at is not null
                returning id, communication_state`,
              [userA, userB, interestId],
            );

            if (revived[0]) {
              matchRow = revived[0];
              // A new match period, so a new `created` event. The log then
              // reads created -> ended -> created, which is what happened.
              await session.query(
                `insert into public.match_events (match_id, event, actor_user_id, to_state)
                 values ($1::uuid, 'created', $2::uuid, $3::text)`,
                [matchRow.id, viewerUserId, matchRow.communication_state],
              );
              // A genuinely new match period, so both sides hear about it
              // again. The dedupe key carries the new interest id, which is
              // what stops the reused match row swallowing this.
              await notify(session, newMatch(matchRow.id, interestId, userA, userB));
            } else {
              const existing = await session.query<{ id: string; communication_state: string }>(
                `select id, communication_state from public.matches
                  where user_a_id = $1::uuid and user_b_id = $2::uuid`,
                [userA, userB],
              );
              matchRow = existing[0];
            }
          }

          // THE REVIEW ROWS. A gated match with nothing to decide on would
          // sit in `pending_family_review` forever with no inbox entry
          // anywhere — the gate closed and no handle on it.
          //
          // One row per side that actually requires review, not per match:
          // `required_communication_state()` gates if EITHER side asks, but
          // only the asking side's family gets a say. Writing a row for an
          // ungated side would hand their delegates a veto they were never
          // granted.
          //
          // `do update` rather than `do nothing` because of REMATCH. There is
          // one `matches` row per pair forever, so a previously decided review
          // is still sitting here; leaving it would let a pair unmatch and
          // rematch straight back into an old approval, which is the same
          // laundering route `gate_new_match_period()` closes on the match.
          if (matchRow && matchRow.communication_state === 'pending_family_review') {
            const gated = await session.query<{ user_id: string }>(
              `select user_id from public.user_settings
                where user_id in ($1::uuid, $2::uuid)
                  and communication_policy = 'family_reviewed'`,
              [userA, userB],
            );

            for (const side of gated) {
              const review = await session.query<{ id: string }>(
                `insert into public.family_reviews (match_id, owner_user_id)
                 values ($1::uuid, $2::uuid)
                 on conflict (match_id, owner_user_id) do update
                   set decision = 'pending',
                       decided_at = null,
                       decided_by_user_id = null,
                       relationship_id = null,
                       note = null,
                       requested_at = now(),
                       sla_notified_at = null
                 returning id`,
                [matchRow.id, side.user_id],
              );

              // Every delegate who can actually decide hears about it. An
              // owner with none gets a gate nobody can open, which is what
              // `familyReviewersCount` on the account read exists to warn
              // about before it happens.
              const delegates = await session.query<{ delegate_user_id: string }>(
                `select r.delegate_user_id
                   from public.family_relationships r
                   join public.family_permissions p on p.relationship_id = r.id
                  where r.owner_user_id = $1::uuid
                    and r.status = 'active'
                    and p.permission = 'approve_communication'
                    and p.granted`,
                [side.user_id],
              );

              for (const delegate of delegates) {
                await session.query(
                  `insert into public.notifications (user_id, type, payload, dedupe_key)
                   values ($1::uuid, 'family_review_requested', $2::jsonb, $3)
                   on conflict do nothing`,
                  [
                    delegate.delegate_user_id,
                    JSON.stringify({ matchId: matchRow.id, ownerUserId: side.user_id }),
                    `family_review_requested:${review[0]!.id}`,
                  ],
                );
              }
            }
          }

          if (matchRow) {
            match = {
              id: matchRow.id,
              counterpartUserId: row.sender_user_id,
              // Null until the chat slice creates a thread. The Match schema
              // allows this explicitly: "A match can exist with no thread."
              conversationId: null,
              // The stage a conversation will start at. None exists yet.
              stage: 1,
              communicationState: matchRow.communication_state,
              // Present only when a side required review. The delegate who
              // decides is deliberately NOT named here: the counterpart may
              // learn that a review is pending and never who is reviewing.
              familyReview:
                matchRow.communication_state === 'pending_family_review'
                  ? { status: 'pending' }
                  : null,
              endedAt: null,
            };
          }
        }

        return { interest: toInterest(updated[0]!, viewerUserId), match };
      });
    },
  );

  // --- GET /interests --------------------------------------------------------

  fastify.get('/interests', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as {
      direction?: string;
      status?: string;
      cursor?: string;
      limit?: string;
    };
    if (query.direction !== 'sent' && query.direction !== 'received') {
      throw badRequest('direction must be sent or received');
    }
    if (query.status !== undefined && !INTEREST_STATUSES.includes(query.status)) {
      throw badRequest('Invalid status filter');
    }

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) return { items: [], nextCursor: null, hasMore: false };

    const column = query.direction === 'sent' ? 'sender_user_id' : 'recipient_user_id';
    const params: unknown[] = query.status
      ? [viewerUserId, query.status, after]
      : [viewerUserId, after];
    const afterParam = query.status ? '$3' : '$2';

    // Keyset over a stable total order: newest first, id as the tiebreak so
    // two interests created in the same millisecond never swap between pages.
    // One row over the limit, so `hasMore` is observed rather than guessed.
    //
    // RLS already confines this to interests the caller participates in, so
    // the direction column is a filter rather than the access control.
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<InterestRow & { position: number }>(
        `select id, sender_user_id, recipient_user_id, acted_by_user_id,
                status, note, created_at, responded_at, position
           from (
             select i.*,
                    (row_number() over (order by i.created_at desc, i.id))::int - 1 as position
               from public.interests i
              where i.${column} = $1::uuid
                ${query.status ? 'and i.status = $2::text' : ''}
           ) ranked
          where ${afterParam}::int is null or position > ${afterParam}::int
          order by position
          limit ${limit + 1}`,
        params,
      ),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const cards = await counterpartCards(
      db,
      viewerUserId,
      page.map((row) =>
        row.sender_user_id === viewerUserId ? row.recipient_user_id : row.sender_user_id,
      ),
    );

    return {
      items: page.map((row) => {
        const shaped = toInterest(row, viewerUserId);
        return { ...shaped, counterpart: cards.get(shaped.counterpartUserId as string) ?? null };
      }),
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- GET /interests/:interestId -------------------------------------------

  fastify.get('/interests/:interestId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const params = request.params as { interestId?: string };
    const interestId = params.interestId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(interestId)) throw badRequest('Invalid interest id');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) throw notFound('Interest not found');

    // RLS already confines this to interests the caller participates in, so a
    // row belonging to two other people is simply absent — the handler never
    // has to decide who may read what.
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<InterestRow>(
        `select id, sender_user_id, recipient_user_id, acted_by_user_id,
                status, note, created_at, responded_at
           from public.interests where id = $1::uuid`,
        [interestId],
      ),
    );
    const row = rows[0];
    if (!row) throw notFound('Interest not found');

    const shaped = toInterest(row, viewerUserId);
    const cards = await counterpartCards(db, viewerUserId, [shaped.counterpartUserId as string]);
    return { ...shaped, counterpart: cards.get(shaped.counterpartUserId as string) ?? null };
  });

  // --- DELETE /interests/:interestId — withdraw ------------------------------

  fastify.delete(
    '/interests/:interestId',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { interestId?: string };
      const interestId = params.interestId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(interestId)) throw badRequest('Invalid interest id');

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('Interest not found');

      await db.asService('interest.send', async (session) => {
        const rows = await session.query<{ sender_user_id: string; status: string }>(
          `select sender_user_id, status from public.interests where id = $1::uuid`,
          [interestId],
        );
        const row = rows[0];

        // Only the SENDER may withdraw, and a recipient asking gets the same
        // 404 as a stranger — "withdraw" is not an action they have, and
        // telling them it exists discloses nothing useful.
        if (!row || row.sender_user_id !== viewerUserId) throw notFound('Interest not found');
        if (row.status === 'withdrawn') {
          // Already withdrawn. The contract defines 409 here, and repeating a
          // withdrawal is not the same as the idempotent 204 a shortlist
          // removal gets: this one has an audit trail that must not grow a
          // second identical row.
          throw conflict('This interest has already been withdrawn');
        }
        if (row.status !== 'pending') {
          throw conflict('Only a pending interest can be withdrawn');
        }

        await session.query(
          `update public.interests set status = 'withdrawn' where id = $1::uuid`,
          [interestId],
        );
        await session.query(
          `insert into public.interest_events (interest_id, event, actor_user_id)
           values ($1::uuid, 'withdrawn', $2::uuid)`,
          [interestId, viewerUserId],
        );
      });

      // NO QUOTA REFUND. The contract defines none, and one would make the
      // daily limit trivially bypassable: send, withdraw, repeat.
      return reply.code(204).send();
    },
  );
};
