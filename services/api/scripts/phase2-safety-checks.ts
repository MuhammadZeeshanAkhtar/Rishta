import {
  INSERT,
  ROW,
  UPDATE,
  checkTriggers,
  normalise,
  type ExpectedTrigger,
  type Queryable,
  type SecurityCheck,
  memberRoles,
} from './phase1-security-checks';

/**
 * The Phase 2 conversation-safety configuration (code review, 2026-10-28;
 * migration 0028), checked against whatever database `db` reaches.
 *
 * Called by `verify-db.ts` against the live project, and by
 * `test/verify-phase2-safety.test.ts` against PGlite — including databases
 * broken on purpose, one way at a time, so a check that cannot fail is caught.
 * Read-only.
 *
 *   B16  three triggers cancel a pending stage proposal when its thread closes
 *        (block, unmatch / family revocation, leave), through one function
 *        members cannot call; `cancelled` is a legal status
 *   B24  app.has_interacted_with is caller-scoped and anon cannot run it
 *   B25  app.can_write_message refuses a thread anyone has left
 */

const CANCELS = 'cancel_pending_stage_proposals(';

const TRIGGERS: ExpectedTrigger[] = [
  {
    finding: 'B16',
    name: 'blocks_cancel_stage_proposals',
    table: 'public.blocks',
    tgtype: ROW | INSERT,
    timing: 'AFTER INSERT, FOR EACH ROW',
    columns: [],
    fn: 'app.cancel_stage_proposals_on_block',
    bodyMustContain: [CANCELS, 'new.blocker_user_id', 'new.blocked_user_id'],
  },
  {
    finding: 'B16',
    name: 'matches_cancel_stage_proposals',
    table: 'public.matches',
    tgtype: ROW | UPDATE,
    timing: 'AFTER UPDATE OF communication_state, ended_at, FOR EACH ROW',
    // Sorted: the checker compares the column list in name order.
    columns: ['communication_state', 'ended_at'],
    fn: 'app.cancel_stage_proposals_on_match_close',
    bodyMustContain: [CANCELS, 'new.ended_at is not null', "('open', 'family_approved')"],
  },
  {
    finding: 'B16',
    name: 'conversation_participants_cancel_stage_proposals',
    table: 'public.conversation_participants',
    tgtype: ROW | UPDATE,
    timing: 'AFTER UPDATE OF left_at, FOR EACH ROW',
    columns: ['left_at'],
    fn: 'app.cancel_stage_proposals_on_leave',
    bodyMustContain: [CANCELS, 'new.left_at is not null'],
  },
];

async function functionChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  const { rows } = await db.query<{
    name: string;
    volatility: string;
    secdef: boolean;
    body: string;
  }>(
    `select p.proname as name, p.provolatile::text as volatility,
            p.prosecdef as secdef, p.prosrc as body
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
      where p.proname = any($1::text[])`,
    [['cancel_pending_stage_proposals', 'can_write_message', 'has_interacted_with']],
  );
  const fn = (name: string) => rows.find((r) => r.name === name);

  // --- B16: the cancelling function, and who may call it --------------------
  {
    const label = 'B16 app.cancel_pending_stage_proposals cancels only, and members cannot call it';
    const f = fn('cancel_pending_stage_proposals');
    const problems: string[] = [];
    if (!f) problems.push('missing');
    else {
      const body = normalise(f.body);
      if (!body.includes("set status = 'cancelled'")) problems.push('no longer sets cancelled');
      if (!body.includes("status = 'pending'")) problems.push('no longer limited to pending rows');
      if (body.includes('current_stage')) problems.push('touches the current stage');
      const { rows: grants } = await db.query<{ role: string; can: boolean }>(
        `select r as role,
                has_function_privilege(r, 'app.cancel_pending_stage_proposals(uuid)', 'EXECUTE')
                  as can
           from unnest($1::text[]) as r`,
        [await memberRoles(db)],
      );
      const open = grants.filter((g) => g.can).map((g) => g.role);
      if (open.length) problems.push(`EXECUTE held by: ${open.join(', ')}`);
    }
    out.push(
      problems.length === 0
        ? { name: label, ok: true, detail: 'pending -> cancelled; service role only' }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }

  // --- B25: leaving closes the thread for both -------------------------------
  {
    const label = 'B25 app.can_write_message refuses a thread anyone has left';
    const f = fn('can_write_message');
    const body = f ? normalise(f.body) : '';
    const ok =
      !!f && body.includes('other.left_at is not null') && body.includes('p.left_at is null');
    out.push(
      ok
        ? { name: label, ok: true, detail: 'checks every participant, not only the writer' }
        : {
            name: label,
            ok: false,
            detail: f ? 'no longer checks whether the other participant left' : 'missing',
          },
    );
  }

  // --- B24: caller-scoped, STABLE SECURITY DEFINER, never anon --------------
  {
    const label = 'B24 app.has_interacted_with is caller-scoped and not callable by anon';
    const f = fn('has_interacted_with');
    const problems: string[] = [];
    if (!f) problems.push('missing');
    else {
      if (f.volatility !== 's' || !f.secdef) problems.push('not STABLE SECURITY DEFINER');
      const body = normalise(f.body);
      if (!body.includes('app.current_user_id()')) problems.push('no longer caller-scoped');
      if (!body.includes('public.interests') || !body.includes('public.matches')) {
        problems.push('no longer checks both interests and matches');
      }
      const { rows: grants } = await db.query<{ anon: boolean; member: boolean }>(
        `select has_function_privilege('anon', 'app.has_interacted_with(uuid)', 'EXECUTE')
                  as anon,
                has_function_privilege('authenticated', 'app.has_interacted_with(uuid)', 'EXECUTE')
                  as member`,
      );
      if (grants[0]?.anon) problems.push('anon can EXECUTE it');
      if (!grants[0]?.member) problems.push('authenticated cannot EXECUTE it — blocking breaks');
    }
    out.push(
      problems.length === 0
        ? { name: label, ok: true, detail: 'reads app.current_user_id(); authenticated only' }
        : { name: label, ok: false, detail: problems.join('; ') },
    );
  }
}

async function constraintChecks(db: Queryable, out: SecurityCheck[]): Promise<void> {
  const label = 'B16 stage_transitions allows cancelled, with no responder';
  const { rows } = await db.query<{ name: string; def: string }>(
    `select conname as name, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid = 'public.stage_transitions'::regclass
        and conname in ('stage_transitions_status_valid', 'stage_transitions_responded_consistent')`,
  );
  const status = normalise(
    rows.find((r) => r.name === 'stage_transitions_status_valid')?.def ?? '',
  );
  const responded = normalise(
    rows.find((r) => r.name === 'stage_transitions_responded_consistent')?.def ?? '',
  );
  const problems: string[] = [];
  if (!status.includes("'cancelled'")) problems.push('status check does not allow cancelled');
  if (!responded.includes("'cancelled'")) {
    problems.push('responded_consistent has no cancelled branch');
  }
  out.push(
    problems.length === 0
      ? { name: label, ok: true }
      : { name: label, ok: false, detail: problems.join('; ') },
  );
}

/**
 * Runs every Phase 2 check. A section that crashes is reported as a failed
 * check rather than thrown, so the others still report.
 */
export async function phase2SafetyChecks(db: Queryable): Promise<SecurityCheck[]> {
  const out: SecurityCheck[] = [];
  const sections: Array<[string, (d: Queryable, o: SecurityCheck[]) => Promise<void>]> = [
    ['Phase 2 trigger checks', (d, o) => checkTriggers(d, o, TRIGGERS)],
    ['Phase 2 function checks', functionChecks],
    ['Phase 2 constraint checks', constraintChecks],
  ];
  for (const [label, run] of sections) {
    try {
      await run(db, out);
    } catch (error) {
      out.push({ name: label, ok: false, detail: `crashed: ${(error as Error).message}` });
    }
  }
  return out;
}
