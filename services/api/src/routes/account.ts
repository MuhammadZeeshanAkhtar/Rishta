import type { FastifyPluginAsync } from 'fastify';
import { bootstrapRequestSchema, userSettingsUpdateSchema, type Me } from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, notFound } from '../errors';
import type { Db, DbSession } from '../db/types';

/**
 * Account routes: bootstrap, read and update.
 *
 * Mirrors the Account section of docs/openapi.yaml.
 */

interface MeRow {
  id: string;
  display_name: string | null;
  status: Me['status'];
  onboarding_step: string | null;
  profile_completed_at: string | null;
  locale: string;
  timezone: string;
  show_online_status: boolean;
  send_read_receipts: boolean;
  incognito: boolean;
  discovery_paused: boolean;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  selfie_verified_at: string | null;
  id_verified_at: string | null;
  profile_reviewed_at: string | null;
}

const ME_SELECT = `
  select u.id, u.display_name, u.status, u.onboarding_step, u.profile_completed_at,
         s.locale, s.timezone, s.show_online_status, s.send_read_receipts,
         s.incognito, s.discovery_paused,
         v.email_verified_at, v.phone_verified_at, v.selfie_verified_at,
         v.id_verified_at, v.profile_reviewed_at
  from public.users u
  join public.user_settings s on s.user_id = u.id
  join public.verification_status v on v.user_id = u.id
`;

function toMe(row: MeRow): Me {
  return {
    userId: row.id,
    displayName: row.display_name,
    status: row.status,
    onboardingStep: row.onboarding_step,
    profileCompleted: row.profile_completed_at !== null,
    locale: row.locale,
    timezone: row.timezone,
    showOnlineStatus: row.show_online_status,
    sendReadReceipts: row.send_read_receipts,
    incognito: row.incognito,
    discoveryPaused: row.discovery_paused,
    verification: {
      emailVerified: row.email_verified_at !== null,
      phoneVerified: row.phone_verified_at !== null,
      // Exposed as booleans only. The timestamps, and the artefacts behind
      // them, never leave the server.
      selfieVerified: row.selfie_verified_at !== null,
      idVerified: row.id_verified_at !== null,
      profileReviewed: row.profile_reviewed_at !== null,
    },
  };
}

async function loadMe(session: DbSession, userId: string): Promise<Me | null> {
  const rows = await session.query<MeRow>(`${ME_SELECT} where u.id = $1`, [userId]);
  const row = rows[0];
  return row ? toMe(row) : null;
}

export interface AccountRoutesOptions {
  db: Db;
}

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (fastify, { db }) => {
  /**
   * POST /account/bootstrap
   *
   * Idempotent. Runs as service_role because `users` has no INSERT policy by
   * design: a client able to insert its own row could choose its own status.
   * The JWT has already been verified at this point, so the subject is trusted;
   * nothing from the request body identifies the account.
   */
  fastify.post(
    '/account/bootstrap',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const parsed = bootstrapRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(
          'Invalid bootstrap request',
          Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
          ),
        );
      }
      const body = parsed.data;

      const result = await db.asService('account.bootstrap', async (session) => {
        const existing = await session.query<{ user_id: string }>(
          `select user_id from public.user_auth_links where auth_user_id = $1`,
          [auth.authUserId],
        );

        if (existing[0]) {
          const me = await loadMe(session, existing[0].user_id);
          if (!me) {
            // An auth link with no account behind it means a half-finished
            // bootstrap. Surfacing it is better than silently repairing it.
            throw notFound('Account record is incomplete');
          }
          return { me, created: false };
        }

        const inserted = await session.query<{ id: string }>(
          `insert into public.users (status) values ('onboarding') returning id`,
        );
        const userId = inserted[0]!.id;

        await session.query(
          `insert into public.user_auth_links (user_id, auth_user_id, provider)
           values ($1, $2, $3)`,
          [userId, auth.authUserId, auth.email ? 'email' : 'phone'],
        );

        await session.query(
          `insert into public.user_settings (user_id, locale, timezone) values ($1, $2, $3)`,
          [userId, body.locale, body.timezone],
        );

        await session.query(`insert into public.verification_status (user_id) values ($1)`, [
          userId,
        ]);

        if (body.deviceId && body.platform) {
          await session.query(
            `insert into public.user_devices (user_id, device_id, platform)
             values ($1, $2, $3)
             on conflict (user_id, device_id) do update set last_seen_at = now()`,
            [userId, body.deviceId, body.platform],
          );
        }

        const me = await loadMe(session, userId);
        if (!me) throw notFound('Account record is incomplete');
        return { me, created: true };
      });

      return reply.code(result.created ? 201 : 200).send(result.me);
    },
  );

  /**
   * GET /me
   *
   * Runs as the caller, so RLS is the thing deciding what comes back. A bug in
   * this handler cannot widen it.
   */
  fastify.get('/me', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const me = await db.asUser(auth.authUserId, async (session) => {
      const rows = await session.query<MeRow>(ME_SELECT);
      const row = rows[0];
      return row ? toMe(row) : null;
    });

    if (!me) {
      // Valid token, no account. The client should call bootstrap.
      throw notFound('No account for this session. Call /account/bootstrap first.');
    }
    return me;
  });

  /** PATCH /me — locale, timezone and display settings. */
  fastify.patch('/me', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);

    const parsed = userSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Invalid settings update',
        Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || '(root)', i.message]),
        ),
      );
    }
    const patch = parsed.data;

    if (Object.keys(patch).length === 0) {
      throw badRequest('No settings supplied');
    }

    return db.asUser(auth.authUserId, async (session) => {
      // Column names come from a fixed map, never from request keys — the
      // schema has already stripped anything unknown, but building SQL
      // identifiers from input is not a habit worth having.
      const columns: Record<keyof typeof patch, string> = {
        locale: 'locale',
        timezone: 'timezone',
        showOnlineStatus: 'show_online_status',
        sendReadReceipts: 'send_read_receipts',
        incognito: 'incognito',
        discoveryPaused: 'discovery_paused',
      };

      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = patch[key as keyof typeof patch];
        if (value !== undefined) {
          params.push(value);
          assignments.push(`${column} = $${params.length}`);
        }
      }

      const updated = await session.query(
        `update public.user_settings set ${assignments.join(', ')} returning user_id`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params as any[],
      );

      if (updated.length === 0) {
        throw notFound('No account for this session');
      }

      const rows = await session.query<MeRow>(ME_SELECT);
      const row = rows[0];
      if (!row) throw notFound('No account for this session');
      return toMe(row);
    });
  });
};
