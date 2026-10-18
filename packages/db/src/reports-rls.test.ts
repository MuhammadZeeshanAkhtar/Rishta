import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedReference, seedUser, type SeededUser, type TestDb } from './harness';

/**
 * `reports` — the policy boundary, independent of the route.
 *
 * The API refuses self-reports, invisible targets and duplicates, and that is
 * where those rules belong. This suite asks the narrower question the route
 * cannot answer for itself: if someone reached the table directly through the
 * Data API, what could they do?
 *
 * The answers that matter: the reported member can read nothing, nobody can
 * write anything, and the constraints hold without the route's help.
 */

let db: TestDb;
let reporter: SeededUser;
let reported: SeededUser;
let bystander: SeededUser;
let reportId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedReference(db);

  reporter = await seedUser(db, { displayName: 'Reporter', gender: 'female' });
  reported = await seedUser(db, { displayName: 'Reported', gender: 'male' });
  bystander = await seedUser(db, { displayName: 'Bystander', gender: 'female' });

  const rows = await db.admin<{ id: string }>(
    `insert into public.reports (reporter_user_id, reported_user_id, category, description)
     values ($1::uuid, $2::uuid, 'harassment', 'Unwanted contact.') returning id`,
    [reporter.userId, reported.userId],
  );
  reportId = rows[0]!.id;
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe('reports — the reporter reads their own, and only their own', () => {
  it('lets the reporter read their report', async () => {
    const rows = await db.as('authenticated', reporter.authUserId, `select id from public.reports`);
    expect(rows).toHaveLength(1);
  });

  it('shows the REPORTED member nothing', async () => {
    // ERD §14: "The reported party sees nothing." There is no policy that
    // could return their own row to them, and the absence is the control.
    const rows = await db.as('authenticated', reported.authUserId, `select id from public.reports`);
    expect(rows).toEqual([]);
  });

  it('shows an unrelated member nothing', async () => {
    const rows = await db.as(
      'authenticated',
      bystander.authUserId,
      `select id from public.reports`,
    );
    expect(rows).toEqual([]);
  });

  it('does not expose the table to anon at all', async () => {
    // Stronger than "returns no rows": anon holds no grant on `reports`, so
    // the Data API refuses before RLS is even consulted. anon's key ships
    // inside the app, so this is the boundary that matters most.
    await expect(
      db.as('anon', reporter.authUserId, `select id from public.reports`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot be reached by naming the row id directly', async () => {
    const rows = await db.as(
      'authenticated',
      reported.authUserId,
      `select id from public.reports where id = $1::uuid`,
      [reportId],
    );
    expect(rows).toEqual([]);
  });
});

describe('reports — no member write path of any kind', () => {
  it('refuses a member INSERT', async () => {
    // The route owns this: `status` and `outcome_key` are the moderation
    // pipeline's state, and a member who could insert could file a report
    // pre-dismissed.
    await expect(
      db.as(
        'authenticated',
        reporter.authUserId,
        `insert into public.reports (reporter_user_id, reported_user_id, category)
         values (app.current_user_id(), $1::uuid, 'scam')`,
        [reported.userId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a member UPDATE of their own report', async () => {
    // Including their own: editing a report after a moderator has triaged it
    // would rewrite the thing being reviewed.
    await expect(
      db.as(
        'authenticated',
        reporter.authUserId,
        `update public.reports set status = 'dismissed' where id = $1::uuid`,
        [reportId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a member DELETE', async () => {
    await expect(
      db.as(
        'authenticated',
        reporter.authUserId,
        `delete from public.reports where id = $1::uuid`,
        [reportId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('reports — constraints hold without the route', () => {
  it('refuses a self-report', async () => {
    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category)
         values ($1::uuid, $1::uuid, 'scam')`,
        [reporter.userId],
      ),
    ).rejects.toThrow(/reports_not_self/);
  });

  it('refuses a category outside the contract enum', async () => {
    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category)
         values ($1::uuid, $2::uuid, 'underage')`,
        [bystander.userId, reported.userId],
      ),
    ).rejects.toThrow(/reports_category_valid/);
  });

  it('refuses a status outside the contract enum', async () => {
    // Matches either constraint name: an unknown status fails
    // `reports_status_valid` AND `reports_resolved_consistent` — whose two
    // branches both require a KNOWN status — and Postgres reports whichever
    // it evaluates first. Pinning one name would make this test depend on
    // constraint evaluation order, which is not a guarantee.
    await expect(
      db.admin(`update public.reports set status = 'maybe' where id = $1::uuid`, [reportId]),
    ).rejects.toThrow(/reports_status_valid|reports_resolved_consistent/);
  });

  it('refuses a context id with no context type', async () => {
    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category, context_id)
         values ($1::uuid, $2::uuid, 'scam', gen_random_uuid())`,
        [bystander.userId, reported.userId],
      ),
    ).rejects.toThrow(/reports_context_id_needs_type/);
  });

  it('refuses a resolved status with no resolved_at', async () => {
    // A queue that can hold rows which are simultaneously open and finished
    // is a queue nobody can trust.
    await expect(
      db.admin(`update public.reports set status = 'actioned' where id = $1::uuid`, [reportId]),
    ).rejects.toThrow(/reports_resolved_consistent/);
  });

  it('refuses an over-long description', async () => {
    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category, description)
         values ($1::uuid, $2::uuid, 'scam', repeat('x', 2001))`,
        [bystander.userId, reported.userId],
      ),
    ).rejects.toThrow(/reports_description_len/);
  });

  it('allows only one OPEN report per pair', async () => {
    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category)
         values ($1::uuid, $2::uuid, 'scam')`,
        [reporter.userId, reported.userId],
      ),
    ).rejects.toThrow(/reports_one_open_per_pair/);
  });

  it('allows a fresh report once the previous one is resolved', async () => {
    const pairReporter = await seedUser(db, { displayName: 'Again', gender: 'female' });
    await db.admin(
      `insert into public.reports (reporter_user_id, reported_user_id, category)
       values ($1::uuid, $2::uuid, 'scam')`,
      [pairReporter.userId, reported.userId],
    );
    await db.admin(
      `update public.reports set status = 'dismissed', resolved_at = now()
        where reporter_user_id = $1::uuid`,
      [pairReporter.userId],
    );

    await expect(
      db.admin(
        `insert into public.reports (reporter_user_id, reported_user_id, category)
         values ($1::uuid, $2::uuid, 'harassment')`,
        [pairReporter.userId, reported.userId],
      ),
    ).resolves.toBeDefined();
  });

  it('maintains updated_at on write', async () => {
    const before = await db.admin<{ updated_at: string }>(
      `select updated_at from public.reports where id = $1::uuid`,
      [reportId],
    );
    const after = await db.admin<{ updated_at: string }>(
      `update public.reports set status = 'triaged' where id = $1::uuid returning updated_at`,
      [reportId],
    );
    expect(new Date(after[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before[0]!.updated_at).getTime(),
    );
  });
});
