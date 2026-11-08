import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DELETION_GRACE_DAYS, ENTITLEMENT_KEYS, FREE_PLAN_ENTITLEMENTS } from '@nikahmate/domain';
import { requireAuthContext } from '../auth/plugin';
import { badRequest, conflict, notFound } from '../errors';
import type { Db, DbSession } from '../db/types';
import { isoTimestamp, memberLocalDate, memberTimezone } from '../db/sql';
import { parseLimit } from '../discovery/cards';
import { loadEntitlements, valueOf } from '../entitlements/service';
import { decodeKeyset, encodeKeyset, keysetTime } from '../http/cursor';
import { uuidParam } from '../http/params';

/**
 * Account self-service — review L10 (and the parts of L7 and L8 that need no
 * external service).
 *
 * Each operation is specified in docs/openapi.yaml and backed by a table the
 * ERD designs. What is NOT here, and why, is recorded rather than faked:
 *
 *   - Deletion EXECUTION (anonymise, delete the auth identity): needs a job
 *     runner and Supabase Auth administration. Requests and cancellation are
 *     here; execution is not.
 *   - Ending a device's auth session: needs Supabase Auth administration. A
 *     revoked device is marked, its push token stops, and the event is
 *     recorded; the session itself ends when its token expires.
 *   - Push delivery and quiet-hours enforcement: L8, an external provider.
 *   - Data export: needs a job runner and a way to deliver the file (L11).
 */

export interface MeRoutesOptions {
  db: Db;
}

/** Everything `notifications_type_valid` allows — the set a preference may name. */
export const NOTIFICATION_PREFERENCE_TYPES = [
  'interest_received',
  'interest_accepted',
  'new_match',
  'new_message',
  'photo_request',
  'photo_request_answered',
  'family_invitation',
  'family_invitation_answered',
  'family_review_requested',
  'family_review_decided',
  'family_review_stalled',
  'stage_advance_proposed',
  'verification_update',
  'security_alert',
  'report_update',
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const notificationPreferencesSchema = z
  .object({
    quietHoursStart: z.string().regex(HHMM).nullable(),
    quietHoursEnd: z.string().regex(HHMM).nullable(),
    types: z
      .array(
        z.object({
          type: z.enum(NOTIFICATION_PREFERENCE_TYPES),
          push: z.boolean(),
          inApp: z.boolean(),
        }),
      )
      .max(NOTIFICATION_PREFERENCE_TYPES.length),
  })
  .refine((v) => (v.quietHoursStart === null) === (v.quietHoursEnd === null), {
    message: 'Quiet hours need both a start and an end, or neither',
    path: ['quietHoursEnd'],
  })
  .refine((v) => v.types.every((t) => t.type !== 'security_alert' || t.inApp), {
    message: 'Security alerts cannot be turned off in-app',
    path: ['types'],
  })
  .refine((v) => new Set(v.types.map((t) => t.type)).size === v.types.length, {
    message: 'Each type may appear once',
    path: ['types'],
  });

const pushTokenSchema = z.object({
  deviceId: z.string().trim().min(1).max(200),
  token: z.string().min(8).max(4096),
  platform: z.enum(['android', 'ios']),
});

const fieldsOf = (issues: z.ZodError['issues']) =>
  Object.fromEntries(issues.map((i) => [i.path.join('.') || '(root)', i.message]));

const resolveViewer = async (session: DbSession): Promise<string | null> => {
  const rows = await session.query<{ id: string | null }>(`select app.current_user_id() as id`);
  return rows[0]?.id ?? null;
};

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (fastify, opts) => {
  const { db } = opts;

  const viewerOf = async (authUserId: string): Promise<string> => {
    const id = await db.asUser(authUserId, resolveViewer);
    if (!id) throw notFound('No account for this session');
    return id;
  };

  // ===========================================================================
  // Entitlements, quotas, usage, verification
  // ===========================================================================

  fastify.get('/me/entitlements', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    // Owner-select under RLS: the policy confines this to the caller.
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<{
        entitlement_key: string;
        value: unknown;
        source: string;
        expires_at: string | null;
      }>(
        `select entitlement_key, value, source,
                ${isoTimestamp('expires_at')} as expires_at
           from public.user_entitlements
          where user_id = app.current_user_id()
            and (expires_at is null or expires_at > now())`,
      ),
    );
    const overrides = new Map(rows.map((r) => [r.entitlement_key, r]));
    return {
      // No plans exist yet (billing is a company decision, v1.2); everyone is
      // on the free plan with per-member grants layered over it.
      planKey: 'free',
      items: ENTITLEMENT_KEYS.map((key) => {
        const row = overrides.get(key);
        const usable = row && (typeof row.value === 'boolean' || typeof row.value === 'number');
        return usable
          ? { key, value: row.value, source: row.source, expiresAt: row.expires_at }
          : { key, value: FREE_PLAN_ENTITLEMENTS[key], source: 'plan', expiresAt: null };
      }),
    };
  });

  const dailyInterestQuota = async (authUserId: string, userId: string) => {
    const entitlements = await loadEntitlements(db, authUserId, userId);
    const limit = Number(valueOf(entitlements, 'daily_interests'));
    const rows = await db.asUser(authUserId, (session) =>
      session.query<{ used: number; resets_at: string }>(
        // The same day the send path counts under (memberLocalDate, review
        // B23), and the next local midnight as an instant.
        `select coalesce(
                  (select c.count from public.usage_counters c
                    where c.user_id = $1::uuid and c.counter_key = 'daily_interests'
                      and c.period_start = ${memberLocalDate('$1::uuid')}),
                  0)::int as used,
                ${isoTimestamp(
                  `((${memberLocalDate('$1::uuid')} + 1)::timestamp at time zone ${memberTimezone('$1::uuid')})`,
                )} as resets_at`,
        [userId],
      ),
    );
    const used = rows[0]?.used ?? 0;
    return {
      key: 'daily_interests',
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetsAt: rows[0]?.resets_at ?? null,
    };
  };

  // Remaining allowances. One daily counter exists today (A5).
  fastify.get('/me/quotas', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await viewerOf(auth.authUserId);
    return { items: [await dailyInterestQuota(auth.authUserId, userId)] };
  });

  // Counters against limits. The same single counter, read as usage; a second
  // counter added later appears here without a contract change.
  fastify.get('/me/usage', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await viewerOf(auth.authUserId);
    return { items: [await dailyInterestQuota(auth.authUserId, userId)] };
  });

  fastify.get('/me/verification', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<{
        email: boolean;
        phone: boolean;
        selfie: boolean;
        id: boolean;
        reviewed: boolean;
      }>(
        // Booleans only — when a check happened is not exposed (review B20).
        `select email_verified_at is not null as email,
                phone_verified_at is not null as phone,
                selfie_verified_at is not null as selfie,
                id_verified_at is not null as id,
                profile_reviewed_at is not null as reviewed
           from public.verification_status where user_id = app.current_user_id()`,
      ),
    );
    const r = rows[0];
    return {
      emailVerified: r?.email ?? false,
      phoneVerified: r?.phone ?? false,
      selfieVerified: r?.selfie ?? false,
      idVerified: r?.id ?? false,
      profileReviewed: r?.reviewed ?? false,
    };
  });

  // ===========================================================================
  // Security events and devices
  // ===========================================================================

  fastify.get('/me/security-events', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const after = decodeKeyset(query.cursor);
    if (query.cursor !== undefined && after === null) throw badRequest('Invalid cursor');

    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<{
        id: string;
        event_type: string;
        created_at: string;
        approximate_country: string | null;
        cursor_at: string;
      }>(
        `select id, event_type, ${isoTimestamp('created_at')} as created_at,
                approximate_country, ${keysetTime('created_at')} as cursor_at
           from public.security_events
          where user_id = app.current_user_id()
            and ($1::timestamptz is null or (created_at, id) < ($1::timestamptz, $2::uuid))
          order by created_at desc, id desc
          limit ${limit + 1}`,
        [after?.at ?? null, after?.id ?? null],
      ),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        createdAt: r.created_at,
        // Country-level only; never an IP or a city.
        approximateLocation: r.approximate_country?.trim().toUpperCase() ?? null,
      })),
      nextCursor: hasMore && last ? encodeKeyset({ at: last.cursor_at, id: last.id }) : null,
      hasMore,
    };
  });

  fastify.get('/me/devices', { preHandler: fastify.requireAuth }, async (request) => {
    const auth = requireAuthContext(request);
    // The app identifies itself with the same id it registered at bootstrap.
    // Without the header, no device is marked current.
    const current = request.headers['x-device-id'];
    const rows = await db.asUser(auth.authUserId, (session) =>
      session.query<{
        id: string;
        device_id: string;
        platform: string;
        app_version: string | null;
        last_seen_at: string;
      }>(
        `select id, device_id, platform, app_version, ${isoTimestamp('last_seen_at')} as last_seen_at
           from public.user_devices
          where user_id = app.current_user_id() and revoked_at is null
          order by last_seen_at desc, id`,
      ),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        appVersion: r.app_version,
        lastSeenAt: r.last_seen_at,
        isCurrent: typeof current === 'string' && current === r.device_id,
      })),
    };
  });

  fastify.delete(
    '/me/devices/:deviceId',
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const id = uuidParam(request, 'deviceId', 'device id');
      const userId = await viewerOf(auth.authUserId);

      // Revocation is a member capability (0003): one direction, once.
      const revoked = await db.asUser(auth.authUserId, (session) =>
        session.query<{ device_id: string }>(
          `update public.user_devices set revoked_at = now()
            where id = $1::uuid and user_id = app.current_user_id() and revoked_at is null
            returning device_id`,
          [id],
        ),
      );
      if (!revoked[0]) throw notFound('No such device');

      // The device stops receiving pushes, and the account records it.
      await db.asService('notifications.push_tokens', (session) =>
        session.query(
          `update public.push_tokens set invalidated_at = now(), updated_at = now()
            where user_id = $1::uuid and device_id = $2 and invalidated_at is null`,
          [userId, revoked[0]!.device_id],
        ),
      );
      await db.asService('security.record_event', (session) =>
        session.query(
          `insert into public.security_events (user_id, event_type, metadata)
           values ($1::uuid, 'device_revoked', $2::jsonb)`,
          [userId, JSON.stringify({ deviceRecordId: id })],
        ),
      );
      return reply.code(204).send();
    },
  );

  // ===========================================================================
  // Deactivate, reactivate, delete
  // ===========================================================================

  /**
   * Hide the profile without deleting anything. `can_view_profile` requires
   * `active`, so a deactivated member disappears from discovery, cards and
   * profiles at once. Only an ACTIVE account can deactivate, and only a
   * DEACTIVATED one can reactivate: a suspended or banned member must not be
   * able to pass through `deactivated` to lift their own restriction.
   */
  fastify.post(
    '/me/deactivate',
    { preHandler: fastify.requireIdentity },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const userId = await viewerOf(auth.authUserId);
      const status = await db.asService('account.lifecycle', async (session) => {
        const rows = await session.query<{ status: string }>(
          `select status from public.users where id = $1::uuid for update`,
          [userId],
        );
        const current = rows[0]?.status;
        if (current === 'active') {
          await session.query(
            `update public.users set status = 'deactivated' where id = $1::uuid`,
            [userId],
          );
          return 'deactivated';
        }
        return current ?? null;
      });
      if (status !== 'deactivated') throw conflict('Only an active account can be deactivated');
      return reply.code(204).send();
    },
  );

  fastify.post(
    '/me/reactivate',
    { preHandler: fastify.requireIdentity },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const userId = await viewerOf(auth.authUserId);
      const status = await db.asService('account.lifecycle', async (session) => {
        const rows = await session.query<{ status: string }>(
          `select status from public.users where id = $1::uuid for update`,
          [userId],
        );
        const current = rows[0]?.status;
        if (current === 'deactivated') {
          await session.query(`update public.users set status = 'active' where id = $1::uuid`, [
            userId,
          ]);
          return 'active';
        }
        return current ?? null;
      });
      if (status !== 'active') throw conflict('Only a deactivated account can be reactivated');
      return reply.code(204).send();
    },
  );

  /**
   * Request erasure (ERD E1). A 30-day grace period, during which the account
   * is hidden (`pending_deletion`) and the request can be cancelled. An open
   * safety matter places a hold (R4): open reports about the member, or an
   * active suspension or ban. The response says so in general terms only.
   */
  fastify.post('/me/delete', { preHandler: fastify.requireIdentity }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const userId = await viewerOf(auth.authUserId);

    const created = await db.asService('account.lifecycle', async (session) => {
      const users = await session.query<{ status: string }>(
        `select status from public.users where id = $1::uuid and deleted_at is null for update`,
        [userId],
      );
      const previous = users[0]?.status;
      if (!previous) throw notFound('No account for this session');
      if (previous === 'pending_deletion') throw conflict('A deletion request is already open');

      const open = await session.query<{ id: string }>(
        `select id from public.account_deletion_requests
          where user_id = $1::uuid and status in ('pending', 'held')`,
        [userId],
      );
      if (open.length > 0) throw conflict('A deletion request is already open');

      const cases = await session.query<{ open: boolean }>(
        `select exists (
           select 1 from public.reports r
            where r.reported_user_id = $1::uuid and r.status in ('open', 'triaged')
         ) as open`,
        [userId],
      );
      const held = (cases[0]?.open ?? false) || previous === 'suspended' || previous === 'banned';

      const rows = await session.query<{
        requested_at: string;
        scheduled_for: string;
        status: string;
        retention_hold_reason: string | null;
      }>(
        `insert into public.account_deletion_requests
           (user_id, scheduled_for, status, retention_hold_reason, previous_status)
         values ($1::uuid, now() + make_interval(days => $2::int), $3, $4, $5)
         returning ${isoTimestamp('requested_at')} as requested_at,
                   ${isoTimestamp('scheduled_for')} as scheduled_for,
                   status, retention_hold_reason`,
        [
          userId,
          DELETION_GRACE_DAYS,
          held ? 'held' : 'pending',
          held ? 'A safety review on this account must finish before it can be deleted.' : null,
          previous,
        ],
      );
      await session.query(
        `update public.users set status = 'pending_deletion' where id = $1::uuid`,
        [userId],
      );
      return rows[0]!;
    });

    return reply.code(202).send({
      requestedAt: created.requested_at,
      scheduledFor: created.scheduled_for,
      status: created.status,
      heldReason: created.retention_hold_reason,
    });
  });

  /**
   * The open request, so a member who restarts the app still sees when their account is
   * due to be deleted, or why it is held. 404 when none is open.
   */
  fastify.get('/me/delete', { preHandler: fastify.requireIdentity }, async (request) => {
    const auth = requireAuthContext(request);
    const userId = await viewerOf(auth.authUserId);
    const rows = await db.asService('account.lifecycle', (session) =>
      session.query<{
        requested_at: string;
        scheduled_for: string;
        status: string;
        retention_hold_reason: string | null;
      }>(
        `select ${isoTimestamp('requested_at')} as requested_at,
                ${isoTimestamp('scheduled_for')} as scheduled_for,
                status, retention_hold_reason
           from public.account_deletion_requests
          where user_id = $1::uuid and status in ('pending', 'held')`,
        [userId],
      ),
    );
    const open = rows[0];
    if (!open) throw notFound('No deletion request is open');
    return {
      requestedAt: open.requested_at,
      scheduledFor: open.scheduled_for,
      status: open.status,
      heldReason: open.retention_hold_reason,
    };
  });

  fastify.delete('/me/delete', { preHandler: fastify.requireIdentity }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const userId = await viewerOf(auth.authUserId);
    const cancelled = await db.asService('account.lifecycle', async (session) => {
      const rows = await session.query<{ previous_status: string }>(
        `update public.account_deletion_requests
            set status = 'cancelled', cancelled_at = now(), retention_hold_reason = null
          where user_id = $1::uuid and status in ('pending', 'held')
          returning previous_status`,
        [userId],
      );
      if (!rows[0]) return false;
      // Back to exactly what it was — never to `active` by default.
      await session.query(
        `update public.users set status = $2 where id = $1::uuid and status = 'pending_deletion'`,
        [userId, rows[0].previous_status],
      );
      return true;
    });
    if (!cancelled) throw notFound('No deletion request is open');
    return reply.code(204).send();
  });

  // ===========================================================================
  // Notification preferences and push tokens
  // ===========================================================================

  const readPreferences = async (authUserId: string) => {
    const rows = await db.asUser(authUserId, (session) =>
      session.query<{
        type: string;
        push_enabled: boolean;
        inapp_enabled: boolean;
        start: string | null;
        end: string | null;
      }>(
        `select type, push_enabled, inapp_enabled,
                to_char(quiet_hours_start, 'HH24:MI') as start,
                to_char(quiet_hours_end, 'HH24:MI') as "end"
           from public.notification_preferences
          where user_id = app.current_user_id()`,
      ),
    );
    const byType = new Map(rows.map((r) => [r.type, r]));
    return {
      quietHoursStart: rows[0]?.start ?? null,
      quietHoursEnd: rows[0]?.end ?? null,
      types: NOTIFICATION_PREFERENCE_TYPES.map((type) => ({
        type,
        push: byType.get(type)?.push_enabled ?? true,
        inApp: byType.get(type)?.inapp_enabled ?? true,
      })),
    };
  };

  fastify.get(
    '/me/notification-preferences',
    { preHandler: fastify.requireAuth },
    async (request) => readPreferences(requireAuthContext(request).authUserId),
  );

  /**
   * Replace the whole set. Types not sent take the default (on). In-app OFF
   * is enforced for every sender by the 0030 trigger on `notifications`; push
   * and quiet hours are stored for delivery, which does not exist yet (L8).
   */
  fastify.put(
    '/me/notification-preferences',
    { preHandler: fastify.requireAuth },
    async (request) => {
      const auth = requireAuthContext(request);
      const parsed = notificationPreferencesSchema.safeParse(request.body);
      if (!parsed.success)
        throw badRequest('Invalid notification preferences', fieldsOf(parsed.error.issues));
      const body = parsed.data;
      const given = new Map(body.types.map((t) => [t.type, t]));

      await db.asUser(auth.authUserId, async (session) => {
        await session.query(
          `delete from public.notification_preferences where user_id = app.current_user_id()`,
        );
        for (const type of NOTIFICATION_PREFERENCE_TYPES) {
          const t = given.get(type);
          await session.query(
            `insert into public.notification_preferences
               (user_id, type, push_enabled, inapp_enabled, quiet_hours_start, quiet_hours_end)
             values (app.current_user_id(), $1, $2, $3, $4::time, $5::time)`,
            [type, t?.push ?? true, t?.inApp ?? true, body.quietHoursStart, body.quietHoursEnd],
          );
        }
      });
      return readPreferences(auth.authUserId);
    },
  );

  fastify.post('/me/push-tokens', { preHandler: fastify.requireAuth }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const parsed = pushTokenSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid push token', fieldsOf(parsed.error.issues));
    const userId = await viewerOf(auth.authUserId);
    // RESTRICTED table (ERD §15): a token is a capability to reach a device.
    await db.asService('notifications.push_tokens', (session) =>
      session.query(
        `insert into public.push_tokens (user_id, device_id, token, platform)
         values ($1::uuid, $2, $3, $4)
         on conflict (user_id, device_id) do update
           set token = excluded.token, platform = excluded.platform,
               invalidated_at = null, updated_at = now()`,
        [userId, parsed.data.deviceId, parsed.data.token, parsed.data.platform],
      ),
    );
    return reply.code(204).send();
  });

  fastify.delete(
    '/me/push-tokens/:deviceId',
    { preHandler: fastify.requireIdentity },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const deviceId = String((request.params as { deviceId?: string }).deviceId ?? '');
      if (deviceId.length === 0 || deviceId.length > 200) throw badRequest('Invalid device id');
      const userId = await viewerOf(auth.authUserId);
      // Idempotent: unregistering something not registered is the state asked for.
      await db.asService('notifications.push_tokens', (session) =>
        session.query(
          `update public.push_tokens set invalidated_at = now(), updated_at = now()
            where user_id = $1::uuid and device_id = $2 and invalidated_at is null`,
          [userId, deviceId],
        ),
      );
      return reply.code(204).send();
    },
  );
};
