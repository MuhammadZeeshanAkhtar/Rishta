import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * RLS policy tests — the Phase 1 slice of the matrix in ERD §18.
 *
 * Every assertion has a negative twin. A policy suite that only proves people
 * can see their own data proves nothing: the whole risk (R6) is that someone
 * sees data that is not theirs.
 *
 * Phase 1 covers identity and reference only. `users` and `verification_status`
 * are owner-only here; the permission-resolved predicate arrives in Phase 3 with
 * the tables it depends on.
 */

let db: TestDb;
let alice: SeededUser;
let bilal: SeededUser;

/** A signed-in member who is not party to any of the fixtures. */
const STRANGER_AUTH_ID = '00000000-0000-4000-8000-0000000000ff';

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);
  alice = await seedUser(db, { displayName: 'Alice', gender: 'female' });
  bilal = await seedUser(db, { displayName: 'Bilal', gender: 'male' });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Reference data — access class `public`
// ---------------------------------------------------------------------------

describe('reference_items (public)', () => {
  it('is readable by an anonymous caller', async () => {
    const rows = await db.as('anon', null, `select code from public.reference_items`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('is readable by a signed-in member', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select code from public.reference_items`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('hides inactive items', async () => {
    await db.admin(
      `insert into public.reference_items (type, code, active) values ('hobby', 'retired_hobby', false)`,
    );
    const rows = await db.as<{ code: string }>(
      'anon',
      null,
      `select code from public.reference_items where code = 'retired_hobby'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot be written by an anonymous caller', async () => {
    await expect(
      db.as(
        'anon',
        null,
        `insert into public.reference_items (type, code) values ('hobby', 'hacked')`,
      ),
    ).rejects.toThrow();
  });

  it('cannot be written by a signed-in member', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.reference_items (type, code) values ('hobby', 'hacked')`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// users — owner-only in Phase 1
// ---------------------------------------------------------------------------

describe('users', () => {
  it('lets a member read their own row', async () => {
    const rows = await db.as<{ display_name: string }>(
      'authenticated',
      alice.authUserId,
      `select display_name from public.users`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.display_name).toBe('Alice');
  });

  it('does NOT let a member read another member', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select display_name from public.users where id = $1`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let an anonymous caller read anyone', async () => {
    // Denied at the GRANT level, before RLS is even consulted. That is stronger
    // than an empty result: anon has no business touching this table at all.
    await expect(db.as('anon', null, `select display_name from public.users`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('does NOT let a signed-in caller with no account read anyone', async () => {
    // A valid JWT whose subject has no user_auth_links row: current_user_id()
    // returns null, and `id = null` is null, which is not true.
    const rows = await db.as(
      'authenticated',
      STRANGER_AUTH_ID,
      `select display_name from public.users`,
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a member update their own display name', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.users set display_name = 'Alice Updated' returning display_name`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member update another member', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `update public.users set display_name = 'Hacked' where id = $1 returning id`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('does NOT let a member insert a users row', async () => {
    // No insert policy exists. Accounts are created by the API through the
    // service role after it has verified the JWT — otherwise a client could
    // choose its own status.
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.users (display_name, gender, date_of_birth, country_code)
         values ('Self Made', 'male', date '1990-01-01', 'pk')`,
      ),
    ).rejects.toThrow();
  });

  it('does NOT let a member delete their row', async () => {
    // Deletion is a workflow with a grace period and retention holds (E1),
    // not a DELETE statement.
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.users`),
    ).rejects.toThrow();
  });

  it('hides soft-deleted rows even from their owner', async () => {
    const ghost = await seedUser(db, { displayName: 'Ghost' });
    await db.admin(`update public.users set deleted_at = now() where id = $1`, [ghost.userId]);
    const rows = await db.as('authenticated', ghost.authUserId, `select id from public.users`);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Restricted tables — zero policies, and the absence IS the control
// ---------------------------------------------------------------------------

describe('user_auth_links (restricted)', () => {
  it('is unreadable even by the member it belongs to', async () => {
    // No GRANT and no policy. Two independent reasons this fails, which is the
    // point of a `restricted` table.
    await expect(
      db.as('authenticated', alice.authUserId, `select * from public.user_auth_links`),
    ).rejects.toThrow(/permission denied/);
  });

  it('is unreadable by an anonymous caller', async () => {
    await expect(db.as('anon', null, `select * from public.user_auth_links`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('is still reachable by app.current_user_id(), which is SECURITY DEFINER', async () => {
    // The table is unreadable, yet the resolver every policy depends on can
    // read it. That is the whole point of SECURITY DEFINER here.
    const rows = await db.as<{ uid: string }>(
      'authenticated',
      alice.authUserId,
      `select app.current_user_id() as uid`,
    );
    expect(rows[0]!.uid).toBe(alice.userId);
  });
});

describe('user_consents (restricted)', () => {
  it('is unreadable by the member it concerns', async () => {
    await db.admin(
      `insert into public.user_consents (user_id, consent_type, version, granted)
       values ($1, 'article9_religious_data', 'v1', true)`,
      [alice.userId],
    );
    await expect(
      db.as('authenticated', alice.authUserId, `select * from public.user_consents`),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot be written by a member', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.user_consents (user_id, consent_type, version, granted)
         values ($1, 'terms', 'v1', true)`,
        [alice.userId],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Owner-scoped tables
// ---------------------------------------------------------------------------

describe('user_settings (owner)', () => {
  it('lets a member read their own settings', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select * from public.user_settings`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT expose another member settings', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select * from public.user_settings where user_id = $1`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a member change their own settings', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `update public.user_settings set incognito = true returning incognito`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member change another member settings', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `update public.user_settings set incognito = true where user_id = $1 returning user_id`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('user_devices (owner)', () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.user_devices (user_id, device_id, platform) values ($1, 'dev-a', 'android')`,
      [alice.userId],
    );
  });

  it('lets a member see their own devices', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select device_id from public.user_devices`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member see another member devices', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select device_id from public.user_devices`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('verification_status', () => {
  it('lets a member read their own status', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select * from public.verification_status`,
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT let a member read another member status', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select * from public.verification_status where user_id = $1`,
      [alice.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot be written by a member — verification is not self-declared', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.verification_status set phone_verified_at = now()`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// security_events — append-only audit
// ---------------------------------------------------------------------------

describe('security_events (system, append-only)', () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.security_events (user_id, event_type) values ($1, 'sign_in')`,
      [alice.userId],
    );
  });

  it('lets a member read their own events', async () => {
    const rows = await db.as(
      'authenticated',
      alice.authUserId,
      `select event_type from public.security_events`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT let a member read another member events', async () => {
    const rows = await db.as(
      'authenticated',
      bilal.authUserId,
      `select event_type from public.security_events`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot be written by a member', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `insert into public.security_events (user_id, event_type) values ($1, 'sign_in')`,
        [alice.userId],
      ),
    ).rejects.toThrow();
  });

  it('cannot be updated by a member', async () => {
    await expect(
      db.as(
        'authenticated',
        alice.authUserId,
        `update public.security_events set event_type = 'sign_out'`,
      ),
    ).rejects.toThrow();
  });

  it('cannot be deleted by a member — an audit a client can erase is not an audit', async () => {
    await expect(
      db.as('authenticated', alice.authUserId, `delete from public.security_events`),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// service_role
// ---------------------------------------------------------------------------

describe('service_role', () => {
  it('bypasses RLS despite FORCE ROW LEVEL SECURITY', async () => {
    // BYPASSRLS outranks FORCE. Asserted rather than assumed, because every
    // server-side read depends on it behaving this way.
    const rows = await db.as('service_role', null, `select id from public.users`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('can read restricted tables', async () => {
    const rows = await db.as('service_role', null, `select * from public.user_auth_links`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
