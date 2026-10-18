import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createHarness, randomAuthId, type TestHarness } from './helpers';

/**
 * The production generation path.
 *
 * THIS FILE DELIBERATELY DOES NOT IMPORT `generateCandidates`.
 *
 * That is the entire point. `generateCandidates()` was written in Phase 5,
 * is correct, and is covered by 35 tests in candidates.test.ts — every one of
 * which calls it directly. So did discovery.test.ts. The result was a function
 * with no production call site at all: `match_candidates` was never populated
 * outside a test, and a real member's Discover feed was permanently empty
 * while the suite stayed green.
 *
 * A test that calls the generator before asserting on the feed proves the
 * generator works. It cannot prove the application ever calls it. These tests
 * go through `harness.app.inject()` and nothing else, so the only thing that
 * can populate a feed here is the route itself.
 */

let harness: TestHarness;
let seq = 0;

interface Member {
  userId: string;
  authId: string;
}

async function seedMember(gender: 'male' | 'female'): Promise<Member> {
  seq += 1;
  const authId = randomAuthId();
  const rows = await harness.raw.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1::text, $2::text, date '1995-06-15', 'pk', 'active') returning id`,
    [`Member ${seq}`, gender],
  );
  const userId = rows.rows[0]!.id;
  await harness.raw.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authId],
  );
  await harness.raw.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await harness.raw.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);
  await harness.raw.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, 'A sufficiently long about-me for this member.',
             'ms_never_married', 'rel_practising', 'approved')`,
    [userId],
  );
  await harness.raw.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );
  return { userId, authId };
}

const feed = (member: Member, query = '') =>
  harness.app.inject({
    method: 'GET',
    url: `/discovery/sections/recommended${query}`,
    headers: authHeader(member.authId),
  });

const sections = (member: Member) =>
  harness.app.inject({
    method: 'GET',
    url: '/discovery/sections',
    headers: authHeader(member.authId),
  });

const candidateCount = async (userId: string): Promise<number> => {
  const rows = await harness.raw.query<{ n: string }>(
    `select count(*)::text as n from public.match_candidates where user_id = $1::uuid`,
    [userId],
  );
  return Number.parseInt(rows.rows[0]!.n, 10);
};

const runRow = async (userId: string) => {
  const rows = await harness.raw.query<{
    started_at: Date;
    finished_at: Date | null;
    batch_id: string | null;
    candidates: number | null;
  }>(
    `select started_at, finished_at, batch_id, candidates
       from public.discovery_generation_runs
      where user_id = $1::uuid and section_key = 'recommended'`,
    [userId],
  );
  return rows.rows[0] ?? null;
};

beforeAll(async () => {
  harness = await createHarness();
  await harness.raw.exec(`
    insert into public.reference_items (type, code) values
      ('marital_status', 'ms_never_married'),
      ('religious_practice', 'rel_practising')
    on conflict (type, code) do nothing;
  `);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------
// The defect this phase exists to fix
// ---------------------------------------------------------------------------

describe('a real Discover request generates its own candidates', () => {
  it('returns a non-empty feed without any test calling the generator', async () => {
    // THE REGRESSION TEST. Before Phase 7a this returned an empty list, and
    // every existing discovery test passed anyway because each one called
    // generateCandidates() in its own setup.
    const viewer = await seedMember('male');
    await seedMember('female');
    await seedMember('female');

    expect(await candidateCount(viewer.userId)).toBe(0);

    const response = await feed(viewer);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ userId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(await candidateCount(viewer.userId)).toBeGreaterThan(0);
  });

  it('persists compatibility scores reachable through the API', async () => {
    const viewer = await seedMember('male');
    const target = await seedMember('female');

    await feed(viewer);

    const score = await harness.app.inject({
      method: 'GET',
      url: `/compatibility/${target.userId}`,
      headers: authHeader(viewer.authId),
    });
    expect(score.statusCode).toBe(200);
    expect(typeof score.json().overall).toBe('number');
  });

  it('scores belong to the viewer who generated them', async () => {
    // `app.owns_compatibility_score` scopes rows to viewer_user_id; this
    // confirms generation writes them under the right owner.
    const viewer = await seedMember('male');
    const target = await seedMember('female');
    await feed(viewer);

    const rows = await harness.raw.query<{ viewer_user_id: string }>(
      `select viewer_user_id from public.compatibility_scores where candidate_user_id = $1::uuid`,
      [target.userId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.viewer_user_id).toBe(viewer.userId);
  });

  it('also generates from the sections summary endpoint', async () => {
    const viewer = await seedMember('female');
    await seedMember('male');

    expect(await candidateCount(viewer.userId)).toBe(0);
    expect((await sections(viewer)).statusCode).toBe(200);
    expect(await candidateCount(viewer.userId)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The claim: cooldown, concurrency, empty results, stale reclaim
// ---------------------------------------------------------------------------

describe('generation is claimed, not repeated', () => {
  it('records a finished run', async () => {
    const viewer = await seedMember('male');
    await seedMember('female');
    await feed(viewer);

    const run = await runRow(viewer.userId);
    expect(run).not.toBeNull();
    expect(run!.finished_at).not.toBeNull();
    expect(run!.batch_id).not.toBeNull();
    expect(run!.candidates).toBeGreaterThan(0);
  });

  it('does not regenerate within the cooldown', async () => {
    const viewer = await seedMember('male');
    await seedMember('female');

    await feed(viewer);
    const first = await runRow(viewer.userId);

    await feed(viewer);
    await feed(viewer);
    const after = await runRow(viewer.userId);

    // Same batch, same start: the later reads served the existing feed.
    expect(after!.batch_id).toBe(first!.batch_id);
    expect(after!.started_at).toEqual(first!.started_at);
  });

  it('records a run even when nobody is eligible, so the empty case cools down too', async () => {
    // The subtle half. A cooldown read from match_candidates is useless here —
    // there are no rows to carry a timestamp — so without this row the member
    // with no matches would regenerate on every single feed open.
    const lonely = await seedMember('male');

    // Genuinely isolated. The harness database is shared across this file, so
    // earlier members are still present — blocking them all is the cheapest
    // way to produce a real zero-eligible viewer rather than a nominal one.
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id)
       select $1::uuid, u.id from public.users u where u.id <> $1::uuid
       on conflict (blocker_user_id, blocked_user_id) do nothing`,
      [lonely.userId],
    );

    const response = await feed(lonely);
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);

    const run = await runRow(lonely.userId);
    expect(run).not.toBeNull();
    expect(run!.finished_at).not.toBeNull();
    expect(run!.candidates).toBe(0);
  });

  it('generates once when several requests arrive together', async () => {
    const viewer = await seedMember('male');
    await seedMember('female');
    await seedMember('female');

    const responses = await Promise.all([feed(viewer), feed(viewer), feed(viewer), feed(viewer)]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    // One row, one batch. The conditional UPDATE is the race control.
    const rows = await harness.raw.query<{ n: string }>(
      `select count(*)::text as n from public.discovery_generation_runs
        where user_id = $1::uuid`,
      [viewer.userId],
    );
    expect(rows.rows[0]!.n).toBe('1');

    const batches = await harness.raw.query<{ n: string }>(
      `select count(distinct batch_id)::text as n from public.match_candidates
        where user_id = $1::uuid`,
      [viewer.userId],
    );
    expect(Number.parseInt(batches.rows[0]!.n, 10)).toBeLessThanOrEqual(1);
  });

  it('reclaims a run abandoned mid-flight', async () => {
    // No sweeper exists, so an abandoned claim must be reclaimable on read or
    // it would freeze this member's feed permanently.
    const viewer = await seedMember('male');
    await seedMember('female');

    await harness.raw.query(
      `insert into public.discovery_generation_runs (user_id, section_key, started_at, finished_at)
       values ($1::uuid, 'recommended', now() - interval '10 minutes', null)`,
      [viewer.userId],
    );

    const response = await feed(viewer);
    expect(response.statusCode).toBe(200);
    expect((response.json().items as unknown[]).length).toBeGreaterThan(0);

    const run = await runRow(viewer.userId);
    expect(run!.finished_at).not.toBeNull();
  });

  it('regenerates once the cooldown has expired', async () => {
    const viewer = await seedMember('male');
    await seedMember('female');
    await feed(viewer);
    const first = await runRow(viewer.userId);

    await harness.raw.query(
      `update public.discovery_generation_runs
          set started_at = now() - interval '30 minutes',
              finished_at = now() - interval '30 minutes'
        where user_id = $1::uuid`,
      [viewer.userId],
    );

    await feed(viewer);
    const second = await runRow(viewer.userId);
    expect(new Date(second!.started_at).getTime()).toBeGreaterThan(
      new Date(first!.started_at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// Safety guarantees must survive the new trigger
// ---------------------------------------------------------------------------

describe('generation does not weaken existing rules', () => {
  it('excludes a blocked member in both directions', async () => {
    const alice = await seedMember('female');
    const bilal = await seedMember('male');
    await harness.raw.query(
      `insert into public.blocks (blocker_user_id, blocked_user_id) values ($1::uuid, $2::uuid)`,
      [alice.userId, bilal.userId],
    );

    for (const [viewer, hidden] of [
      [alice, bilal],
      [bilal, alice],
    ] as const) {
      const ids = ((await feed(viewer)).json().items as Array<{ userId: string }>).map(
        (i) => i.userId,
      );
      expect(ids, viewer.userId).not.toContain(hidden.userId);
    }
  });

  it('excludes an unapproved profile', async () => {
    const viewer = await seedMember('male');
    const pending = await seedMember('female');
    await harness.raw.query(
      `update public.profiles set review_status = 'draft' where user_id = $1::uuid`,
      [pending.userId],
    );

    const ids = ((await feed(viewer)).json().items as Array<{ userId: string }>).map(
      (i) => i.userId,
    );
    expect(ids).not.toContain(pending.userId);
  });

  it('never returns the viewer to themselves', async () => {
    const viewer = await seedMember('male');
    await seedMember('female');
    const ids = ((await feed(viewer)).json().items as Array<{ userId: string }>).map(
      (i) => i.userId,
    );
    expect(ids).not.toContain(viewer.userId);
  });

  it('refuses an anonymous request and generates nothing', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/discovery/sections/recommended',
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps pagination stable — no generation while paging', async () => {
    // The frozen-batch guarantee the cursor depends on. Generating on page two
    // would swap the batch underneath the reader.
    const viewer = await seedMember('male');
    for (let i = 0; i < 4; i += 1) await seedMember('female');

    const first = await feed(viewer, '?limit=2');
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    const runAfterFirst = await runRow(viewer.userId);

    if (firstBody.hasMore && firstBody.nextCursor) {
      const second = await feed(viewer, `?limit=2&cursor=${firstBody.nextCursor}`);
      expect(second.statusCode).toBe(200);
      const secondIds = (second.json().items as Array<{ userId: string }>).map((i) => i.userId);
      const firstIds = firstBody.items.map((i) => i.userId);
      // No repeats across pages.
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    }

    const runAfterSecond = await runRow(viewer.userId);
    expect(runAfterSecond!.batch_id).toBe(runAfterFirst!.batch_id);
  });

  it('is not member-writable — the claim table has no member path', async () => {
    const viewer = await seedMember('male');
    await expect(
      harness.db.asUser(viewer.authId, (session) =>
        session.query(`select * from public.discovery_generation_runs`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
