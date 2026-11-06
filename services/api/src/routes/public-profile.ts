import type { FastifyPluginAsync } from 'fastify';
import { VISIBILITY_FIELD_KEYS, type VisibilityFieldKey } from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, notFound } from '../errors';
import { buildCards, CARDS_BY_USER_IDS, parseLimit, type CardRow } from '../discovery/cards';
import { requireEntitlement } from '../entitlements/service';
import { decodeKeyset, encodeKeyset, keysetTime } from '../http/cursor';
import type { Db, DbSession } from '../db/types';
import { uuidParam } from '../http/params';
import { VISIBILITY_DEFAULTS } from './photos';

/**
 * GET /profiles/{userId} — another member's profile, permission-filtered.
 * Review L4: specified in docs/openapi.yaml (`getProfile`, `PublicProfile`)
 * and never built, so the profile screen was thin and per-field visibility was
 * never enforced against another viewer.
 *
 * The contract, enforced here rather than trusted to the client:
 *   - Fields the viewer may not see are ABSENT, not null.
 *   - 404, never 403, when the viewer may not see the profile at all — blocked
 *     either way, suspended, unapproved, deleted. A 403 would confirm the
 *     account exists. The gate is `app.can_view_profile` INSIDE the query, so
 *     nothing about such a member can be read in the first place.
 *   - The date of birth is never returned; age is computed.
 *
 * Field visibility (README §9.4): `public` is shown to any viewer who may see
 * the profile; `matched_only` only within a live match; `on_request` and
 * `private` are withheld — the request flow is not built, so `on_request`
 * can only be honoured by withholding. A field with no stored choice takes the
 * member's default (`VISIBILITY_DEFAULTS`, the same table /me/profile/visibility
 * reports).
 *
 * Not included yet, and stated: photos (cross-member delivery is L3) and the
 * distance band (no coordinates are stored).
 */

export interface PublicProfileRoutesOptions {
  db: Db;
}

interface PublicProfileRow {
  user_id: string;
  display_name: string | null;
  age: number | null;
  gender: string | null;
  country_code: string | null;
  marital_status_code: string | null;
  religious_practice_code: string | null;
  marriage_timeline_code: string | null;
  relocation_willingness_code: string | null;
  has_children: boolean | null;
  languages: string[] | null;
  about_me: string | null;
  relationship: string;
  visibility: Record<string, string> | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  selfie_verified_at: string | null;
  id_verified_at: string | null;
  profile_reviewed_at: string | null;
}

const RELATIONSHIP: Readonly<Record<string, 'stranger' | 'interest_pending' | 'match' | 'wali'>> = {
  interest_pending: 'interest_pending',
  match: 'match',
  own_wali: 'wali',
  counterpart_wali: 'wali',
};

/** Which governed fields this viewer may see. */
function visibleTo(
  relationship: string,
  stored: Record<string, string>,
): (key: VisibilityFieldKey) => boolean {
  return (key) => {
    const setting = stored[key] ?? VISIBILITY_DEFAULTS[key];
    if (setting === 'public') return true;
    if (setting === 'matched_only') return relationship === 'match';
    return false; // on_request (flow not built) and private
  };
}

const resolveViewer = async (session: DbSession): Promise<string | null> => {
  const rows = await session.query<{ id: string | null }>(`select app.current_user_id() as id`);
  return rows[0]?.id ?? null;
};

/** The columns a public profile is shaped from. `$1` is the viewer. */
const PROFILE_COLUMNS = `
  u.id as user_id,
  u.display_name,
  extract(year from age(u.date_of_birth))::int as age,
  u.gender,
  l.country_code,
  p.marital_status_code, p.religious_practice_code,
  p.marriage_timeline_code, p.relocation_willingness_code,
  p.has_children, p.languages, p.about_me,
  app.relationship($1::uuid, u.id) as relationship,
  (select jsonb_object_agg(v.field_key, v.visibility)
     from public.profile_field_visibility v where v.user_id = u.id) as visibility,
  vs.email_verified_at, vs.phone_verified_at, vs.selfie_verified_at,
  vs.id_verified_at, vs.profile_reviewed_at`;

const PROFILE_FROM = `
  from public.users u
  join public.profiles p on p.user_id = u.id
  left join public.user_locations l on l.user_id = u.id
  left join public.verification_status vs on vs.user_id = u.id`;

type ViewerRelationship = 'stranger' | 'interest_pending' | 'match' | 'wali';

/**
 * The `PublicProfile` a viewer in `relationship` may see. One shaping
 * function for both the real read and the owner's preview, so the preview can
 * never disagree with what others actually get.
 */
function shapePublicProfile(row: PublicProfileRow, relationship: ViewerRelationship) {
  // A counterpart's wali sees through the principal's match (README §9.4:
  // intersection, never union), so `wali` gets the match-level view.
  const can = visibleTo(relationship === 'wali' ? 'match' : relationship, row.visibility ?? {});
  const governed = VISIBILITY_FIELD_KEYS.filter((k) => k !== 'location_precision');
  const hiddenFieldCount = governed.filter((k) => !can(k)).length;

  // Which checks were passed, never when (review B20).
  const badges = (
    [
      ['email_verified', row.email_verified_at],
      ['phone_verified', row.phone_verified_at],
      ['photo_verified', row.selfie_verified_at],
      ['id_verified', row.id_verified_at],
      ['profile_reviewed', row.profile_reviewed_at],
    ] as const
  )
    .filter(([, at]) => at !== null)
    .map(([key]) => ({ key, earnedAt: null }));

  return {
    userId: row.user_id,
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    ...(row.age !== null ? { age: row.age } : {}),
    ...(row.gender !== null ? { gender: row.gender } : {}),
    ...(row.country_code !== null ? { countryCode: row.country_code } : {}),
    ...(row.marital_status_code !== null ? { maritalStatusCode: row.marital_status_code } : {}),
    ...(row.religious_practice_code !== null
      ? { religiousPracticeCode: row.religious_practice_code }
      : {}),
    marriageTimelineCode: row.marriage_timeline_code,
    relocationWillingnessCode: row.relocation_willingness_code,
    // Children are `children_details`: absent unless that field is visible.
    ...(can('children_details') ? { hasChildren: row.has_children } : {}),
    languages: row.languages ?? [],
    ...(can('about_me') && row.about_me !== null ? { aboutMe: row.about_me } : {}),
    distanceBand: null,
    verification: { badges },
    photos: [],
    viewerRelationship: relationship,
    hiddenFieldCount,
  };
}

/** Repeated views by the same person within this window are one view. */
const VIEW_DEDUPE_MINUTES = 30;

export const publicProfileRoutes: FastifyPluginAsync<PublicProfileRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { db } = opts;

  fastify.get('/profiles/:userId', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const targetUserId = uuidParam(request, 'userId', 'user id');

    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    // Your own profile is /me/profile; this endpoint is about someone else.
    if (!viewerUserId || viewerUserId === targetUserId) throw notFound('Profile not found');

    const rows = await db.asService('profile.read_public', (session) =>
      session.query<PublicProfileRow>(
        `select ${PROFILE_COLUMNS}
           ${PROFILE_FROM}
          where u.id = $2::uuid
            and p.deleted_at is null
            and app.can_view_profile($1::uuid, u.id)`,
        [viewerUserId, targetUserId],
      ),
    );
    const row = rows[0];
    if (!row) throw notFound('Profile not found');
    return shapePublicProfile(row, RELATIONSHIP[row.relationship] ?? 'stranger');
  });

  // --- GET /me/profile/preview ------------------------------------------------

  /**
   * How MY profile appears to a viewer in a given relationship (L10). The same
   * shaping as the real read, applied to the caller's own row with the
   * relationship they choose — so "hide my about-me from strangers" can be
   * checked before anyone else sees the result.
   */
  fastify.get('/me/profile/preview', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const as = (request.query as { as?: string }).as;
    if (as !== 'stranger' && as !== 'interest_pending' && as !== 'match' && as !== 'wali') {
      throw badRequest('`as` must be one of stranger, interest_pending, match, wali', {
        as: 'invalid',
      });
    }
    const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
    if (!viewerUserId) throw notFound('No account for this session');

    const rows = await db.asService('profile.read_public', (session) =>
      session.query<PublicProfileRow>(
        `select ${PROFILE_COLUMNS}
           ${PROFILE_FROM}
          where u.id = $1::uuid and p.deleted_at is null`,
        [viewerUserId],
      ),
    );
    const row = rows[0];
    if (!row) throw notFound('No profile yet');
    return shapePublicProfile(row, as);
  });

  // --- POST /profiles/:userId/view -------------------------------------------

  /**
   * Record a view (L10). Recorded whether or not the viewer is incognito —
   * recording is for abuse investigation; hiding incognito viewers is the
   * listing's job (ERD §9). Only a profile the viewer may actually see can be
   * "viewed", so this cannot probe for hidden accounts (404 as elsewhere).
   * Repeat views within VIEW_DEDUPE_MINUTES count once.
   */
  fastify.post(
    '/profiles/:userId/view',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const targetUserId = uuidParam(request, 'userId', 'user id');
      const viewerUserId = await db.asUser(auth.authUserId, resolveViewer);
      if (!viewerUserId || viewerUserId === targetUserId) throw notFound('Profile not found');

      const visible = await db.asUser(auth.authUserId, (session) =>
        session.query<{ ok: boolean }>(`select app.can_view_profile($1::uuid, $2::uuid) as ok`, [
          viewerUserId,
          targetUserId,
        ]),
      );
      if (!visible[0]?.ok) throw notFound('Profile not found');

      await db.asService('profile.record_view', (session) =>
        session.query(
          `insert into public.profile_views (viewer_user_id, viewed_user_id)
           select $1::uuid, $2::uuid
            where not exists (
              select 1 from public.profile_views v
               where v.viewer_user_id = $1::uuid and v.viewed_user_id = $2::uuid
                 and v.viewed_at > now() - make_interval(mins => $3::int)
            )`,
          [viewerUserId, targetUserId, VIEW_DEDUPE_MINUTES],
        ),
      );
      return reply.code(204).send();
    },
  );

  // --- GET /me/profile-views --------------------------------------------------

  /**
   * Who viewed me (L10). Entitlement-gated (`who_viewed_me`, false on the
   * free plan → 403 `entitlement_required`). One card per viewer, most recent
   * view first. Excluded: viewers with EFFECTIVE incognito (on and entitled,
   * as in review B3), and anyone the caller may not see (blocked either way,
   * suspended, unapproved) — the same `can_view_profile` gate every card uses.
   */
  fastify.get('/me/profile-views', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeKeyset(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const me = await db.asUser(auth.authUserId, resolveViewer);
    if (!me) throw notFound('No account for this session');
    await requireEntitlement(db, auth.authUserId, me, 'who_viewed_me');

    const viewers = await db.asService('profile.read_views', (session) =>
      session.query<{ viewer_user_id: string; cursor_at: string }>(
        `select v.viewer_user_id,
                ${keysetTime('max(v.viewed_at)')} as cursor_at
           from public.profile_views v
           left join public.user_settings s on s.user_id = v.viewer_user_id
          where v.viewed_user_id = $1::uuid
            and not (coalesce(s.incognito, false)
                     and app.has_entitlement_flag(v.viewer_user_id, 'incognito'))
            and app.can_view_profile($1::uuid, v.viewer_user_id)
          group by v.viewer_user_id
         having $2::timestamptz is null
             or (max(v.viewed_at), v.viewer_user_id) < ($2::timestamptz, $3::uuid)
          order by max(v.viewed_at) desc, v.viewer_user_id desc
          limit ${limit + 1}`,
        [me, after?.at ?? null, after?.id ?? null],
      ),
    );
    const hasMore = viewers.length > limit;
    const page = hasMore ? viewers.slice(0, limit) : viewers;
    if (page.length === 0) return { items: [], nextCursor: null, hasMore: false };

    const cards = await db.asService('discovery.read_cards', async (session) => {
      const rows = await session.query<CardRow>(CARDS_BY_USER_IDS, [
        me,
        page.map((p) => p.viewer_user_id),
      ]);
      return buildCards(session, me, rows);
    });
    // Keep the most-recent-first order of the views, not the card query's.
    const byId = new Map((cards as Array<{ userId: string }>).map((c) => [c.userId, c]));
    const last = page[page.length - 1]!;
    return {
      items: page.map((p) => byId.get(p.viewer_user_id)).filter((c) => c !== undefined),
      nextCursor: hasMore ? encodeKeyset({ at: last.cursor_at, id: last.viewer_user_id }) : null,
      hasMore,
    };
  });
};
