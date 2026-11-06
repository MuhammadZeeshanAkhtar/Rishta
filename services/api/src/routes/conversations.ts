import type { FastifyPluginAsync } from 'fastify';
import {
  MAX_STAGE,
  markReadSchema,
  respondToStageSchema,
  sendMessageSchema,
  type WriteBlockedReason,
} from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, conflict, notFound } from '../errors';
import { parseLimit } from '../discovery/cards';
import { decodeKeyset, encodeKeyset, keysetTime } from '../http/cursor';
import type { Db, DbSession } from '../db/types';
import { uuidParam } from '../http/params';

/**
 * Conversations and messages (Phase 7, ERD §11).
 *
 * Mirrors the Conversations section of docs/openapi.yaml.
 *
 * SENDING RUNS AS THE MEMBER. `messages` is the one table in this product
 * where a member holds both SELECT and INSERT, because
 * `messages_insert_when_permitted` can express the whole rule: you are a
 * participant, the gate permits writing, the match is live, and no block
 * exists. Routing the insert through the service role would move the
 * authority from a policy Postgres enforces to a line of TypeScript someone
 * can forget — so the route checks the same predicate for the error message
 * and lets RLS be the thing that actually decides.
 *
 * THE CLIENT IS TOLD WHY, NOT THE INPUTS. `canWrite` and
 * `writeBlockedReason` come back on every conversation read, because "your
 * family has not decided yet" and "you blocked them" need completely
 * different UI, and a client reconstructing that from `communicationState`
 * would be reimplementing `app.can_write_message()` in JavaScript.
 *
 * NOT-FOUND, NEVER FORBIDDEN, as everywhere else.
 */

export interface ConversationRoutesOptions {
  db: Db;
}

/** The shape every conversation read resolves before it answers. */
interface ThreadRow {
  id: string;
  match_id: string;
  status: string;
  last_message_at: string | null;
  created_at: string;
  current_stage: number;
  counterpart_user_id: string;
  communication_state: string;
  match_ended: boolean;
  blocked: boolean;
  can_write_flag: boolean;
  left: boolean;
  /** The OTHER participant has left (review B25). */
  counterpart_left: boolean;
  unread_count: number;
  last_preview: string | null;
  position: number;
}

/**
 * Why writing is closed, or null when it is open.
 *
 * Ordered by what a person most needs to know. A block outranks a family
 * decision because it is the caller's own action — telling someone "waiting
 * for your family" when they blocked the other person would be nonsense.
 */
function writeBlockedReason(row: ThreadRow): WriteBlockedReason | null {
  if (row.left) return 'left';
  if (row.blocked) return 'blocked';
  // REVIEW B25. Leaving closes the conversation for BOTH participants, and
  // permanently. Before this the one left behind could keep writing into a
  // thread the leaver could no longer open. The database refuses it too
  // (0028, app.can_write_message), so this is the reason, not the control.
  if (row.counterpart_left) return 'counterpart_left';
  if (row.match_ended) return 'match_ended';
  if (row.status !== 'active') return 'archived';
  if (!row.can_write_flag) return 'read_only';
  switch (row.communication_state) {
    case 'pending_family_review':
      return 'pending_family_review';
    case 'family_rejected':
      return 'family_rejected';
    case 'revoked':
      return 'family_revoked';
    case 'blocked':
      return 'blocked';
    default:
      return null;
  }
}

/**
 * One SELECT that answers everything a thread read needs.
 *
 * Built as a view-shaped query rather than several round trips because the
 * conversation list is the screen a member opens most often, and on the
 * connections this product targets four queries per row is the difference
 * between a list and a wait.
 */
const THREAD_SELECT = `
  select c.id,
         c.match_id,
         c.status,
         c.last_message_at,
         c.created_at,
         s.current_stage,
         case when m.user_a_id = app.current_user_id() then m.user_b_id else m.user_a_id end
           as counterpart_user_id,
         m.communication_state,
         (m.ended_at is not null) as match_ended,
         app.is_blocked(m.user_a_id, m.user_b_id) as blocked,
         me.can_write as can_write_flag,
         (me.left_at is not null) as left,
         exists (
           select 1 from public.conversation_participants other
            where other.conversation_id = c.id
              and other.user_id <> app.current_user_id()
              and other.left_at is not null
         ) as counterpart_left,
         (
           select count(*)::int
             from public.messages msg
            where msg.conversation_id = c.id
              and msg.deleted_at is null
              and msg.sender_user_id <> app.current_user_id()
              and (
                r.last_read_at is null or msg.created_at > r.last_read_at
              )
         ) as unread_count,
         (
           select msg.body from public.messages msg
            where msg.conversation_id = c.id and msg.deleted_at is null
            order by msg.created_at desc limit 1
         ) as last_preview
    from public.conversations c
    join public.matches m on m.id = c.match_id
    join public.conversation_stages s on s.conversation_id = c.id
    join public.conversation_participants me
      on me.conversation_id = c.id and me.user_id = app.current_user_id()
    left join public.message_reads r
      on r.conversation_id = c.id and r.user_id = app.current_user_id()
`;

export const conversationRoutes: FastifyPluginAsync<ConversationRoutesOptions> = async (
  fastify,
  { db },
) => {
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  /** Display names for people in the caller's own threads. */
  const namesFor = async (
    viewerUserId: string,
    userIds: string[],
  ): Promise<Map<string, string | null>> => {
    if (userIds.length === 0) return new Map();
    return db.asService('conversation.read_participants', async (session) => {
      const found = await session.query<{ id: string; display_name: string | null }>(
        // Confined by the join: only people who share a thread with the
        // caller are reachable, and only their id and name are selected.
        `select distinct u.id, u.display_name
           from public.users u
           join public.conversation_participants p on p.user_id = u.id
           join public.conversation_participants mine
             on mine.conversation_id = p.conversation_id
            and mine.user_id = $1::uuid
          where u.id = any($2::uuid[])`,
        [viewerUserId, userIds],
      );
      return new Map(found.map((r) => [r.id, r.display_name]));
    });
  };

  /**
   * How far the OTHER side has read, or null when they suppress receipts.
   *
   * Service-role because `user_settings` is owner-only: a member reading the
   * counterpart's `send_read_receipts` through their own session gets no row
   * at all, so the suppression silently became "always hidden" — the flag
   * read as off for everyone, including the people who leave it on.
   *
   * The row in `message_reads` exists either way. Unread counts are the
   * reader's own feature and must work whether or not they tell anyone
   * (ERD §11), so the suppression is applied HERE, to what is reported.
   *
   * Confined by the caller's own membership of the thread.
   */
  const counterpartReadPosition = async (
    viewerUserId: string,
    conversationId: string,
  ): Promise<string | null> =>
    db.asService('conversation.read_participants', async (session) => {
      const rows = await session.query<{ last_read_at: string | null }>(
        `select case when s.send_read_receipts then r.last_read_at else null end as last_read_at
           from public.message_reads r
           join public.user_settings s on s.user_id = r.user_id
           join public.conversation_participants mine
             on mine.conversation_id = r.conversation_id
            and mine.user_id = $1::uuid
            and mine.left_at is null
          where r.conversation_id = $2::uuid and r.user_id <> $1::uuid`,
        [viewerUserId, conversationId],
      );
      return rows[0]?.last_read_at ?? null;
    });

  const toSummary = (row: ThreadRow, name: string | null): Record<string, unknown> => {
    const reason = writeBlockedReason(row);
    return {
      id: row.id,
      matchId: row.match_id,
      status: row.status,
      counterpartUserId: row.counterpart_user_id,
      counterpartDisplayName: name,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_preview,
      unreadCount: row.unread_count,
      stage: row.current_stage,
      canWrite: reason === null,
      writeBlockedReason: reason,
    };
  };

  /** Loads one thread the caller is in, or null. RLS does the scoping. */
  const loadThread = async (authUserId: string, id: string): Promise<ThreadRow | null> =>
    db.asUser(authUserId, async (session) => {
      const rows = await session.query<ThreadRow>(`${THREAD_SELECT} where c.id = $1::uuid`, [id]);
      return rows[0] ?? null;
    });

  // --- GET /conversations ------------------------------------------------------

  fastify.get('/conversations', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeKeyset(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const { page, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      // Newest traffic first, with threads nobody has spoken in falling back
      // to when they opened — a brand-new match should not sort below a
      // conversation that went quiet a month ago.
      //
      // REVIEW B10. Keyset on (activity time, id) instead of an offset into
      // row_number(): a new message no longer shifts every later thread by
      // one, so a page never repeats a thread. A thread that gets a message
      // WHILE the list is being paged moves above the cursor and shows at the
      // top on the next refresh — inherent to a list sorted by activity.
      const rows = await session.query<ThreadRow & { cursor_at: string }>(
        `select threads.*,
                ${keysetTime('coalesce(threads.last_message_at, threads.created_at)')} as cursor_at
           from (${THREAD_SELECT}) threads
          where $1::timestamptz is null
             or (coalesce(threads.last_message_at, threads.created_at), threads.id)
                < ($1::timestamptz, $2::uuid)
          order by coalesce(threads.last_message_at, threads.created_at) desc, threads.id desc
          limit ${limit + 1}`,
        [after?.at ?? null, after?.id ?? null],
      );
      return { page: rows, viewerUserId: await resolveViewer(session) };
    });

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    if (rows.length === 0 || !viewerUserId) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const names = await namesFor(
      viewerUserId,
      rows.map((r) => r.counterpart_user_id),
    );
    const last = rows[rows.length - 1];

    return {
      items: rows.map((row) => toSummary(row, names.get(row.counterpart_user_id) ?? null)),
      nextCursor: hasMore && last ? encodeKeyset({ at: last.cursor_at, id: last.id }) : null,
      hasMore,
    };
  });

  // --- GET /conversations/:id --------------------------------------------------

  fastify.get('/conversations/:id', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const id = uuidParam(request, 'id', 'conversation id');

    const thread = await loadThread(auth.authUserId, id);
    if (!thread) throw notFound('Conversation not found');

    const { participants, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<{
        user_id: string;
        role: string;
        can_write: boolean;
      }>(
        `select user_id, role, can_write from public.conversation_participants
            where conversation_id = $1::uuid and left_at is null
            order by user_id`,
        [id],
      );

      return { participants: rows, viewerUserId: await resolveViewer(session) };
    });

    const names = await namesFor(
      viewerUserId ?? '',
      participants.map((p) => p.user_id),
    );
    const counterpartRead = await counterpartReadPosition(viewerUserId ?? '', id);

    return {
      ...toSummary(thread, names.get(thread.counterpart_user_id) ?? null),
      participants: participants.map((p) => ({
        userId: p.user_id,
        displayName: names.get(p.user_id) ?? null,
        role: p.role,
        canWrite: p.can_write,
        isSelf: p.user_id === viewerUserId,
      })),
      counterpartLastReadAt: counterpartRead,
      createdAt: thread.created_at,
    };
  });

  // --- GET /conversations/:id/messages -----------------------------------------

  fastify.get(
    '/conversations/:id/messages',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');
      const query = request.query as { cursor?: string; limit?: string };
      const limit = parseLimit(query.limit);
      const after = decodeKeyset(query.cursor);
      if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

      // Membership is the read question, and RLS already answers it. A
      // non-participant gets an empty thread, so the 404 is produced here
      // from the conversation read rather than from the message list.
      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      const { page, viewerUserId } = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<{
          id: string;
          sender_user_id: string;
          acted_by_user_id: string | null;
          body: string;
          kind: string;
          edited_at: string | null;
          created_at: string;
          cursor_at: string;
        }>(
          // Newest first: a chat opens at the bottom, and paging backwards is
          // what "load earlier" means.
          //
          // REVIEW B10. Keyset on (created_at, id); `messages_thread_idx`
          // (conversation_id, created_at desc) serves it. "Earlier than the
          // oldest message I have" does not change when new messages arrive,
          // so "load earlier" in an active chat no longer repeats or skips.
          `select msg.id, msg.sender_user_id, msg.acted_by_user_id, msg.body, msg.kind,
                  msg.edited_at, msg.created_at,
                  ${keysetTime('msg.created_at')} as cursor_at
             from public.messages msg
            where msg.conversation_id = $1::uuid
              and msg.deleted_at is null
              and ($2::timestamptz is null
                   or (msg.created_at, msg.id) < ($2::timestamptz, $3::uuid))
            order by msg.created_at desc, msg.id desc
            limit ${limit + 1}`,
          [id, after?.at ?? null, after?.id ?? null],
        );
        return { page: rows, viewerUserId: await resolveViewer(session) };
      });

      const hasMore = page.length > limit;
      const rows = hasMore ? page.slice(0, limit) : page;
      const last = rows[rows.length - 1];

      return {
        items: rows.map((row) => ({
          id: row.id,
          conversationId: id,
          senderUserId: row.sender_user_id,
          isMine: row.sender_user_id === viewerUserId,
          actedByUserId: row.acted_by_user_id,
          body: row.body,
          kind: row.kind,
          editedAt: row.edited_at,
          createdAt: row.created_at,
        })),
        nextCursor: hasMore && last ? encodeKeyset({ at: last.cursor_at, id: last.id }) : null,
        hasMore,
      };
    },
  );

  // --- POST /conversations/:id/messages ----------------------------------------

  /**
   * Send a message.
   *
   * Runs as the MEMBER. `messages_insert_when_permitted` is the authority:
   * participant, gate open, match live, no block, and `sender_user_id` pinned
   * to the caller. The check below exists to produce a useful 409 instead of
   * a policy violation, not to be the thing that decides.
   */
  fastify.post(
    '/conversations/:id/messages',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');
      const parsed = sendMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid message',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }

      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      const reason = writeBlockedReason(thread);
      if (reason !== null) {
        // 409 rather than 403: the request is well formed and the caller is
        // allowed to be here — the thread's STATE refuses it, and that state
        // can change.
        throw conflict(`This conversation cannot be written to: ${reason}`);
      }

      const created = await db.asUser(auth.authUserId, async (session) => {
        const rows = await session.query<{
          id: string;
          sender_user_id: string;
          body: string;
          kind: string;
          created_at: string;
        }>(
          // `kind` is NOT named (review B7). Since migration 0027 members hold
          // no grant on that column, so a member insert takes the default,
          // 'text' — and the 0026 policy pins it there too. A member cannot
          // post a message styled as a platform notice by any route. 0027 is
          // applied only after this API is live: the previous API named it.
          `insert into public.messages (conversation_id, sender_user_id, body)
           values ($1::uuid, app.current_user_id(), $2)
           returning id, sender_user_id, body, kind, created_at`,
          [id, parsed.data.body.trim()],
        );
        return rows[0] ?? null;
      });

      if (!created) throw conflict('This conversation cannot be written to');

      // Best effort, and deliberately outside the insert. A notification that
      // can roll back with the message is a message the other side never
      // hears about; a notification failure must never lose the message.
      try {
        await db.asService('conversation.notify_message', (session) =>
          session.query(
            // REVIEW B25. Never to someone who has left. A send into a thread
            // the counterpart left is already refused (above, and by 0028),
            // so this is the second lock on the same door: a participant
            // who walked away is not told about a thread they cannot open.
            //
            // REVIEW B26. ONE row per conversation, not one per message: the
            // row is revived — unread again, newest again, its count bumped —
            // instead of a new row being written for every message. The inbox
            // shows "3 new messages from Ayesha" once, and the table grows
            // with conversations rather than with chat volume.
            `insert into public.notifications (user_id, type, payload, dedupe_key)
             select $1::uuid, 'new_message', $2::jsonb, $3
              where not exists (
                select 1 from public.conversation_participants p
                 where p.conversation_id = $4::uuid
                   and p.user_id = $1::uuid
                   and p.left_at is not null
              )
             on conflict (user_id, type, dedupe_key) do update
               set payload = jsonb_build_object(
                     'conversationId', $4::text,
                     'messageId', excluded.payload ->> 'messageId',
                     'count', case
                       when public.notifications.read_at is null
                         then coalesce((public.notifications.payload ->> 'count')::int, 1) + 1
                       else 1
                     end
                   ),
                   read_at = null,
                   created_at = now()`,
            [
              thread.counterpart_user_id,
              JSON.stringify({ conversationId: id, messageId: created.id, count: 1 }),
              `new_message:${id}`,
              id,
            ],
          ),
        );
      } catch (error) {
        fastify.log.error({ err: error, conversationId: id }, 'message notification failed');
      }

      reply.code(201);
      return {
        id: created.id,
        conversationId: id,
        senderUserId: created.sender_user_id,
        isMine: true,
        actedByUserId: null,
        body: created.body,
        kind: created.kind,
        editedAt: null,
        createdAt: created.created_at,
      };
    },
  );

  // --- POST /conversations/:id/read --------------------------------------------

  fastify.post(
    '/conversations/:id/read',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');
      const parsed = markReadSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid read marker');

      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('No account for this session');

      await db.asService('conversation.mark_read', (session) =>
        session.query(
          // `greatest` on the timestamp so an out-of-order client cannot move
          // someone's read position BACKWARDS and resurrect notifications
          // they have already dealt with.
          `insert into public.message_reads
             (conversation_id, user_id, last_read_message_id, last_read_at)
           select $1::uuid, $2::uuid, msg.id, msg.created_at
             from public.messages msg
            where msg.id = $3::uuid and msg.conversation_id = $1::uuid
           on conflict (conversation_id, user_id) do update
             set last_read_message_id = excluded.last_read_message_id,
                 last_read_at = greatest(message_reads.last_read_at, excluded.last_read_at)`,
          [id, viewerUserId, parsed.data.lastReadMessageId],
        ),
      );

      reply.code(204);
      return null;
    },
  );

  // --- GET /conversations/:id/stage --------------------------------------------

  fastify.get('/conversations/:id/stage', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const id = uuidParam(request, 'id', 'conversation id');

    const thread = await loadThread(auth.authUserId, id);
    if (!thread) throw notFound('Conversation not found');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);

    // `stage_transitions` is RLS `system` with no member grant, so the
    // proposal is read here and only the parts both sides may see are
    // returned.
    const pending = await db.asService('conversation.stage_transition', async (session) => {
      const rows = await session.query<{
        id: string;
        from_stage: number;
        to_stage: number;
        proposed_by_user_id: string;
        status: string;
        created_at: string;
      }>(
        `select id, from_stage, to_stage, proposed_by_user_id, status, created_at
           from public.stage_transitions
          where conversation_id = $1::uuid and status = 'pending'`,
        [id],
      );
      return rows[0] ?? null;
    });

    return {
      conversationId: id,
      currentStage: thread.current_stage,
      pendingProposal: pending
        ? {
            id: pending.id,
            fromStage: pending.from_stage,
            toStage: pending.to_stage,
            proposedByUserId: pending.proposed_by_user_id,
            proposedByMe: pending.proposed_by_user_id === viewerUserId,
            status: pending.status,
            createdAt: pending.created_at,
          }
        : null,
    };
  });

  // --- POST /conversations/:id/stage/propose -----------------------------------

  /**
   * Propose advancing one stage.
   *
   * Requires an open gate. Advancing a conversation nobody is allowed to
   * write in would be a way of making progress while a family is still
   * deciding.
   */
  fastify.post(
    '/conversations/:id/stage/propose',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');

      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      const reason = writeBlockedReason(thread);
      if (reason !== null) throw conflict(`This conversation is not open: ${reason}`);
      if (thread.current_stage >= MAX_STAGE) throw conflict('This is already the final stage');

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('No account for this session');

      const created = await db.asService('conversation.stage_transition', async (session) => {
        const existing = await session.query<{ id: string }>(
          `select id from public.stage_transitions
            where conversation_id = $1::uuid and status = 'pending'`,
          [id],
        );
        if (existing.length > 0) return null;

        const rows = await session.query<{
          id: string;
          from_stage: number;
          to_stage: number;
          status: string;
          created_at: string;
        }>(
          `insert into public.stage_transitions
             (conversation_id, from_stage, to_stage, proposed_by_user_id)
           values ($1::uuid, $2::int, $2::int + 1, $3::uuid)
           returning id, from_stage, to_stage, status, created_at`,
          [id, thread.current_stage, viewerUserId],
        );
        return rows[0] ?? null;
      });

      if (!created) throw conflict('A stage proposal is already waiting');

      reply.code(201);
      return {
        id: created.id,
        fromStage: created.from_stage,
        toStage: created.to_stage,
        proposedByUserId: viewerUserId,
        proposedByMe: true,
        status: created.status,
        createdAt: created.created_at,
      };
    },
  );

  // --- POST /conversations/:id/stage/respond -----------------------------------

  /**
   * Accept or decline the pending proposal.
   *
   * MUTUAL BY CONSTRUCTION: the proposer is refused here, and the database
   * refuses them again through `stage_transitions_not_self_accepted`. One
   * side must never be able to move a conversation to a stage that unlocks
   * more of the other person.
   */
  fastify.post(
    '/conversations/:id/stage/respond',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');
      const parsed = respondToStageSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid response');

      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      // REVIEW B16. Propose and send both refused a closed thread; respond
      // did not, so a proposal made before a block, unmatch or family
      // revocation could still be accepted afterwards and advance a
      // conversation nobody may write in.
      const reason = writeBlockedReason(thread);
      if (reason !== null) throw conflict(`This conversation is not open: ${reason}`);

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('No account for this session');

      const outcome = await db.asService('conversation.stage_transition', async (session) => {
        const rows = await session.query<{
          id: string;
          to_stage: number;
          proposed_by_user_id: string;
        }>(
          `select id, to_stage, proposed_by_user_id from public.stage_transitions
            where conversation_id = $1::uuid and status = 'pending'
            for update`,
          [id],
        );
        const proposal = rows[0];
        if (!proposal) return { kind: 'none' as const };
        if (proposal.proposed_by_user_id === viewerUserId) return { kind: 'own' as const };

        // Asked again INSIDE the transaction, holding the proposal's lock.
        // The check above ran before it, and a block can land in between;
        // this is the answer that cannot be stale. (A closing that commits
        // first also cancels the proposal — 0028 — and the select above then
        // finds nothing.)
        const open = await session.query<{ ok: boolean }>(
          `select app.can_write_message($1::uuid, $2::uuid) as ok`,
          [viewerUserId, id],
        );
        if (!open[0]?.ok) return { kind: 'closed' as const };

        await session.query(
          `update public.stage_transitions
              set status = $2, responded_by_user_id = $3::uuid, responded_at = now()
            where id = $1::uuid`,
          [proposal.id, parsed.data.accept ? 'accepted' : 'declined', viewerUserId],
        );

        if (parsed.data.accept) {
          // Same transaction as the acceptance: a stage that moved without a
          // transition, or a transition with no stage change, would make the
          // ladder unauditable.
          await session.query(
            `update public.conversation_stages set current_stage = $2::int
              where conversation_id = $1::uuid`,
            [id, proposal.to_stage],
          );
        }

        return { kind: 'ok' as const, stage: parsed.data.accept ? proposal.to_stage : null };
      });

      if (outcome.kind === 'none') throw notFound('No stage proposal is waiting');
      if (outcome.kind === 'own') throw conflict('You cannot answer your own proposal');
      if (outcome.kind === 'closed') throw conflict('This conversation is not open');

      return {
        conversationId: id,
        currentStage: outcome.stage ?? thread.current_stage,
        pendingProposal: null,
      };
    },
  );

  // --- POST /conversations/:id/leave -------------------------------------------

  /**
   * Leave a conversation.
   *
   * Sets `left_at` rather than deleting the row, so the history keeps its
   * participants and a report filed later still names who was there. This is
   * not an unmatch, and `/matches/:id/unmatch` remains the way to end the
   * relationship itself.
   *
   * REVIEW B25. Leaving closes the conversation for BOTH participants,
   * permanently (decision 2026-11-01; no rejoin). The counterpart sees
   * `counterpart_left`, 0028's app.can_write_message refuses either side's
   * insert, the pending stage proposal is cancelled by 0028's trigger, and no
   * message notification is raised for the person who left.
   */
  fastify.post(
    '/conversations/:id/leave',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'id', 'conversation id');

      const thread = await loadThread(auth.authUserId, id);
      if (!thread) throw notFound('Conversation not found');

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) throw notFound('No account for this session');

      await db.asService('conversation.leave', (session) =>
        session.query(
          `update public.conversation_participants set left_at = now()
            where conversation_id = $1::uuid and user_id = $2::uuid and left_at is null`,
          [id, viewerUserId],
        ),
      );

      reply.code(204);
      return null;
    },
  );
};
