import { badRequest } from '../errors';
import type { DbSession } from '../db/types';

/**
 * The profile card, and the paging primitives that go with it.
 *
 * Extracted from the discovery routes so interests and matches serve the SAME
 * card rather than a second one. A duplicate serializer is how a privacy rule
 * gets fixed in one place and left wrong in the other — and the rules here are
 * the ones that matter: the member's own location precision, the age without
 * the birth date, and nothing from `profile_sensitive` at any point.
 *
 * WHAT A CARD DELIBERATELY DOES NOT CARRY. No `dateOfBirth` (only the derived
 * age), no `reviewStatus`, no moderation state, no contact details, no
 * `aboutMe`. The column list below is the allowlist; a field that is not
 * selected cannot leak.
 */

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
const MAX_REASONS = 3;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

/**
 * Opaque keyset cursor over a zero-based position.
 *
 * Base64 so it is opaque per the contract — a client that cannot read one
 * cannot construct one. It carries no identity, and every query it feeds is
 * independently scoped to the caller, so a forged cursor reveals nothing.
 */
export function encodeCursor(position: number): string {
  return Buffer.from(`r:${position}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^r:(\d+)$/.exec(decoded);
    if (!match) return null;
    const position = Number.parseInt(match[1]!, 10);
    return Number.isSafeInteger(position) ? position : null;
  } catch {
    return null;
  }
}

export interface CardRow {
  user_id: string;
  display_name: string | null;
  age: number | null;
  country_code: string | null;
  city_name: string | null;
  location_precision: string | null;
  overall: string | null;
  rank: number;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  selfie_verified_at: string | null;
  id_verified_at: string | null;
  profile_reviewed_at: string | null;
}

/**
 * Cards for an explicit list of user ids.
 *
 * `$1` is the viewer, `$2` the ids. `app.can_view_profile()` is applied here
 * and not assumed from whatever produced the ids — a counterpart who has since
 * blocked the viewer, been suspended or lost approval drops out, which is what
 * keeps a stale interest or match from resurrecting a profile.
 *
 * The age is derived in SQL so `users.date_of_birth` never leaves the service.
 */
export const CARDS_BY_USER_IDS = `
  select
    u.id as user_id,
    0 as rank,
    u.display_name,
    extract(year from age(u.date_of_birth))::int as age,
    l.country_code,
    l.city_name,
    coalesce(
      (select v.visibility from public.profile_field_visibility v
        where v.user_id = u.id and v.field_key = 'location_precision'),
      'city'
    ) as location_precision,
    s.overall,
    vs.email_verified_at, vs.phone_verified_at, vs.selfie_verified_at,
    vs.id_verified_at, vs.profile_reviewed_at
  from public.users u
  join public.profiles p on p.user_id = u.id
  left join public.user_locations l on l.user_id = u.id
  left join public.verification_status vs on vs.user_id = u.id
  left join public.compatibility_scores s
    on s.viewer_user_id = $1::uuid and s.candidate_user_id = u.id
  where u.id = any($2::uuid[])
    and p.deleted_at is null
    and app.can_view_profile($1::uuid, u.id)
`;

interface ReasonRow {
  candidate_user_id: string;
  dimension: string;
  explanation_key: string;
  sub_score: string | null;
}

/**
 * Builds cards for rows already fetched.
 *
 * Three queries total regardless of page size — the rows, their reasons, and
 * the shortlist membership — rather than one per card. That is the whole
 * reason this takes an array.
 */
export async function buildCards(
  session: DbSession,
  viewerUserId: string,
  rows: readonly CardRow[],
): Promise<unknown[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.user_id);

  const reasons = await session.query<ReasonRow>(
    `select s.candidate_user_id, f.dimension, f.explanation_key, f.sub_score
       from public.compatibility_factors f
       join public.compatibility_scores s on s.id = f.score_id
      where s.viewer_user_id = $1::uuid
        and s.candidate_user_id = any($2::uuid[])
        and f.sub_score is not null
      order by f.sub_score desc, f.dimension`,
    [viewerUserId, ids],
  );

  const shortlisted = new Set(
    (
      await session.query<{ target_user_id: string }>(
        `select target_user_id from public.shortlists
          where user_id = $1::uuid and target_user_id = any($2::uuid[])`,
        [viewerUserId, ids],
      )
    ).map((r) => r.target_user_id),
  );

  const byCandidate = new Map<string, string[]>();
  for (const reason of reasons) {
    const list = byCandidate.get(reason.candidate_user_id) ?? [];
    // Only genuinely positive dimensions become a headline reason. A "reason"
    // that reports a poor match is a difference, and differences belong in the
    // explanation endpoint where they are shown honestly alongside the
    // positives rather than dressed up as a selling point.
    if (list.length < MAX_REASONS && Number.parseFloat(reason.sub_score ?? '0') >= 70) {
      list.push(reason.explanation_key);
    }
    byCandidate.set(reason.candidate_user_id, list);
  }

  return rows.map((row) => {
    const precision = row.location_precision ?? 'city';
    const badges = [
      ['email_verified', row.email_verified_at],
      ['phone_verified', row.phone_verified_at],
      ['photo_verified', row.selfie_verified_at],
      ['id_verified', row.id_verified_at],
      ['profile_reviewed', row.profile_reviewed_at],
    ] as const;

    return {
      userId: row.user_id,
      displayName: row.display_name,
      age: row.age,
      countryCode: row.country_code,
      // The member's own precision choice decides this, not the viewer's
      // relationship: `region` and `country` both mean "do not show my city".
      cityName: precision === 'city' ? row.city_name : null,
      // Banded distance needs a distance. `user_locations` has no coordinates,
      // so there is nothing to band and the contract's null is the honest
      // answer.
      distanceBand: null,
      // Signing another member's object is refused by the Storage policies
      // from migration 0007, and this service holds no service-role key by
      // design (README §9.3). Cross-user photo delivery is a deliberate gap.
      primaryPhoto: null,
      compatibilityScore: row.overall === null ? null : Number.parseFloat(row.overall),
      topReasons: byCandidate.get(row.user_id) ?? [],
      verification: {
        badges: badges
          .filter(([, earnedAt]) => earnedAt !== null)
          .map(([key, earnedAt]) => ({ key, earnedAt })),
      },
      isShortlisted: shortlisted.has(row.user_id),
    };
  });
}
