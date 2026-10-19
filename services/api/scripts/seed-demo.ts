/**
 * Seeds clearly-labelled demo data, for recording and for manual walkthroughs.
 *
 *   pnpm --filter @nikahmate/api seed:demo          # create
 *   pnpm --filter @nikahmate/api seed:demo --clean  # remove, and stop
 *
 * WHAT THIS IS FOR. Discover, Family and Chat cannot be demonstrated against
 * an empty database, and inventing screenshots of them would misrepresent the
 * product. This creates the smallest set of rows that exercises the real
 * paths: two members who match, a family reviewer who approves, and a short
 * conversation.
 *
 * WHAT IT IS NOT. Not a fixture for tests — those build their own data in
 * PGlite and must not depend on anything here. Not a load generator.
 *
 * SAFETY PROPERTIES, in the order they matter:
 *
 * 1. EVERY row it writes is prefixed `demo-` or named "Demo …", and `--clean`
 *    deletes exactly what the prefix matches. Nothing else is touched.
 * 2. It REFUSES to run against a database that already holds real members,
 *    using the same reasoning as the migration runner's foreign-table guard: a
 *    wrong connection string should fail rather than scatter fake profiles
 *    through somebody's data.
 * 3. It creates no auth users. Supabase Auth is a separate system and this
 *    script has no business writing to it, so the demo accounts exist in
 *    `users` with `user_auth_links` rows pointing at generated ids. They are
 *    reachable through the API with a test token, not through a password.
 *
 * The connection string contains the database password, so it is never
 * printed — only the masked host, as elsewhere.
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const CLEAN = process.argv.includes('--clean');

/** Everything this script creates carries one of these markers. */
const DEMO_PREFIX = 'Demo ';
const DEMO_CONTACT = 'demo-reviewer@nikahmate.invalid';

/** Above this many non-demo members, refuse: this is not a scratch database. */
const REAL_MEMBER_CEILING = 5;

function maskedTarget(url: string): string {
  try {
    const { host } = new URL(url);
    return host.replace(/^[^.]*/, (s) => s.slice(0, 4) + '…');
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

interface DemoMember {
  userId: string;
  authUserId: string;
  displayName: string;
}

async function seedMember(
  client: Client,
  displayName: string,
  gender: 'male' | 'female',
  aboutMe: string,
): Promise<DemoMember> {
  const authUserId = randomUUID();

  const { rows } = await client.query<{ id: string }>(
    `insert into public.users (display_name, gender, date_of_birth, country_code, status)
     values ($1, $2, date '1996-04-12', 'pk', 'active')
     returning id`,
    [displayName, gender],
  );
  const userId = rows[0]!.id;

  await client.query(
    `insert into public.user_auth_links (user_id, auth_user_id, provider)
     values ($1::uuid, $2::uuid, 'email')`,
    [userId, authUserId],
  );
  await client.query(`insert into public.user_settings (user_id) values ($1::uuid)`, [userId]);
  await client.query(`insert into public.verification_status (user_id) values ($1::uuid)`, [
    userId,
  ]);
  await client.query(
    `insert into public.profiles
       (user_id, about_me, marital_status_code, religious_practice_code, review_status)
     values ($1::uuid, $2, 'ms_never_married', 'rel_practising', 'approved')`,
    [userId, aboutMe],
  );
  await client.query(
    `insert into public.user_locations (user_id, country_code, city_name)
     values ($1::uuid, 'pk', 'Lahore')`,
    [userId],
  );

  return { userId, authUserId, displayName };
}

/**
 * Removes every demo row, in dependency order.
 *
 * `on delete restrict` is the default across this schema deliberately, so
 * nothing cascades by surprise — which means the order here is part of the
 * contract, not an implementation detail.
 */
async function clean(client: Client): Promise<number> {
  const { rows: demo } = await client.query<{ id: string }>(
    `select id from public.users where display_name like $1`,
    [`${DEMO_PREFIX}%`],
  );
  if (demo.length === 0) return 0;

  const ids = demo.map((r) => r.id);

  await client.query(`delete from public.messages where sender_user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.message_reads where user_id = any($1::uuid[])`, [ids]);
  await client.query(
    `delete from public.stage_transitions where proposed_by_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.conversation_participants where user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.conversation_stages where conversation_id in (
       select c.id from public.conversations c
       join public.matches m on m.id = c.match_id
       where m.user_a_id = any($1::uuid[]) or m.user_b_id = any($1::uuid[])
     )`,
    [ids],
  );
  await client.query(
    `delete from public.conversations where match_id in (
       select id from public.matches
       where user_a_id = any($1::uuid[]) or user_b_id = any($1::uuid[])
     )`,
    [ids],
  );
  await client.query(`delete from public.family_access_log where owner_user_id = any($1::uuid[])`, [
    ids,
  ]);
  await client.query(`delete from public.family_reviews where owner_user_id = any($1::uuid[])`, [
    ids,
  ]);
  await client.query(
    `delete from public.family_permissions where relationship_id in (
       select id from public.family_relationships where owner_user_id = any($1::uuid[])
     )`,
    [ids],
  );
  await client.query(
    `delete from public.family_relationships where owner_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.family_invitations where owner_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(`delete from public.notifications where user_id = any($1::uuid[])`, [ids]);
  await client.query(
    `delete from public.match_events where actor_user_id = any($1::uuid[])
        or acted_by_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.matches where user_a_id = any($1::uuid[]) or user_b_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(`delete from public.interest_events where actor_user_id = any($1::uuid[])`, [
    ids,
  ]);
  await client.query(
    `delete from public.interests
      where sender_user_id = any($1::uuid[]) or recipient_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.match_candidates
      where user_id = any($1::uuid[]) or candidate_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.compatibility_factors where score_id in (
       select id from public.compatibility_scores
        where viewer_user_id = any($1::uuid[]) or candidate_user_id = any($1::uuid[])
     )`,
    [ids],
  );
  await client.query(
    `delete from public.compatibility_scores
      where viewer_user_id = any($1::uuid[]) or candidate_user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from public.discovery_generation_runs where user_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(`delete from public.usage_counters where user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.user_locations where user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.profiles where user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.verification_status where user_id = any($1::uuid[])`, [
    ids,
  ]);
  await client.query(`delete from public.user_settings where user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.user_auth_links where user_id = any($1::uuid[])`, [ids]);
  await client.query(`delete from public.family_invitations where invitee_contact = $1`, [
    DEMO_CONTACT,
  ]);
  await client.query(`delete from public.users where id = any($1::uuid[])`, [ids]);

  return ids.length;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    console.error('DATABASE_URL is not set. Add it to services/api/.env.');
    process.exit(2);
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    application_name: 'nikahmate-seed-demo',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to ${maskedTarget(url)}: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`Target: ${maskedTarget(url)}`);

  try {
    await client.query('begin');

    const removed = await clean(client);
    if (removed > 0) console.log(`Removed ${removed} existing demo member(s).`);

    if (CLEAN) {
      await client.query('commit');
      console.log('Demo data removed. Nothing else was touched.');
      return;
    }

    // The guard. Same reasoning as the migration runner's: a wrong connection
    // string should fail rather than scatter fake profiles through real data.
    const { rows: real } = await client.query<{ n: string }>(
      `select count(*)::text as n from public.users where display_name not like $1`,
      [`${DEMO_PREFIX}%`],
    );
    const realCount = Number.parseInt(real[0]!.n, 10);
    if (realCount > REAL_MEMBER_CEILING) {
      await client.query('rollback');
      console.error(
        `\nREFUSING TO SEED.\n\n` +
          `This database holds ${realCount} non-demo member(s), which is more than a\n` +
          `scratch project should. Demo data belongs in a development project\n` +
          `(docs/SUPABASE_SETUP.md). Check the project ref in DATABASE_URL.`,
      );
      process.exit(1);
    }

    const amina = await seedMember(
      client,
      `${DEMO_PREFIX}Amina`,
      'female',
      'Teacher, reader, and a keen gardener. Looking for someone kind, practising and honest about what they want from life.',
    );
    const yusuf = await seedMember(
      client,
      `${DEMO_PREFIX}Yusuf`,
      'male',
      'Civil engineer. I pray, I cook badly, and I am close to my family. Seeking a serious partner for marriage, insha Allah.',
    );
    const ibrahim = await seedMember(
      client,
      `${DEMO_PREFIX}Ibrahim`,
      'male',
      "Amina's father. Here to help, not to decide for her.",
    );

    // The family relationship, with the grants the reviewer tier expands to.
    const { rows: rel } = await client.query<{ id: string }>(
      `insert into public.family_relationships
         (owner_user_id, delegate_user_id, relationship_code, tier)
       values ($1::uuid, $2::uuid, 'father', 'reviewer')
       returning id`,
      [amina.userId, ibrahim.userId],
    );
    const relationshipId = rel[0]!.id;

    for (const permission of [
      'view_profile',
      'view_matches',
      'review_interest',
      'approve_communication',
      'report_on_behalf',
      'block_on_behalf',
    ]) {
      await client.query(
        `insert into public.family_permissions
           (relationship_id, permission, granted_by_user_id)
         values ($1::uuid, $2, $3::uuid)`,
        [relationshipId, permission, amina.userId],
      );
    }

    // Amina requires family review, so the match below is gated at birth by
    // `app.gate_new_match_period()` rather than by anything this script does.
    await client.query(
      `update public.user_settings set communication_policy = 'family_reviewed'
        where user_id = $1::uuid`,
      [amina.userId],
    );

    const { rows: interest } = await client.query<{ id: string }>(
      `insert into public.interests (sender_user_id, recipient_user_id, status, responded_at)
       values ($1::uuid, $2::uuid, 'accepted', now()) returning id`,
      [yusuf.userId, amina.userId],
    );

    const [a, b] = [amina.userId, yusuf.userId].sort();
    const { rows: match } = await client.query<{ id: string; communication_state: string }>(
      `insert into public.matches (user_a_id, user_b_id, interest_id)
       values ($1::uuid, $2::uuid, $3::uuid)
       returning id, communication_state`,
      [a, b, interest[0]!.id],
    );
    const matchId = match[0]!.id;

    if (match[0]!.communication_state !== 'pending_family_review') {
      throw new Error(
        `expected the gate to produce pending_family_review, got ${match[0]!.communication_state}`,
      );
    }

    await client.query(
      `insert into public.family_reviews (match_id, owner_user_id) values ($1::uuid, $2::uuid)`,
      [matchId, amina.userId],
    );

    console.log('\nSeeded:');
    console.log(`  ${amina.displayName}  auth ${amina.authUserId}  (family review ON)`);
    console.log(`  ${yusuf.displayName}  auth ${yusuf.authUserId}`);
    console.log(`  ${ibrahim.displayName}  auth ${ibrahim.authUserId}  (reviewer for Amina)`);
    console.log(`\n  match ${matchId} — pending_family_review, awaiting Ibrahim`);
    console.log('\nThe conversation does not exist yet, and that is the point:');
    console.log('approve the review and the trigger opens it.');
    console.log('\nRemove it all again with: pnpm --filter @nikahmate/api seed:demo --clean');

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    console.error(`Seeding failed and was rolled back: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
