import type { FastifyPluginAsync } from 'fastify';
import {
  MIN_ABOUT_ME_LENGTH,
  REQUIRED_FOR_REVIEW,
  preferencesUpdateSchema,
  profileUpdateSchema,
  type OwnProfile,
  type Preferences,
  type ProfileCompletion,
} from '@nikahmate/domain';
import { badRequest, conflict, notFound } from '../errors';
import { requireAuthContext } from '../auth/plugin';
import type { Db, DbSession } from '../db/types';
import { isoTimestamp } from '../db/sql';

/**
 * Profile and partner preferences.
 *
 * Everything here runs as `asUser`, so RLS scopes every statement to the
 * caller. None of these queries carries a `where user_id = ...` for
 * authorization — the policy does that — and the tests assert it, so an
 * accidental policy removal fails loudly instead of silently widening access.
 *
 * `profile_sensitive` is the one exception. It has zero policies by design, so
 * reading the owner's own contact details needs the service role and an
 * enumerated reason.
 */

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  about_me: string | null;
  looking_for: string | null;
  nationality_code: string | null;
  languages: string[];
  height_cm: number | null;
  marital_status_code: string | null;
  has_children: boolean | null;
  children_count: number | null;
  children_live_with_me: boolean | null;
  marriage_timeline_code: string | null;
  relocation_willingness_code: string | null;
  relocation_target_countries: string[];
  education_level_code: string | null;
  field_of_study_code: string | null;
  institution: string | null;
  profession_code: string | null;
  industry_code: string | null;
  employment_status_code: string | null;
  religious_practice_code: string | null;
  sect_code: string | null;
  prayer_frequency_code: string | null;
  quran_level_code: string | null;
  dress_practice_code: string | null;
  family_background: string | null;
  hobbies: string[];
  lifestyle_attributes: string[];
  personality_traits: string[];
  diet_code: string | null;
  smoking_code: string | null;
  review_status: string;
  completion_score: number;
  rejection_reason_key: string | null;
  updated_at: string;
  country_code: string | null;
  region_code: string | null;
  city_name: string | null;
  display_precision: string | null;
}

/**
 * One statement for the whole profile.
 *
 * `users` and `user_locations` are joined rather than fetched separately: the
 * profile screen needs all three, and three round trips over a 3G connection
 * in a target market is the difference between a usable screen and a spinner.
 */
const PROFILE_SELECT = `
  select p.user_id,
         u.display_name, u.date_of_birth::text as date_of_birth, u.gender,
         p.about_me, p.looking_for, p.nationality_code, p.languages, p.height_cm,
         p.marital_status_code, p.has_children, p.children_count,
         p.children_live_with_me, p.marriage_timeline_code,
         p.relocation_willingness_code, p.relocation_target_countries,
         p.education_level_code, p.field_of_study_code, p.institution,
         p.profession_code, p.industry_code, p.employment_status_code,
         p.religious_practice_code, p.sect_code, p.prayer_frequency_code,
         p.quran_level_code, p.dress_practice_code, p.family_background,
         p.hobbies, p.lifestyle_attributes, p.personality_traits,
         p.diet_code, p.smoking_code,
         p.review_status, p.completion_score, p.rejection_reason_key,
         ${isoTimestamp('p.updated_at')} as updated_at,
         l.country_code, l.region_code, l.city_name, l.display_precision
  from public.profiles p
  join public.users u on u.id = p.user_id
  left join public.user_locations l on l.user_id = p.user_id
`;

interface SensitiveRow {
  phone_e164: string | null;
  email: string | null;
  employer_name: string | null;
  workplace_city: string | null;
}

function toProfile(row: ProfileRow, sensitive: SensitiveRow | undefined): OwnProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    dateOfBirth: row.date_of_birth,
    gender: row.gender as OwnProfile['gender'],
    aboutMe: row.about_me,
    lookingFor: row.looking_for,
    nationalityCode: row.nationality_code,
    languages: row.languages ?? [],
    heightCm: row.height_cm,
    maritalStatusCode: row.marital_status_code,
    hasChildren: row.has_children,
    childrenCount: row.children_count,
    childrenLiveWithMe: row.children_live_with_me,
    marriageTimelineCode: row.marriage_timeline_code,
    relocationWillingnessCode: row.relocation_willingness_code,
    relocationTargetCountries: row.relocation_target_countries ?? [],
    educationLevelCode: row.education_level_code,
    fieldOfStudyCode: row.field_of_study_code,
    institution: row.institution,
    professionCode: row.profession_code,
    industryCode: row.industry_code,
    employmentStatusCode: row.employment_status_code,
    religiousPracticeCode: row.religious_practice_code,
    sectCode: row.sect_code,
    prayerFrequencyCode: row.prayer_frequency_code,
    quranLevelCode: row.quran_level_code,
    dressPracticeCode: row.dress_practice_code,
    familyBackground: row.family_background,
    hobbies: row.hobbies ?? [],
    lifestyleAttributes: row.lifestyle_attributes ?? [],
    personalityTraits: row.personality_traits ?? [],
    dietCode: row.diet_code,
    smokingCode: row.smoking_code,
    location: row.country_code
      ? {
          countryCode: row.country_code,
          regionCode: row.region_code,
          cityName: row.city_name,
          displayPrecision: (row.display_precision ?? 'city') as OwnProfile['location'] extends null
            ? never
            : 'city',
        }
      : null,
    sensitive: {
      phoneE164: sensitive?.phone_e164 ?? null,
      email: sensitive?.email ?? null,
      employerName: sensitive?.employer_name ?? null,
      workplaceCity: sensitive?.workplace_city ?? null,
    },
    reviewStatus: row.review_status as OwnProfile['reviewStatus'],
    completionScore: row.completion_score,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Weighted sections rather than "count the non-null columns".
 *
 * A raw field count tells someone to fill in their height when what actually
 * makes a profile work is a few honest sentences. The weights say what matters
 * in the order it matters.
 */
const COMPLETION_SECTIONS: Array<{
  key: string;
  weight: number;
  done: (p: OwnProfile) => boolean;
}> = [
  { key: 'identity', weight: 15, done: (p) => Boolean(p.displayName && p.dateOfBirth && p.gender) },
  { key: 'location', weight: 10, done: (p) => Boolean(p.location?.countryCode) },
  { key: 'maritalStatus', weight: 10, done: (p) => Boolean(p.maritalStatusCode) },
  { key: 'religiousPractice', weight: 15, done: (p) => Boolean(p.religiousPracticeCode) },
  {
    key: 'aboutMe',
    weight: 20,
    done: (p) => Boolean(p.aboutMe && p.aboutMe.trim().length >= MIN_ABOUT_ME_LENGTH),
  },
  { key: 'education', weight: 10, done: (p) => Boolean(p.educationLevelCode) },
  { key: 'career', weight: 10, done: (p) => Boolean(p.professionCode) },
  { key: 'languages', weight: 5, done: (p) => p.languages.length > 0 },
  { key: 'marriageTimeline', weight: 5, done: (p) => Boolean(p.marriageTimelineCode) },
];

function missingRequired(profile: OwnProfile): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_FOR_REVIEW) {
    switch (field) {
      case 'displayName':
        if (!profile.displayName) missing.push(field);
        break;
      case 'dateOfBirth':
        if (!profile.dateOfBirth) missing.push(field);
        break;
      case 'gender':
        if (!profile.gender) missing.push(field);
        break;
      case 'location':
        if (!profile.location?.countryCode) missing.push(field);
        break;
      case 'maritalStatusCode':
        if (!profile.maritalStatusCode) missing.push(field);
        break;
      case 'religiousPracticeCode':
        if (!profile.religiousPracticeCode) missing.push(field);
        break;
      case 'aboutMe':
        if (!profile.aboutMe || profile.aboutMe.trim().length < MIN_ABOUT_ME_LENGTH) {
          missing.push(field);
        }
        break;
    }
  }
  return missing;
}

function computeCompletion(profile: OwnProfile): ProfileCompletion {
  const score = COMPLETION_SECTIONS.reduce(
    (total, section) => total + (section.done(profile) ? section.weight : 0),
    0,
  );
  const missing = missingRequired(profile);

  return {
    score,
    reviewStatus: profile.reviewStatus,
    rejectionReasonKey: null,
    missingRequired: missing,
    // What to do next, most valuable first — and only what is not done.
    suggestedNext: COMPLETION_SECTIONS.filter((s) => !s.done(profile))
      .sort((a, b) => b.weight - a.weight)
      .map((s) => s.key)
      .slice(0, 3),
    // Discoverable means approved, not merely complete. Review is a separate
    // gate and the server owns it.
    isDiscoverable: profile.reviewStatus === 'approved',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Column name per patch key. Never built from request keys. */
const PROFILE_COLUMNS: Record<string, string> = {
  aboutMe: 'about_me',
  lookingFor: 'looking_for',
  nationalityCode: 'nationality_code',
  languages: 'languages',
  heightCm: 'height_cm',
  maritalStatusCode: 'marital_status_code',
  hasChildren: 'has_children',
  childrenCount: 'children_count',
  childrenLiveWithMe: 'children_live_with_me',
  marriageTimelineCode: 'marriage_timeline_code',
  relocationWillingnessCode: 'relocation_willingness_code',
  relocationTargetCountries: 'relocation_target_countries',
  educationLevelCode: 'education_level_code',
  fieldOfStudyCode: 'field_of_study_code',
  institution: 'institution',
  professionCode: 'profession_code',
  industryCode: 'industry_code',
  employmentStatusCode: 'employment_status_code',
  religiousPracticeCode: 'religious_practice_code',
  sectCode: 'sect_code',
  prayerFrequencyCode: 'prayer_frequency_code',
  quranLevelCode: 'quran_level_code',
  dressPracticeCode: 'dress_practice_code',
  familyBackground: 'family_background',
  hobbies: 'hobbies',
  lifestyleAttributes: 'lifestyle_attributes',
  personalityTraits: 'personality_traits',
  dietCode: 'diet_code',
  smokingCode: 'smoking_code',
};

const PREFERENCE_COLUMNS: Record<string, string> = {
  ageMin: 'age_min',
  ageMax: 'age_max',
  heightMinCm: 'height_min_cm',
  heightMaxCm: 'height_max_cm',
  countryCodes: 'country_codes',
  maxDistanceKm: 'max_distance_km',
  languageCodes: 'language_codes',
  educationLevelCodes: 'education_level_codes',
  professionCodes: 'profession_codes',
  religiousPracticeCodes: 'religious_practice_codes',
  sectCodes: 'sect_codes',
  excludeUnstatedSect: 'exclude_unstated_sect',
  maritalStatusCodes: 'marital_status_codes',
  acceptsChildren: 'accepts_children',
  marriageTimelineCodes: 'marriage_timeline_codes',
  relocationRequired: 'relocation_required',
};

/**
 * Ensures the profile row exists, then returns it.
 *
 * Created lazily on first read rather than during account bootstrap, so a
 * Phase 2 code path stays untouched. `on conflict do nothing` makes it safe
 * under the concurrent requests a freshly opened app produces.
 */
async function loadProfile(session: DbSession, userId: string): Promise<ProfileRow> {
  await session.query(
    `insert into public.profiles (user_id) values ($1) on conflict (user_id) do nothing`,
    [userId],
  );
  const rows = await session.query<ProfileRow>(PROFILE_SELECT);
  const row = rows[0];
  if (!row) throw notFound('No profile for this session');
  return row;
}

/**
 * Turns a validated patch into an UPDATE.
 *
 * Column names come from the fixed map above, never from request keys: the
 * schema has already stripped anything unknown, but building SQL identifiers
 * from input is not a habit worth having.
 */
function buildUpdate(
  table: string,
  columns: Record<string, string>,
  patch: Record<string, unknown>,
): { sql: string; params: unknown[] } | null {
  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      assignments.push(`${column} = $${params.length}`);
    }
  }
  if (assignments.length === 0) return null;
  return { sql: `update ${table} set ${assignments.join(', ')}`, params };
}

export interface ProfileRoutesOptions {
  db: Db;
}

export const profileRoutes: FastifyPluginAsync<ProfileRoutesOptions> = async (fastify, { db }) => {
  /** Reads the owner's own contact details. The one service-role path here. */
  const readSensitive = (userId: string): Promise<SensitiveRow | undefined> =>
    db.asService('profile.read_own_sensitive', async (session) => {
      const rows = await session.query<SensitiveRow>(
        `select phone_e164, email, employer_name, workplace_city
         from public.profile_sensitive where user_id = $1`,
        [userId],
      );
      return rows[0];
    });

  const resolveUserId = async (authUserId: string): Promise<string> =>
    db.asUser(authUserId, async (session) => {
      const rows = await session.query<{ id: string }>(`select id from public.users`);
      const id = rows[0]?.id;
      if (!id) throw notFound('No account for this session');
      return id;
    });

  // --- GET /me/profile -------------------------------------------------------

  fastify.get('/me/profile', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await resolveUserId(auth.authUserId);
    const row = await db.asUser(auth.authUserId, (session) => loadProfile(session, userId));
    return toProfile(row, await readSensitive(userId));
  });

  // --- PATCH /me/profile -----------------------------------------------------

  fastify.patch('/me/profile', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Invalid profile update',
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
      );
    }
    const patch = parsed.data as Record<string, unknown>;
    const userId = await resolveUserId(auth.authUserId);

    const row = await db.asUser(auth.authUserId, async (session) => {
      await loadProfile(session, userId);

      // Identity lives on `users`, not `profiles`. The column grants there are
      // narrow (display_name, gender, date_of_birth, country_code,
      // onboarding_step) and two triggers guard the rest: gender is immutable
      // once the profile is complete, and the age gate re-checks date_of_birth.
      const identity = buildUpdate(
        'public.users',
        { displayName: 'display_name', dateOfBirth: 'date_of_birth', gender: 'gender' },
        patch,
      );
      if (identity) await session.query(identity.sql, identity.params);

      const update = buildUpdate('public.profiles', PROFILE_COLUMNS, patch);
      if (update) {
        await session.query(update.sql, update.params);
      }

      // Location lives in its own table, and is upserted rather than patched:
      // country_code is NOT NULL, so a partial first write has nothing to
      // build on.
      const location = patch.location as Record<string, unknown> | undefined;
      if (location && Object.keys(location).length > 0) {
        if (location.countryCode) {
          await session.query(
            `insert into public.user_locations
               (user_id, country_code, region_code, city_name, display_precision)
             values ($1, $2, $3, $4, coalesce($5, 'city'))
             on conflict (user_id) do update set
               country_code = excluded.country_code,
               region_code = excluded.region_code,
               city_name = excluded.city_name,
               display_precision = excluded.display_precision`,
            [
              userId,
              location.countryCode,
              location.regionCode ?? null,
              location.cityName ?? null,
              location.displayPrecision ?? null,
            ],
          );
          // users.country_code is the identity copy and is what the
          // users_identity_complete constraint checks. Keeping the two in step
          // here means "my country" cannot mean two different things.
          await session.query(`update public.users set country_code = $1`, [location.countryCode]);
        } else {
          const locUpdate = buildUpdate(
            'public.user_locations',
            {
              regionCode: 'region_code',
              cityName: 'city_name',
              displayPrecision: 'display_precision',
            },
            location,
          );
          if (locUpdate) await session.query(locUpdate.sql, locUpdate.params);
        }
      }

      const rows = await session.query<ProfileRow>(PROFILE_SELECT);
      const updated = rows[0];
      if (!updated) throw notFound('No profile for this session');
      return updated;
    });

    const profile = toProfile(row, await readSensitive(userId));

    // Completion is recomputed on every write and stored by the server, which
    // is the only party allowed to write it.
    await db.asService('profile.update_completion', (session) =>
      session.query(`update public.profiles set completion_score = $1 where user_id = $2`, [
        computeCompletion(profile).score,
        userId,
      ]),
    );

    return { ...profile, completionScore: computeCompletion(profile).score };
  });

  // --- GET /me/profile/completion --------------------------------------------

  fastify.get('/me/profile/completion', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await resolveUserId(auth.authUserId);
    const row = await db.asUser(auth.authUserId, (session) => loadProfile(session, userId));
    const completion = computeCompletion(toProfile(row, undefined));
    return { ...completion, rejectionReasonKey: row.rejection_reason_key };
  });

  // --- POST /me/profile/submit -----------------------------------------------

  fastify.post(
    '/me/profile/submit',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const userId = await resolveUserId(auth.authUserId);
      const row = await db.asUser(auth.authUserId, (session) => loadProfile(session, userId));
      const profile = toProfile(row, undefined);
      const completion = computeCompletion(profile);

      // Already submitted. `approved` counts because the auto-approval stub
      // moves a profile straight past `pending` — keying this guard on
      // `pending` alone would let a submitted profile be resubmitted silently
      // for as long as the stub exists. Phase 8 reintroduces a real
      // resubmission path by resetting the status to `draft` on edit.
      if (profile.reviewStatus === 'pending' || profile.reviewStatus === 'approved') {
        throw conflict('This profile has already been submitted');
      }
      if (completion.missingRequired.length > 0) {
        // Named fields, so the app can send someone back to the right step
        // rather than showing a generic refusal.
        throw badRequest(
          'Profile is not complete',
          Object.fromEntries(completion.missingRequired.map((f) => [f, 'required'])),
        );
      }

      // Service role: review_status carries no column grant precisely so that a
      // member cannot set it themselves.
      //
      // Both writes share one transaction. Submitting the profile is also the
      // moment onboarding ends, and the two must land together: a profile
      // marked `pending` while `users` still says `onboarding` leaves the
      // account in a state the session gate reads as unfinished, which sends
      // the person back to step 1 after a submission that actually succeeded.
      await db.asService('profile.submit_for_review', async (session) => {
        await session.query(
          `update public.profiles
         set review_status = 'pending', submitted_at = now(), completion_score = $1
         where user_id = $2`,
          [completion.score, userId],
        );

        // `status` only ever moves FORWARD out of onboarding. A suspended or
        // banned account that resubmits must not reinstate itself, which a
        // plain `set status = 'active'` would do.
        //
        // `profile_completed_at` is coalesced rather than overwritten: gender
        // immutability keys off it (migration 0003), so resubmitting must not
        // reopen a field the database has already locked.
        await session.query(
          `update public.users
         set status = case when status = 'onboarding' then 'active' else status end,
             profile_completed_at = coalesce(profile_completed_at, now()),
             onboarding_step = null
         where id = $1`,
          [userId],
        );

        // ===================================================================
        // TEMPORARY — AUTO-APPROVAL STUB. Phase 8 deletes this block.
        //
        // Nothing else in the product can move a profile out of `pending`:
        // review is the moderation queue, which arrives in Phase 8. Until it
        // does, `pending` is a terminal state, and `app.can_view_profile()`
        // requires `approved` — so without this every profile would be
        // invisible to every other member and Discover would have nothing to
        // show. That is the same shape of bug as a gate with no writer.
        //
        // Modelled on the photo stub in routes/photos.ts, which records
        // `auto_stub` as the moderation source rather than pretending a human
        // looked. Profiles have no moderation-results table yet, so the
        // marker is this comment and the single call site.
        //
        // TO REMOVE: delete this statement. `review_status` stays `pending`,
        // the queue approves, and nothing else in the visibility chain
        // changes — `can_view_profile` already asks the right question.
        // ===================================================================
        await session.query(
          `update public.profiles
         set review_status = 'approved', reviewed_at = now()
         where user_id = $1 and review_status = 'pending'`,
          [userId],
        );
      });

      // Re-read rather than asserting a literal: with the auto-approval stub
      // in place the status at this point is 'approved', and a hardcoded
      // 'pending' would make the response disagree with the database — and
      // with `isDiscoverable`, which the client uses to explain why a profile
      // is or is not being shown. Re-reading also means deleting the stub
      // needs no change here.
      const submitted = await db.asUser(auth.authUserId, (session) => loadProfile(session, userId));

      return reply.code(202).send({
        ...completion,
        reviewStatus: submitted.review_status as OwnProfile['reviewStatus'],
        isDiscoverable: submitted.review_status === 'approved',
      });
    },
  );

  // --- GET /me/preferences ---------------------------------------------------

  const loadPreferences = async (session: DbSession, userId: string): Promise<Preferences> => {
    await session.query(
      `insert into public.partner_preferences (user_id) values ($1)
       on conflict (user_id) do nothing`,
      [userId],
    );
    const rows = await session.query<Record<string, unknown>>(
      `select age_min, age_max, height_min_cm, height_max_cm, country_codes,
              max_distance_km, language_codes, education_level_codes,
              profession_codes, religious_practice_codes, sect_codes,
              exclude_unstated_sect, marital_status_codes, accepts_children,
              marriage_timeline_codes, relocation_required
       from public.partner_preferences`,
    );
    const row = rows[0];
    if (!row) throw notFound('No preferences for this session');

    return {
      ageMin: (row.age_min as number | null) ?? null,
      ageMax: (row.age_max as number | null) ?? null,
      heightMinCm: (row.height_min_cm as number | null) ?? null,
      heightMaxCm: (row.height_max_cm as number | null) ?? null,
      countryCodes: (row.country_codes as string[]) ?? [],
      maxDistanceKm: (row.max_distance_km as number | null) ?? null,
      languageCodes: (row.language_codes as string[]) ?? [],
      educationLevelCodes: (row.education_level_codes as string[]) ?? [],
      professionCodes: (row.profession_codes as string[]) ?? [],
      religiousPracticeCodes: (row.religious_practice_codes as string[]) ?? [],
      sectCodes: (row.sect_codes as string[]) ?? [],
      excludeUnstatedSect: Boolean(row.exclude_unstated_sect),
      maritalStatusCodes: (row.marital_status_codes as string[]) ?? [],
      acceptsChildren: (row.accepts_children as boolean | null) ?? null,
      marriageTimelineCodes: (row.marriage_timeline_codes as string[]) ?? [],
      relocationRequired: (row.relocation_required as boolean | null) ?? null,
    };
  };

  fastify.get('/me/preferences', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await resolveUserId(auth.authUserId);
    return db.asUser(auth.authUserId, (session) => loadPreferences(session, userId));
  });

  // --- PUT /me/preferences ---------------------------------------------------

  fastify.put('/me/preferences', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const parsed = preferencesUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Invalid preferences',
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
      );
    }
    const patch = parsed.data as Record<string, unknown>;
    const userId = await resolveUserId(auth.authUserId);

    return db.asUser(auth.authUserId, async (session) => {
      await loadPreferences(session, userId);
      const update = buildUpdate('public.partner_preferences', PREFERENCE_COLUMNS, patch);
      if (update) await session.query(update.sql, update.params);
      return loadPreferences(session, userId);
    });
  });
};
