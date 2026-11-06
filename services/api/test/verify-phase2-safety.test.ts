import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nikahmate/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../scripts/phase1-security-checks';
import { phase2SafetyChecks } from '../scripts/phase2-safety-checks';

/**
 * The Phase 2 checks `verify:db` runs against the live project (migration
 * 0028), run here against a database that is right, one from before 0028, and
 * databases broken one way at a time. Each breakage is made inside a
 * transaction and rolled back.
 */

const B16_BLOCK = 'B16 trigger blocks_cancel_stage_proposals';
const B16_MATCH = 'B16 trigger matches_cancel_stage_proposals';
const B16_LEAVE = 'B16 trigger conversation_participants_cancel_stage_proposals';
const B16_FN = 'B16 app.cancel_pending_stage_proposals cancels only, and members cannot call it';
const B16_STATUS = 'B16 stage_transitions allows cancelled, with no responder';
const B25 = 'B25 app.can_write_message refuses a thread anyone has left';
const B24 = 'B24 app.has_interacted_with is caller-scoped and not callable by anon';
const ALL = [B16_BLOCK, B16_MATCH, B16_LEAVE, B16_FN, B25, B24, B16_STATUS];

const queryable = (pg: PGlite): Queryable => ({
  query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params as never[]),
});

async function failures(pg: PGlite): Promise<{ names: string[]; detail: string }> {
  const results = await phase2SafetyChecks(queryable(pg));
  expect(results.map((r) => r.name).sort()).toEqual([...ALL].sort());
  const failed = results.filter((r) => !r.ok);
  return {
    names: failed.map((r) => r.name).sort(),
    detail: failed.map((r) => `${r.name}: ${r.detail}`).join('\n'),
  };
}

describe('a correctly migrated database', () => {
  it('passes every Phase 2 check', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([]);
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database from before 0028', () => {
  it('reports every Phase 2 control as missing', async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg, { through: '20261101000027' });
      const { names, detail } = await failures(pg);
      expect(names, detail).toEqual([...ALL].sort());
    } finally {
      await pg.close();
    }
  }, 180_000);
});

describe('a database broken in one way at a time', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
  }, 180_000);
  afterAll(async () => pg?.close());

  async function brokenBy(breakage: string): Promise<{ names: string[]; detail: string }> {
    await pg.exec('begin');
    try {
      await pg.exec(breakage);
      return await failures(pg);
    } finally {
      await pg.exec('rollback');
    }
  }

  // 0025's definition, exactly: what a revert of B25 would put back.
  const CAN_WRITE_0025 = `
    create or replace function app.can_write_message(viewer uuid, conversation uuid)
    returns boolean language sql stable security definer set search_path = public, pg_temp as $$
      select exists (
        select 1 from public.conversation_participants p
        join public.conversations c on c.id = p.conversation_id
        join public.matches m on m.id = c.match_id
        where p.conversation_id = conversation and p.user_id = viewer and p.left_at is null
          and p.can_write and c.status = 'active' and m.ended_at is null
          and m.communication_state in ('open', 'family_approved')
          and not app.is_blocked(m.user_a_id, m.user_b_id)
      ) $$`;

  it.each([
    // --- the three cancellation triggers ------------------------------------
    [B16_BLOCK, 'missing', `drop trigger blocks_cancel_stage_proposals on public.blocks`],
    [
      B16_BLOCK,
      'disabled',
      `alter table public.blocks disable trigger blocks_cancel_stage_proposals`,
    ],
    [
      B16_BLOCK,
      'BEFORE instead of AFTER',
      `drop trigger blocks_cancel_stage_proposals on public.blocks;
       create trigger blocks_cancel_stage_proposals before insert on public.blocks
         for each row execute function app.cancel_stage_proposals_on_block()`,
    ],
    [
      B16_BLOCK,
      'its function no longer cancels',
      `create or replace function app.cancel_stage_proposals_on_block() returns trigger
         language plpgsql as $$ begin return null; end; $$`,
    ],
    [B16_MATCH, 'missing', `drop trigger matches_cancel_stage_proposals on public.matches`],
    [
      B16_MATCH,
      'watching ended_at only, so a family revocation is missed',
      `drop trigger matches_cancel_stage_proposals on public.matches;
       create trigger matches_cancel_stage_proposals after update of ended_at on public.matches
         for each row execute function app.cancel_stage_proposals_on_match_close()`,
    ],
    [
      B16_MATCH,
      'calling a different function',
      `drop trigger matches_cancel_stage_proposals on public.matches;
       create trigger matches_cancel_stage_proposals
         after update of ended_at, communication_state on public.matches
         for each row execute function app.cancel_stage_proposals_on_leave()`,
    ],
    [
      B16_LEAVE,
      'missing',
      `drop trigger conversation_participants_cancel_stage_proposals on public.conversation_participants`,
    ],
    [
      B16_LEAVE,
      'disabled',
      `alter table public.conversation_participants
         disable trigger conversation_participants_cancel_stage_proposals`,
    ],
    // --- the cancelling function --------------------------------------------
    [
      B16_FN,
      'callable by members',
      `grant execute on function app.cancel_pending_stage_proposals(uuid) to authenticated`,
    ],
    [
      B16_FN,
      'moving the stage as well as cancelling',
      `create or replace function app.cancel_pending_stage_proposals(conversation uuid)
         returns integer language sql volatile security definer set search_path = public, pg_temp as $$
           update public.conversation_stages set current_stage = current_stage
            where conversation_id = conversation;
           update public.stage_transitions set status = 'cancelled', responded_at = now()
            where conversation_id = conversation and status = 'pending';
           select 1 $$`,
    ],
    [
      B16_FN,
      'cancelling answered proposals too',
      `create or replace function app.cancel_pending_stage_proposals(conversation uuid)
         returns integer language sql volatile security definer set search_path = public, pg_temp as $$
           update public.stage_transitions set status = 'cancelled', responded_at = now()
            where conversation_id = conversation;
           select 1 $$`,
    ],
    // --- B25 ----------------------------------------------------------------
    [B25, 'reverted to the one-sided 0025 rule', CAN_WRITE_0025],
    // --- B24 ----------------------------------------------------------------
    [B24, 'callable by anon', `grant execute on function app.has_interacted_with(uuid) to anon`],
    [
      B24,
      'no longer callable by members, so blocking breaks',
      `revoke execute on function app.has_interacted_with(uuid) from authenticated`,
    ],
    [
      B24,
      'no longer caller-scoped',
      `create or replace function app.has_interacted_with(target uuid)
         returns boolean language sql stable security definer set search_path = public, pg_temp as $$
           select exists (select 1 from public.interests i where i.recipient_user_id = target)
               or exists (select 1 from public.matches m where m.user_b_id = target) $$`,
    ],
    [B24, 'VOLATILE', `alter function app.has_interacted_with(uuid) volatile`],
    // --- constraint ---------------------------------------------------------
    [
      B16_STATUS,
      'reverted to pending/accepted/declined',
      `alter table public.stage_transitions drop constraint stage_transitions_status_valid;
       alter table public.stage_transitions add constraint stage_transitions_status_valid
         check (status in ('pending', 'accepted', 'declined')) not valid`,
    ],
  ])('%s fails when %s', async (check, _how, breakage) => {
    const { names, detail } = await brokenBy(breakage);
    expect(names, detail).toEqual([check]);
  });
});
