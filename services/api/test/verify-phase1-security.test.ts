import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phase1SecurityChecks, type Queryable } from '../scripts/phase1-security-checks';

/**
 * The Phase 1 checks `verify:db` runs against the live project, run here
 * against databases that are right, part-way through the release, and broken
 * on purpose — one break per check. A verifier check that passes on a broken
 * database is worse than no check, because it is believed.
 *
 * Each break is made inside a transaction and rolled back, so every case
 * starts from the same correct database.
 */

const ALL = [
  'B1 trigger matches_guard_family_approval',
  'B3 trigger user_settings_guard_incognito',
  'B7 no member INSERT on messages.kind',
  'B7 members can still insert a message',
  'B7 message insert policy pins text and a non-blank body',
  'B7 messages_body_not_blank',
  'B7 no member INSERT on interests',
];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

async function database(through?: string): Promise<PGlite> {
  const pg = new PGlite();
  await applyMigrations(pg, through === undefined ? {} : { through });
  return pg;
}

/** Names of the failing checks, plus their details for the assertion message. */
async function failures(pg: PGlite): Promise<{ names: string[]; detail: string }> {
  const results = await phase1SecurityChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  const failed = results.filter((r) => !r.ok);
  return {
    names: failed.map((r) => r.name).sort(),
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join('\n'),
  };
}

describe('a correctly migrated database', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await database();
  }, 180_000);
  afterAll(async () => pg?.close());

  it('passes every Phase 1 check', async () => {
    const { names, detail } = await failures(pg);
    expect(names, detail).toEqual([]);
  });
});

describe('a database part-way through the release', () => {
  it('after 0026 but before 0027: only the messages.kind check fails', async () => {
    // The expected state between applying 0026 and 0027. verify:db is not
    // green until the release is finished — on purpose.
    const pg = await database('20261101000026');
    try {
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual(['B7 no member INSERT on messages.kind']);
    } finally {
      await pg.close();
    }
  }, 180_000);

  it('before 0026: every Phase 1 control is reported missing', async () => {
    const pg = await database('20261019000025');
    try {
      const { names, detail } = await failures(pg);
      // Only the send itself was already right.
      expect(names, detail).toEqual(
        ALL.filter((n) => n !== 'B7 members can still insert a message').sort(),
      );
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database broken in one way at a time', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await database();
  }, 180_000);
  afterAll(async () => pg?.close());

  /** Apply `breakage`, collect failures, roll the breakage back. */
  async function brokenBy(breakage: string): Promise<{ names: string[]; detail: string }> {
    await pg.exec('begin');
    try {
      await pg.exec(breakage);
      return await failures(pg);
    } finally {
      await pg.exec('rollback');
    }
  }

  const B1 = 'B1 trigger matches_guard_family_approval';
  const B3 = 'B3 trigger user_settings_guard_incognito';
  const KIND = 'B7 no member INSERT on messages.kind';
  const SEND = 'B7 members can still insert a message';
  const POLICY = 'B7 message insert policy pins text and a non-blank body';
  const BLANK = 'B7 messages_body_not_blank';
  const INTERESTS = 'B7 no member INSERT on interests';

  it.each([
    // --- B1 trigger ---------------------------------------------------------
    [B1, 'missing', `drop trigger matches_guard_family_approval on public.matches`],
    [B1, 'disabled', `alter table public.matches disable trigger matches_guard_family_approval`],
    [
      B1,
      'AFTER instead of BEFORE',
      `drop trigger matches_guard_family_approval on public.matches;
       create trigger matches_guard_family_approval
         after update of communication_state on public.matches
         for each row execute function app.guard_family_approval()`,
    ],
    [
      B1,
      'watching the wrong column',
      `drop trigger matches_guard_family_approval on public.matches;
       create trigger matches_guard_family_approval
         before update of ended_at on public.matches
         for each row execute function app.guard_family_approval()`,
    ],
    [
      B1,
      'calling a different function',
      `create function app.phase1_noop() returns trigger language plpgsql
         as $$ begin return new; end; $$;
       drop trigger matches_guard_family_approval on public.matches;
       create trigger matches_guard_family_approval
         before update of communication_state on public.matches
         for each row execute function app.phase1_noop()`,
    ],
    [
      B1,
      'guard function neutered',
      `create or replace function app.guard_family_approval() returns trigger
         language plpgsql as $$ begin return new; end; $$`,
    ],
    // --- B3 trigger ---------------------------------------------------------
    [B3, 'missing', `drop trigger user_settings_guard_incognito on public.user_settings`],
    [
      B3,
      'disabled',
      `alter table public.user_settings disable trigger user_settings_guard_incognito`,
    ],
    [
      B3,
      'UPDATE only, so an INSERT could start incognito',
      `drop trigger user_settings_guard_incognito on public.user_settings;
       create trigger user_settings_guard_incognito
         before update of incognito on public.user_settings
         for each row execute function app.guard_incognito_entitlement()`,
    ],
    [
      B3,
      'guard function no longer checks the entitlement',
      `create or replace function app.guard_incognito_entitlement() returns trigger
         language plpgsql as $$ begin return new; end; $$`,
    ],
    // --- messages.kind ------------------------------------------------------
    [KIND, 'column re-granted', `grant insert (kind) on public.messages to authenticated`],
    [KIND, 'table-level INSERT granted', `grant insert on public.messages to authenticated`],
    [KIND, 'granted to PUBLIC', `grant insert (kind) on public.messages to public`],
    [KIND, 'granted to anon', `grant insert (kind) on public.messages to anon`],
    // --- the send must still work -------------------------------------------
    [SEND, 'revoke went too far', `revoke insert (body) on public.messages from api_member`],
    // --- insert policy ------------------------------------------------------
    [
      POLICY,
      'kind no longer pinned',
      `drop policy messages_insert_when_permitted on public.messages;
       create policy messages_insert_when_permitted on public.messages
         for insert to authenticated
         with check (sender_user_id = app.current_user_id()
                     and body ~ '[^[:space:]]'
                     and app.can_write_message(app.current_user_id(), conversation_id))`,
    ],
    [
      POLICY,
      'a second permissive insert policy',
      `create policy messages_insert_anything on public.messages
         for insert to authenticated with check (true)`,
    ],
    // --- non-blank constraint -----------------------------------------------
    [BLANK, 'missing', `alter table public.messages drop constraint messages_body_not_blank`],
    [
      BLANK,
      'NOT VALID',
      `alter table public.messages drop constraint messages_body_not_blank;
       alter table public.messages add constraint messages_body_not_blank
         check (body ~ '[^[:space:]]') not valid`,
    ],
    // --- interests ----------------------------------------------------------
    [INTERESTS, 'table INSERT re-granted', `grant insert on public.interests to authenticated`],
    [INTERESTS, 'one column granted', `grant insert (note) on public.interests to authenticated`],
    [INTERESTS, 'granted to anon', `grant insert on public.interests to anon`],
    [INTERESTS, 'granted to PUBLIC', `grant insert on public.interests to public`],
  ])('%s fails when %s', async (check, _how, breakage) => {
    const { names, detail } = await brokenBy(breakage);
    expect(names, detail).toEqual([check]);
  });
});
