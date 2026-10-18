import type { FastifyPluginAsync } from 'fastify';
import {
  COMPATIBILITY_DIMENSIONS,
  DIMENSION_WEIGHTS,
  DISCOVERY_SECTIONS,
  ENGINE_VERSION,
  type DiscoverySection,
} from '@nikahmate/domain';
import { badRequest, notFound } from '../errors';
import { requireAuthContext } from '../auth/plugin';
import { ensureCandidates } from '../discovery/candidates';
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
 * Discovery and compatibility — read-only.
 *
 * Every route here SERVES precomputed data and none of them computes or writes
 * any. Candidate sets come from `match_candidates` and scores from
 * `compatibility_scores`, both produced by the Slice 4 generator. There is
 * deliberately no endpoint that writes either table: a member who could would
 * place themselves in someone else's feed or author a compatibility reason the
 * engine never produced.
 *
 * TWO LAYERS OF SAFETY, and the second one is the one that matters. RLS
 * confines every read to the caller's own rows. On top of that, the candidate
 * join re-applies `app.can_view_profile()` at READ time — because a
 * precomputed set is a snapshot, and someone who blocked the viewer or had
 * their profile unapproved since the last generation is still sitting in it.
 * The OpenAPI description says exactly this: "Blocks, dismissals and privacy
 * tiers are applied on read, so a profile blocked since the last precompute
 * never appears."
 */

export interface DiscoveryRoutesOptions {
  db: Db;
}

/**
 * Sections this slice can actually serve.
 *
 * `recommended` is the plain ranked output of the generator and needs no
 * semantics beyond the score. The other seven keys exist in the contract but
 * nothing defines what they mean yet, and one of them cannot be defined at
 * all: `nearby` would need a distance, and `user_locations` stores country,
 * region and city, never coordinates. Returning a fabricated band would be
 * worse than returning nothing.
 *
 * An unsupported key is therefore an explicit 404 rather than an empty list —
 * "this section does not exist yet" is information; an empty page is a lie
 * that looks like "nobody matches you".
 */
const SUPPORTED_SECTIONS: readonly DiscoverySection[] = ['recommended'];

const PREVIEW_SIZE = 5;

/**
 * Opaque keyset cursor.
 *
 * Keyed on `rank`, which is the stable total order the generator wrote. Base64
 * so it is opaque per the contract — a client that cannot read it cannot
 * construct one, which is what stops the cursor being used to page into
 * another viewer's feed. It is also checked against the viewer's own rows by
 * RLS regardless, so a forged cursor reveals nothing.
 */
/**
 * The card select.
 *
 * `app.can_view_profile()` is re-applied here rather than trusted from the
 * precompute. `profile_field_visibility` is read for the one card field it
 * governs — the city, through `location_precision`.
 *
 * Runs as the caller, so `match_candidates` and `compatibility_scores` are
 * already confined to them by RLS. The join to `profiles` is what makes the
 * freshness guarantee real.
 */
const CARD_SELECT = `
  select
    m.candidate_user_id as user_id,
    m.rank,
    u.display_name,
    extract(year from age(u.date_of_birth))::int as age,
    l.country_code,
    l.city_name,
    coalesce(
      (select v.visibility from public.profile_field_visibility v
        where v.user_id = m.candidate_user_id and v.field_key = 'location_precision'),
      'city'
    ) as location_precision,
    s.overall,
    vs.email_verified_at, vs.phone_verified_at, vs.selfie_verified_at,
    vs.id_verified_at, vs.profile_reviewed_at
  from public.match_candidates m
  join public.users u on u.id = m.candidate_user_id
  join public.profiles p on p.user_id = m.candidate_user_id
  left join public.user_locations l on l.user_id = m.candidate_user_id
  left join public.verification_status vs on vs.user_id = m.candidate_user_id
  left join public.compatibility_scores s
    on s.viewer_user_id = m.user_id and s.candidate_user_id = m.candidate_user_id
  where m.user_id = $1::uuid
    and m.section_key = $2::text
    and m.candidate_user_id <> $1::uuid
    and p.deleted_at is null
    and app.can_view_profile($1::uuid, m.candidate_user_id)
    and not exists (
      select 1 from public.dismissed_profiles d
       where d.user_id = $1::uuid and d.target_user_id = m.candidate_user_id
    )
`;

export const discoveryRoutes: FastifyPluginAsync<DiscoveryRoutesOptions> = async (
  fastify,
  { db },
) => {
  /**
   * Builds the cards, including the top reasons for each.
   *
   * `topReasons` holds i18n KEYS, never sentences. The engine produced a key
   * and the facts behind it; turning that into English is the client's job
   * against the catalogs, which is what keeps a reason template-rendered and
   * therefore incapable of inventing something about a real person.
   */
  /**
   * The caller's own users.id.
   *
   * Through `app.current_user_id()` rather than by reading `profiles`, which
   * since Slice 1 returns every profile the caller may VIEW — so a
   * `select ... limit 1` there resolves to an arbitrary stranger rather than
   * to the caller. That is the kind of mistake that silently serves one
   * member another member's feed.
   */
  const resolveViewer = async (session: DbSession): Promise<string | null> => {
    const rows = await session.query<{ user_id: string | null }>(
      `select app.current_user_id() as user_id`,
    );
    return rows[0]?.user_id ?? null;
  };

  // --- GET /discovery/sections -----------------------------------------------

  fastify.get('/discovery/sections', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) return { items: [] };

    // Generate first, OUTSIDE any open transaction. `generateCandidates()` had
    // no production call site at all, so this and the section read below are
    // the only reasons a real member's feed is ever populated.
    //
    // The claim inside `ensureCandidates` is shared with the section read, so
    // a client calling both endpoints in quick succession generates ONCE.
    await ensureCandidates(db, viewerUserId);

    // Service role, because a card carries the candidate's display name and
    // derived age and `users` is owner-only. Confinement is the explicit
    // `m.user_id = viewerUserId` plus `app.can_view_profile()` in CARD_SELECT,
    // with `viewerUserId` resolved above under the caller's own session.
    return db.asService('discovery.read_cards', async (session) => {
      const items = [];
      for (const key of SUPPORTED_SECTIONS) {
        const rows = await session.query<CardRow>(
          `${CARD_SELECT} order by m.rank limit ${PREVIEW_SIZE}`,
          [viewerUserId, key],
        );
        const counted = await session.query<{ n: string }>(
          `select count(*)::text as n from (${CARD_SELECT}) as visible`,
          [viewerUserId, key],
        );

        items.push({
          key,
          // The catalogs own the wording. A localised title generated here
          // would be English hardcoded into a route handler.
          titleKey: `discovery.section.${key}`,
          subtitleKey: null,
          totalCount: Number.parseInt(counted[0]?.n ?? '0', 10),
          preview: await buildCards(session, viewerUserId, rows),
          requiresEntitlement: null,
        });
      }
      return { items };
    });
  });

  // --- GET /discovery/sections/:sectionKey -----------------------------------

  fastify.get(
    '/discovery/sections/:sectionKey',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const params = request.params as { sectionKey?: string };
      const query = request.query as { cursor?: string; limit?: string };

      const sectionKey = params.sectionKey ?? '';
      if (!(DISCOVERY_SECTIONS as readonly string[]).includes(sectionKey)) {
        throw notFound('Unknown discovery section');
      }
      if (!SUPPORTED_SECTIONS.includes(sectionKey as DiscoverySection)) {
        // Named by the contract, not yet produced by anything. An empty page
        // would read as "nobody matches you", which is a different and untrue
        // statement.
        throw notFound('This discovery section is not available yet');
      }

      const limit = parseLimit(query.limit);

      const after = decodeCursor(query.cursor);
      if (query.cursor !== undefined && after === null) {
        throw badRequest('Invalid cursor');
      }

      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId) return { items: [], nextCursor: null, hasMore: false };

      // Only on the FIRST page. Generating while someone pages through would
      // swap the batch underneath them and break the frozen-batch guarantee the
      // cursor depends on — the reader would see repeats or skips.
      if (after === null) {
        await ensureCandidates(db, viewerUserId, sectionKey as DiscoverySection);
      }

      return db.asService('discovery.read_cards', async (session) => {
        // One row over the limit, so `hasMore` is observed rather than guessed.
        const rows = await session.query<CardRow>(
          `${CARD_SELECT}
             ${after === null ? '' : 'and m.rank > $3::int'}
           order by m.rank
           limit ${limit + 1}`,
          after === null ? [viewerUserId, sectionKey] : [viewerUserId, sectionKey, after],
        );

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        return {
          items: await buildCards(session, viewerUserId, page),
          nextCursor: hasMore && last ? encodeCursor(last.rank) : null,
          hasMore,
        };
      });
    },
  );

  // ===========================================================================
  // Owner actions
  //
  // Member-owned writes, so they run as the CALLER and RLS is the guarantee:
  // every policy on `shortlists` and `dismissed_profiles` pins
  // `user_id = app.current_user_id()`, on INSERT as well as SELECT and DELETE.
  // No service-role path exists for any of them, because nothing about these
  // rows is system-generated.
  //
  // All three mutations answer 204 and are idempotent, which is what the
  // contract specifies and what makes a double tap or a retry after a timeout
  // harmless. `on conflict do nothing` turns a repeat into a no-op rather than
  // a 409 — saving the same profile twice is one statement made twice, not a
  // conflict, and the contract defines no 409 for these routes.
  // ===========================================================================

  /**
   * Resolves a path user id, refusing anything the caller may not act on.
   *
   * Self and not-viewable both answer 404, deliberately indistinguishable. A
   * 403 on a blocked target would confirm that member exists, which is exactly
   * what the blocked party must not learn — the same reasoning the
   * compatibility endpoints use.
   */
  const resolveTarget = async (
    session: DbSession,
    viewerUserId: string,
    raw: string | undefined,
  ): Promise<string> => {
    const targetUserId = raw ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw badRequest('Invalid user id');
    if (targetUserId === viewerUserId) throw notFound('Profile not found');

    const visible = await session.query<{ ok: boolean }>(
      `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
      [viewerUserId, targetUserId],
    );
    if (!visible[0]?.ok) throw notFound('Profile not found');
    return targetUserId;
  };

  // --- GET /discovery/shortlist ---------------------------------------------

  fastify.get('/discovery/shortlist', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };

    const limit = parseLimit(query.limit);
    const after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) return { items: [], nextCursor: null, hasMore: false };

    // Saved ids as the caller, so RLS confines the list to their own rows.
    // Ordered newest first, with the id as a tiebreak so the keyset is total.
    const saved = await db.asUser(auth.authUserId, (session) =>
      session.query<{ target_user_id: string; position: number }>(
        `select target_user_id,
                (row_number() over (order by created_at desc, target_user_id))::int - 1
                  as position
           from public.shortlists
          where user_id = $1::uuid`,
        [viewerUserId],
      ),
    );

    const window = saved
      .filter((row) => after === null || row.position > after)
      .sort((a, b) => a.position - b.position);
    const hasMore = window.length > limit;
    const page = hasMore ? window.slice(0, limit) : window;

    if (page.length === 0) return { items: [], nextCursor: null, hasMore: false };

    // Cards need the display name and derived age from `users`, which is
    // owner-only — the same reason the feed uses this path. A saved profile
    // that has since blocked the viewer drops out via can_view_profile.
    const items = await db.asService('discovery.read_cards', async (session) => {
      const rows = await session.query<CardRow>(CARDS_BY_USER_IDS, [
        viewerUserId,
        page.map((w) => w.target_user_id),
      ]);
      const ordered = page
        .map((w) => rows.find((r) => r.user_id === w.target_user_id))
        .filter((r): r is CardRow => r !== undefined);
      return buildCards(session, viewerUserId, ordered);
    });

    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.position) : null,
      hasMore,
    };
  });

  // --- PUT /discovery/shortlist/:userId -------------------------------------

  fastify.put(
    '/discovery/shortlist/:userId',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { userId?: string };

      await db.asUser(auth.authUserId, async (session) => {
        const viewerUserId = await resolveViewer(session);
        if (!viewerUserId) throw notFound('Profile not found');
        const targetUserId = await resolveTarget(session, viewerUserId, params.userId);

        await session.query(
          `insert into public.shortlists (user_id, target_user_id)
           values ($1::uuid, $2::uuid)
           on conflict (user_id, target_user_id) do nothing`,
          [viewerUserId, targetUserId],
        );
      });

      return reply.code(204).send();
    },
  );

  // --- DELETE /discovery/shortlist/:userId ----------------------------------

  fastify.delete(
    '/discovery/shortlist/:userId',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { userId?: string };
      const targetUserId = params.userId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw badRequest('Invalid user id');

      // No visibility check on removal, on purpose. Someone who blocked the
      // viewer after being saved must still be removable — otherwise a block
      // would pin a row in the viewer's own list that they can see and cannot
      // delete. The RLS policy already confines this to their own rows.
      await db.asUser(auth.authUserId, (session) =>
        session.query(
          `delete from public.shortlists
            where user_id = app.current_user_id() and target_user_id = $1::uuid`,
          [targetUserId],
        ),
      );

      // 204 whether or not a row existed: removing something already removed
      // is the state the caller asked for.
      return reply.code(204).send();
    },
  );

  // --- POST /discovery/:userId/dismiss --------------------------------------

  fastify.post(
    '/discovery/:userId/dismiss',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = request.params as { userId?: string };

      await db.asUser(auth.authUserId, async (session) => {
        const viewerUserId = await resolveViewer(session);
        if (!viewerUserId) throw notFound('Profile not found');
        const targetUserId = await resolveTarget(session, viewerUserId, params.userId);

        await session.query(
          `insert into public.dismissed_profiles (user_id, target_user_id)
           values ($1::uuid, $2::uuid)
           on conflict (user_id, target_user_id) do nothing`,
          [viewerUserId, targetUserId],
        );
      });

      return reply.code(204).send();
    },
  );

  // --- GET /compatibility/dimensions ----------------------------------------
  //
  // Public and static: the dimension list and its weights are the model, not
  // anyone's data. Registered before the parameterised route so `dimensions`
  // is never read as a user id.

  fastify.get('/compatibility/dimensions', async () => ({
    engineVersion: ENGINE_VERSION,
    items: COMPATIBILITY_DIMENSIONS.map((key) => ({
      key,
      weight: DIMENSION_WEIGHTS[key],
      labelKey: `compatibility.${key}`,
    })),
  }));

  // --- GET /compatibility/:userId -------------------------------------------

  interface ScoreRow {
    id: string;
    overall: string;
    engine_version: string;
    computed_at: string;
  }

  interface FactorRow {
    dimension: string;
    sub_score: string | null;
    weight: string;
    is_hard: boolean;
    facts: Record<string, unknown>;
    explanation_key: string;
  }

  /**
   * Loads one persisted score, or refuses.
   *
   * NEVER RECOMPUTES. If no row exists the answer is 404, not a fresh
   * calculation: scoring on demand would make the endpoint's cost unbounded
   * and, worse, could return a number that differs from the one the candidate
   * feed was ranked by.
   *
   * The viewer direction is enforced twice — by the RLS policy, which only
   * exposes rows where `viewer_user_id` is the caller, and by the explicit
   * `can_view_profile` check, which catches a block applied since the score
   * was computed. A member asking about the score computed ABOUT them finds
   * nothing, because no such row is theirs to read.
   */
  const loadScore = async (
    session: DbSession,
    viewerUserId: string,
    targetUserId: string,
  ): Promise<{ score: ScoreRow; factors: FactorRow[] }> => {
    if (targetUserId === viewerUserId) {
      throw notFound('No compatibility exists between a member and themselves');
    }
    const visible = await session.query<{ ok: boolean }>(
      `select app.can_view_profile($1::uuid, $2::uuid) as ok`,
      [viewerUserId, targetUserId],
    );
    if (!visible[0]?.ok) {
      // Deliberately the same 404 a missing score produces. A 403 here would
      // confirm that the other member exists, which is exactly what a block is
      // supposed to stop the blocked party learning.
      throw notFound('No compatibility available for this profile');
    }

    const scores = await session.query<ScoreRow>(
      `select id, overall, engine_version, computed_at
         from public.compatibility_scores
        where viewer_user_id = $1::uuid and candidate_user_id = $2::uuid`,
      [viewerUserId, targetUserId],
    );
    const score = scores[0];
    if (!score) throw notFound('No compatibility available for this profile');

    const factors = await session.query<FactorRow>(
      `select dimension, sub_score, weight, is_hard, facts, explanation_key
         from public.compatibility_factors
        where score_id = $1::uuid
        order by dimension`,
      [score.id],
    );
    return { score, factors };
  };

  fastify.get('/compatibility/:userId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const params = request.params as { userId?: string };
    const targetUserId = params.userId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw badRequest('Invalid user id');

    return db.asUser(auth.authUserId, async (session) => {
      const viewerUserId = await resolveViewer(session);
      if (!viewerUserId) throw notFound('No compatibility available for this profile');

      const { score, factors } = await loadScore(session, viewerUserId, targetUserId);
      return {
        userId: targetUserId,
        overall: Number.parseFloat(score.overall),
        engineVersion: score.engine_version,
        computedAt: score.computed_at,
        dimensions: factors.map((f) => ({
          key: f.dimension,
          subScore: f.sub_score === null ? null : Number.parseFloat(f.sub_score),
          weight: Number.parseFloat(f.weight),
        })),
      };
    });
  });

  // --- GET /compatibility/:userId/explanation -------------------------------

  /**
   * The reasons, as KEYS AND FACTS — never as prose.
   *
   * The contract's `text` field is deliberately absent from this response.
   * Rendering a sentence here would put English in a route handler and, more
   * importantly, would be the one place where a reason could drift from the
   * values it claims to describe. The client renders `messageKey` against the
   * catalogs using `facts`, which is what makes an explanation regenerable and
   * a complaint investigable (ADR 0001).
   *
   * Differences are returned alongside the positives because a one-sided
   * explanation is a sales pitch rather than information — the contract says
   * so in as many words.
   */
  fastify.get(
    '/compatibility/:userId/explanation',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const params = request.params as { userId?: string };
      const targetUserId = params.userId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw badRequest('Invalid user id');

      return db.asUser(auth.authUserId, async (session) => {
        const viewerUserId = await resolveViewer(session);
        if (!viewerUserId) throw notFound('No compatibility available for this profile');

        const { score, factors } = await loadScore(session, viewerUserId, targetUserId);
        const applicable = factors.filter((f) => f.sub_score !== null);
        const sentimentOf = (value: number): 'strong' | 'moderate' | 'differs' =>
          value >= 70 ? 'strong' : value >= 40 ? 'moderate' : 'differs';

        const entries = applicable.map((f) => {
          const value = Number.parseFloat(f.sub_score as string);
          return {
            dimension: f.dimension,
            messageKey: f.explanation_key,
            sentiment: sentimentOf(value),
            subScore: value,
            // The values actually compared. This is what makes the reason
            // true by construction rather than plausible.
            facts: f.facts,
          };
        });

        return {
          userId: targetUserId,
          overall: Number.parseFloat(score.overall),
          engineVersion: score.engine_version,
          reasons: entries
            .filter((e) => e.sentiment !== 'differs')
            .sort((a, b) => b.subScore - a.subScore),
          differences: entries
            .filter((e) => e.sentiment === 'differs')
            .sort((a, b) => a.subScore - b.subScore),
        };
      });
    },
  );
};
