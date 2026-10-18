/**
 * Verifies the live database against what the migrations claim to have built.
 *
 *   pnpm --filter @nikahmate/api verify:db
 *
 * The test suite proves the migrations are correct against PGlite. This proves
 * the migrations actually LANDED correctly on the real project — which is a
 * different question, because Supabase's platform defaults, dashboard settings
 * and role set are not reproduced by an in-process Postgres.
 *
 * Structural checks are read-only. The behavioural RLS checks need rows to act
 * on, so they run inside a transaction that is ALWAYS rolled back: this may be
 * pointed at a database with real data in it, and a verifier that leaves test
 * users behind is a verifier nobody runs twice.
 *
 * Exit code is 0 only when every check passes.
 */

import { Client, type QueryResultRow } from 'pg';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
const pass = (name: string, detail?: string): void => {
  checks.push(detail === undefined ? { name, ok: true } : { name, ok: true, detail });
};
const fail = (name: string, detail: string): void => {
  checks.push({ name, ok: false, detail });
};

const EXPECTED_TABLES = [
  'blocks',
  'compatibility_factors',
  'compatibility_scores',
  'dismissed_profiles',
  'interest_events',
  'interests',
  'match_candidates',
  'match_events',
  'matches',
  'media_moderation_results',
  'notifications',
  'partner_preferences',
  'photo_variants',
  'photos',
  'preference_rules',
  'profile_field_visibility',
  'profile_sensitive',
  'profiles',
  'reference_items',
  'reference_translations',
  'reports',
  'security_events',
  'shortlists',
  'usage_counters',
  'user_auth_links',
  'user_consents',
  'user_devices',
  'user_entitlements',
  'user_locations',
  'user_settings',
  'users',
  'verification_status',
];

/** Zero policies is the control on these — see ERD §2.2. */
const RESTRICTED = [
  'media_moderation_results',
  'profile_sensitive',
  'user_auth_links',
  'user_consents',
];

/** Reference types the Phase 3 screens cannot function without. */
const REQUIRED_REFERENCE_TYPES = [
  'country',
  'language',
  'education_level',
  'field_of_study',
  'profession',
  'industry',
  'employment_status',
  'marital_status',
  'religious_practice',
  'sect',
  'prayer_frequency',
  'quran_level',
  'marriage_timeline',
  'relocation_option',
  'hobby',
  'lifestyle_attribute',
  'personality_trait',
  'dress_practice',
  'diet',
  'smoking',
];

/**
 * Columns the server owns.
 *
 * A member who could UPDATE any of these could make themselves discoverable,
 * lift their own suspension, or reassign a row to another account. Stated as a
 * denylist rather than an allowlist of all 135 writable columns: a list that
 * size gets updated by reflex instead of by thought, which is how a check
 * stops being a control and becomes a chore.
 *
 * INSERT on an ownership column is deliberately absent — a new row must name
 * its owner, and the insert policy pins it to app.current_user_id().
 */
const FORBIDDEN_UPDATE_COLUMNS = [
  'users.status',
  'users.deleted_at',
  'users.profile_completed_at',
  'users.created_at',
  'profiles.review_status',
  'profiles.completion_score',
  'profiles.submitted_at',
  'profiles.reviewed_at',
  'profiles.rejection_reason_key',
  'profiles.deleted_at',
  'profiles.user_id',
  'partner_preferences.user_id',
  'user_locations.user_id',
  'profile_field_visibility.user_id',
  'preference_rules.user_id',
  'security_events.event_type',
  // Moderation is the server's. A member who could approve their own photo
  // would bypass the control entirely, and storage_path points at the bytes.
  'photos.deleted_at',
  'photos.moderation_status',
  'photos.rejection_reason_key',
  'photos.user_id',
  'photos.storage_path',
];

/** Tables permitted to carry any column-level grant at all. */
const COLUMN_GRANTABLE_TABLES = [
  // Phase 6 Slice 5: `update (read_at)` only, so marking a notification read
  // cannot become rewriting its type or payload.
  'notifications',
  'partner_preferences',
  'photos',
  'preference_rules',
  'profile_field_visibility',
  'profiles',
  'user_devices',
  'user_locations',
  'user_settings',
  'users',
];

const EXPECTED_TABLE_GRANTS = [
  'blocks authenticated DELETE',
  'blocks authenticated INSERT',
  'blocks authenticated SELECT',
  'compatibility_factors authenticated SELECT',
  'compatibility_scores authenticated SELECT',
  'dismissed_profiles authenticated DELETE',
  'dismissed_profiles authenticated INSERT',
  'dismissed_profiles authenticated SELECT',
  'interests authenticated INSERT',
  'interests authenticated SELECT',
  'match_candidates authenticated SELECT',
  'matches authenticated SELECT',
  'notifications authenticated SELECT',
  'partner_preferences authenticated SELECT',
  'photo_variants authenticated SELECT',
  'photos authenticated SELECT',
  'preference_rules authenticated DELETE',
  'preference_rules authenticated SELECT',
  'profile_field_visibility authenticated DELETE',
  'profile_field_visibility authenticated SELECT',
  'profiles authenticated SELECT',
  'reference_items anon SELECT',
  'reference_items authenticated SELECT',
  'reference_translations anon SELECT',
  'reference_translations authenticated SELECT',
  // Reports: SELECT only. The reporter is promised the outcome (ERD section 14);
  // every write belongs to the moderation pipeline, so there is no member path.
  'reports authenticated SELECT',
  'security_events authenticated SELECT',
  'shortlists authenticated DELETE',
  'shortlists authenticated INSERT',
  'shortlists authenticated SELECT',
  'usage_counters authenticated SELECT',
  'user_devices authenticated SELECT',
  'user_entitlements authenticated SELECT',
  'user_locations authenticated SELECT',
  'user_settings authenticated SELECT',
  'users authenticated SELECT',
  'verification_status authenticated SELECT',
];

function maskedTarget(url: string): string {
  try {
    const { host } = new URL(url);
    return host.replace(/^[^.]*/, (s) => s.slice(0, 4) + '…');
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function diff(label: string, actual: string[], expected: string[]): void {
  const missing = expected.filter((e) => !actual.includes(e));
  const extra = actual.filter((a) => !expected.includes(a));
  if (missing.length === 0 && extra.length === 0) {
    pass(label, `${actual.length} exactly as expected`);
    return;
  }
  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  // Extra privileges are the dangerous direction — say so plainly.
  if (extra.length) parts.push(`UNEXPECTED: ${extra.join(', ')}`);
  fail(label, parts.join(' | '));
}

async function structural(client: Client): Promise<void> {
  // --- tables ---------------------------------------------------------------
  const { rows: tables } = await client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  diff(
    'tables in public',
    tables.map((t) => t.tablename),
    EXPECTED_TABLES,
  );

  // --- RLS enabled AND forced ----------------------------------------------
  const { rows: rls } = await client.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  );
  const notEnabled = rls.filter((r) => !r.relrowsecurity).map((r) => r.relname);
  const notForced = rls
    .filter((r) => r.relrowsecurity && !r.relforcerowsecurity)
    .map((r) => r.relname);
  if (notEnabled.length === 0 && notForced.length === 0 && rls.length > 0) {
    pass('RLS enabled and FORCED on every table', `${rls.length} tables`);
  } else {
    fail(
      'RLS enabled and FORCED on every table',
      [
        notEnabled.length ? `NOT ENABLED: ${notEnabled.join(', ')}` : '',
        notForced.length ? `not forced: ${notForced.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    );
  }

  // --- restricted tables carry zero policies --------------------------------
  const { rows: pol } = await client.query<{ tablename: string; n: number }>(
    `select t.tablename, count(p.policyname)::int as n
     from pg_tables t
     left join pg_policies p on p.tablename = t.tablename and p.schemaname = 'public'
     where t.schemaname = 'public' group by t.tablename order by t.tablename`,
  );
  const leaky = pol.filter((r) => RESTRICTED.includes(r.tablename) && r.n > 0);
  if (leaky.length === 0) {
    pass('restricted tables have zero policies', RESTRICTED.join(', '));
  } else {
    fail(
      'restricted tables have zero policies',
      leaky.map((r) => `${r.tablename} has ${r.n}`).join(', '),
    );
  }
  pass(
    'policy count',
    pol
      .filter((r) => r.n > 0)
      .map((r) => `${r.tablename}:${r.n}`)
      .join(' '),
  );

  // --- grants: the surface the Data API exposes -----------------------------
  const { rows: tg } = await client.query<{ g: string }>(
    `select c.relname || ' ' || r.rolname || ' ' || a.privilege_type as g
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     cross join lateral aclexplode(c.relacl) a
     join pg_roles r on r.oid = a.grantee
     where c.relkind = 'r' and r.rolname in ('anon', 'authenticated')`,
  );
  diff('table grants to anon/authenticated', tg.map((r) => r.g).sort(), EXPECTED_TABLE_GRANTS);

  const { rows: cg } = await client.query<{ g: string }>(
    `select c.relname || '.' || att.attname as g
     from pg_attribute att
     join pg_class c on c.oid = att.attrelid
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     cross join lateral aclexplode(att.attacl) a
     join pg_roles r on r.oid = a.grantee
     where c.relkind = 'r' and att.attnum > 0 and not att.attisdropped
       and r.rolname in ('anon', 'authenticated')
       and a.privilege_type = 'UPDATE'`,
  );
  const updatable = new Set(cg.map((r) => r.g));
  const leaked = FORBIDDEN_UPDATE_COLUMNS.filter((f) => updatable.has(f));
  if (leaked.length === 0) {
    pass('no server-owned column is member-writable', `${FORBIDDEN_UPDATE_COLUMNS.length} checked`);
  } else {
    fail('no server-owned column is member-writable', `WRITABLE: ${leaked.join(', ')}`);
  }

  const { rows: cgTables } = await client.query<{ relname: string }>(
    `select distinct c.relname
     from pg_attribute att
     join pg_class c on c.oid = att.attrelid
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     cross join lateral aclexplode(att.attacl) a
     join pg_roles r on r.oid = a.grantee
     where c.relkind = 'r' and att.attnum > 0 and not att.attisdropped
       and r.rolname in ('anon', 'authenticated')
     order by 1`,
  );
  diff(
    'column grants confined to the intended tables',
    cgTables.map((r) => r.relname),
    COLUMN_GRANTABLE_TABLES,
  );

  // anon holds the publishable key, which ships inside the app and can be
  // extracted from any APK. It must be able to write nothing at all.
  const { rows: anonWrite } = await client.query<{ g: string }>(
    `select c.relname || ' ' || a.privilege_type as g
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     cross join lateral aclexplode(c.relacl) a
     join pg_roles r on r.oid = a.grantee
     where c.relkind = 'r' and r.rolname = 'anon' and a.privilege_type <> 'SELECT'`,
  );
  if (anonWrite.length === 0) {
    pass('anon has no write access anywhere');
  } else {
    fail('anon has no write access anywhere', anonWrite.map((r) => r.g).join(', '));
  }

  // --- reference data --------------------------------------------------------
  const { rows: refCounts } = await client.query<{ type: string; n: number }>(
    `select type, count(*)::int as n from public.reference_items group by type`,
  );
  const byType = new Map(refCounts.map((r) => [r.type, r.n]));
  const emptyTypes = REQUIRED_REFERENCE_TYPES.filter((t) => (byType.get(t) ?? 0) === 0);
  if (emptyTypes.length === 0) {
    const total = refCounts.reduce((sum, r) => sum + r.n, 0);
    pass('reference data seeded', `${total} items across ${refCounts.length} types`);
  } else {
    fail('reference data seeded', `no items for: ${emptyTypes.join(', ')}`);
  }

  const { rows: missingTr } = await client.query<{ locale: string; missing: number }>(
    `select l.locale, count(*)::int as missing
     from public.reference_items i
     cross join (values ('en')) as l(locale)
     left join public.reference_translations t
       on t.reference_item_id = i.id and t.locale = l.locale
     where t.id is null
     group by l.locale`,
  );
  if (missingTr.length === 0) {
    pass('every reference item is translated into en');
  } else {
    fail(
      'every reference item is translated into en',
      missingTr.map((r) => `${r.locale}: ${r.missing} missing`).join(', '),
    );
  }

  // The app ships in English only. A stray locale here is a label nothing can
  // render, and the seed is the one place it could come back from.
  const { rows: strayLocales } = await client.query<{ locale: string; n: number }>(
    `select locale, count(*)::int as n
     from public.reference_translations
     where locale <> 'en'
     group by locale
     order by locale`,
  );
  if (strayLocales.length === 0) {
    pass('reference data carries no locale other than en');
  } else {
    fail(
      'reference data carries no locale other than en',
      strayLocales.map((r) => `${r.locale}: ${r.n} row(s)`).join(', '),
    );
  }

  const { rows: straySettings } = await client.query<{ n: number }>(
    `select count(*)::int as n from public.user_settings where locale <> 'en'`,
  );
  if ((straySettings[0]?.n ?? 0) === 0) {
    pass('no account is left on a removed locale');
  } else {
    fail('no account is left on a removed locale', `${straySettings[0]?.n} account(s)`);
  }

  const { rows: badCase } = await client.query<{ code: string }>(
    `select code from public.reference_items where type = 'country' and code <> lower(code)`,
  );
  if (badCase.length === 0) {
    pass('country codes are lower-case', 'so they satisfy the composite reference FK');
  } else {
    fail('country codes are lower-case', `upper-case: ${badCase.map((r) => r.code).join(', ')}`);
  }

  // --- Storage ---------------------------------------------------------------
  //
  // The bucket is the one place in this product where a misconfiguration is
  // immediately catastrophic: a public bucket serves every photo to anyone who
  // can guess a path (risk R5). Checked live rather than assumed.
  const { rows: buckets } = await client.query<{
    id: string;
    public: boolean;
    file_size_limit: string | null;
    allowed_mime_types: string[] | null;
  }>(
    `select id, public, file_size_limit, allowed_mime_types
     from storage.buckets where id = 'photos'`,
  );
  const bucket = buckets[0];
  if (!bucket) {
    fail('photos bucket exists', 'not found — uploads cannot work');
  } else if (bucket.public) {
    fail('photos bucket is PRIVATE', 'bucket is PUBLIC — every photo is world-readable');
  } else {
    pass(
      'photos bucket is private',
      `${Number(bucket.file_size_limit) / 1024 / 1024}MB, ${(bucket.allowed_mime_types ?? []).join(', ')}`,
    );
  }

  const { rows: storageRls } = await client.query<{ relrowsecurity: boolean }>(
    `select c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects'`,
  );
  if (storageRls[0]?.relrowsecurity) {
    pass('RLS enabled on storage.objects');
  } else {
    fail('RLS enabled on storage.objects', 'objects are unprotected');
  }

  const { rows: storagePolicies } = await client.query<{ policyname: string; cmd: string }>(
    `select policyname, cmd from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'photos_bucket_%'
     order by policyname`,
  );
  diff(
    'photos bucket policies',
    storagePolicies.map((r) => `${r.policyname} ${r.cmd}`),
    [
      'photos_bucket_delete_own DELETE',
      'photos_bucket_insert_own INSERT',
      'photos_bucket_select_own SELECT',
      'photos_bucket_update_own UPDATE',
    ],
  );

  // Every one of those policies is `to authenticated`. An anonymous caller
  // holding the publishable key — which ships in the APK — must match none.
  const { rows: anonStorage } = await client.query<{ policyname: string }>(
    `select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'photos_bucket_%'
       and 'anon' = any(roles)`,
  );
  if (anonStorage.length === 0) {
    pass('anon matches no photos-bucket policy');
  } else {
    fail('anon matches no photos-bucket policy', anonStorage.map((r) => r.policyname).join(', '));
  }

  // --- the forward guard ----------------------------------------------------
  //
  // Asked empirically rather than by reading pg_default_acl, because default
  // privileges apply per GRANTOR: an entry owned by supabase_admin governs
  // tables supabase_admin creates and has no bearing on tables ours creates.
  // Reasoning about that indirectly is how you arrive at a confident wrong
  // answer. Creating a table and looking at what it got cannot be misread.
  //
  // Rolled back, so the probe table never exists outside this transaction.
  await client.query('begin');
  try {
    await client.query(`create table public.zz_grant_probe (id int)`);
    const { rows: probe } = await client.query<{ grantee: string; privs: string }>(
      `select r.rolname as grantee,
              string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(c.relacl) a
       join pg_roles r on r.oid = a.grantee
       where c.relname = 'zz_grant_probe'
         and r.rolname in ('anon', 'authenticated')
       group by 1`,
    );
    if (probe.length === 0) {
      pass(
        'a newly created table is NOT exposed to anon/authenticated',
        'so a Phase 3 table cannot ship readable by accident',
      );
    } else {
      fail(
        'a newly created table is NOT exposed to anon/authenticated',
        `a new table is granted ${probe.map((p) => `${p.grantee}: ${p.privs}`).join('; ')} — ` +
          `every future migration would expose its table on creation`,
      );
    }
  } catch (error) {
    fail(
      'a newly created table is NOT exposed to anon/authenticated',
      `probe failed: ${(error as Error).message}`,
    );
  } finally {
    await client.query('rollback').catch(() => {});
  }

  // --- foreign keys and the composite reference FK --------------------------
  const { rows: fks } = await client.query<{ c: string }>(
    `select con.conrelid::regclass::text || ' -> ' || con.confrelid::regclass::text as c
     from pg_constraint con
     join pg_namespace n on n.oid = con.connamespace and n.nspname = 'public'
     where con.contype = 'f' order by 1`,
  );
  pass('foreign keys', `${fks.length}: ${fks.map((r) => r.c).join(', ')}`);

  const { rows: comp } = await client.query<{ n: number }>(
    `select count(*)::int as n from pg_constraint
     where conname = 'users_country_fk' and array_length(conkey, 1) = 2`,
  );
  if ((comp[0]?.n ?? 0) === 1) {
    pass('users_country_fk is composite (type, code)', 'ERD E2 integrity holds');
  } else {
    fail('users_country_fk is composite (type, code)', 'not found as a 2-column FK');
  }

  // --- the identity resolver ------------------------------------------------
  const { rows: fn } = await client.query<{ provolatile: string; prosecdef: boolean }>(
    `select provolatile, prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'current_user_id'`,
  );
  const f = fn[0];
  if (f && f.provolatile === 's' && f.prosecdef) {
    pass('app.current_user_id() is STABLE + SECURITY DEFINER');
  } else {
    fail(
      'app.current_user_id() is STABLE + SECURITY DEFINER',
      f ? `volatility=${f.provolatile} secdef=${f.prosecdef}` : 'function not found',
    );
  }

  // --- the visibility predicates (Phase 5 Slice 1) --------------------------
  //
  // STABLE so they are evaluated once per statement rather than once per row —
  // can_view_profile runs against every candidate row in a discovery query.
  // SECURITY DEFINER because they read owner-only tables: evaluated as the
  // viewer, each would find no row for the target and report every member
  // invisible, which fails closed but silently.
  const PREDICATES = [
    'is_blocked',
    'relationship',
    'can_view_profile',
    'can_view_photo',
    'profile_visible_to',
    'photo_visible_to',
  ];
  const { rows: preds } = await client.query<{
    proname: string;
    provolatile: string;
    prosecdef: boolean;
  }>(
    `select p.proname, p.provolatile, p.prosecdef
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = any($1::text[])`,
    [PREDICATES],
  );
  const badPreds = PREDICATES.filter((name) => {
    const row = preds.find((r) => r.proname === name);
    return !row || row.provolatile !== 's' || !row.prosecdef;
  });
  if (badPreds.length === 0) {
    pass('visibility predicates are STABLE + SECURITY DEFINER', `${PREDICATES.length} functions`);
  } else {
    fail(
      'visibility predicates are STABLE + SECURITY DEFINER',
      `wrong or missing: ${badPreds.join(', ')}`,
    );
  }

  // A policy that re-reads the table it guards cannot see the row an
  // INSERT ... RETURNING is writing, and refuses the write (migration 0012).
  const { rows: selfReading } = await client.query<{ tablename: string; qual: string }>(
    `select tablename, qual from pg_policies
      where schemaname = 'public'
        and cmd = 'SELECT'
        and (
          (tablename = 'profiles' and qual like '%can_view_profile%')
          or (tablename = 'photos' and qual like '%can_view_photo%')
        )`,
  );
  if (selfReading.length === 0) {
    pass('no SELECT policy re-reads the table it guards');
  } else {
    fail(
      'no SELECT policy re-reads the table it guards',
      selfReading.map((r) => r.tablename).join(', '),
    );
  }

  // --- triggers -------------------------------------------------------------
  const { rows: trg } = await client.query<{ t: string }>(
    `select tgname as t from pg_trigger
     where not tgisinternal and tgrelid::regclass::text like 'users%' order by 1`,
  );
  const names = trg.map((r) => r.t);
  for (const want of ['users_gender_immutable', 'users_minimum_age', 'users_touch']) {
    if (names.includes(want)) pass(`trigger ${want}`);
    else fail(`trigger ${want}`, 'missing');
  }
}

/**
 * Behavioural RLS checks.
 *
 * Everything happens inside one transaction that is rolled back at the end,
 * including the seeded rows. `set local role` reverts with the transaction too.
 */
async function behavioural(client: Client): Promise<void> {
  await client.query('begin');
  try {
    // Can we impersonate at all? If not, say so rather than reporting a pass.
    try {
      await client.query(`set local role authenticated`);
      await client.query(`reset role`);
    } catch (error) {
      fail('can SET ROLE authenticated', (error as Error).message);
      return;
    }
    pass('can SET ROLE authenticated', 'behavioural checks can run');

    await client.query(
      `insert into public.reference_items (type, code, sort_order)
       values ('country', 'pk', 1) on conflict (type, code) do nothing`,
    );

    const mk = async (name: string): Promise<{ userId: string; authId: string }> => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.users (display_name, gender, date_of_birth, country_code, status)
         values ($1, 'female', date '1995-06-15', 'pk', 'active') returning id`,
        [name],
      );
      const userId = rows[0]!.id;
      const { rows: link } = await client.query<{ auth_user_id: string }>(
        `insert into public.user_auth_links (user_id, auth_user_id, provider)
         values ($1, gen_random_uuid(), 'email') returning auth_user_id`,
        [userId],
      );
      await client.query(`insert into public.user_settings (user_id) values ($1)`, [userId]);
      return { userId, authId: link[0]!.auth_user_id };
    };

    const alice = await mk('VerifyAlice');
    const bilal = await mk('VerifyBilal');

    /**
     * Runs sql as `role`, with `authId` as the JWT subject.
     *
     * Every probe gets its own SAVEPOINT. Most of these probes are SUPPOSED to
     * be denied, and in Postgres a failed statement aborts the whole
     * transaction — every later statement then fails with "current transaction
     * is aborted" regardless of what it asked. Rolling back to the savepoint
     * turns an expected denial back into a usable transaction.
     *
     * The rollback also reverts `set local role` and the claims GUC, and undoes
     * any write a probe made, so probes cannot influence each other.
     */
    const as = async <T extends QueryResultRow>(
      role: 'anon' | 'authenticated',
      authId: string | null,
      sql: string,
    ): Promise<{ rows: T[]; error?: string }> => {
      await client.query(`savepoint probe`);
      let out: { rows: T[]; error?: string };
      try {
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: authId, role }),
        ]);
        await client.query(`set local role ${role}`);
        const r = await client.query<T>(sql);
        out = { rows: r.rows };
      } catch (error) {
        out = { rows: [], error: (error as Error).message };
      }
      await client.query(`rollback to savepoint probe`);
      return out;
    };

    const expectRows = async (
      name: string,
      n: number,
      sql: string,
      role: 'anon' | 'authenticated',
      authId: string | null,
    ): Promise<void> => {
      const r = await as<Record<string, unknown>>(role, authId, sql);
      if (r.error) fail(name, `errored: ${r.error}`);
      else if (r.rows.length === n) pass(name, `${r.rows.length} row(s)`);
      else fail(name, `expected ${n} row(s), got ${r.rows.length}`);
    };

    const expectDenied = async (
      name: string,
      sql: string,
      role: 'anon' | 'authenticated',
      authId: string | null,
    ): Promise<void> => {
      const r = await as(role, authId, sql);
      if (r.error && /permission denied|row-level security/i.test(r.error)) {
        pass(name, r.error.split('\n')[0]!.slice(0, 70));
      } else if (r.error) {
        fail(name, `denied for the wrong reason: ${r.error}`);
      } else {
        fail(name, `ALLOWED — ${r.rows.length} row(s) affected`);
      }
    };

    await expectRows(
      'member reads own users row',
      1,
      `select id from public.users`,
      'authenticated',
      alice.authId,
    );
    await expectRows(
      'member cannot read another member',
      0,
      `select id from public.users where display_name = 'VerifyAlice'`,
      'authenticated',
      bilal.authId,
    );
    await expectDenied('anon cannot read users', `select id from public.users`, 'anon', null);
    await expectDenied(
      'member cannot change status (no column grant)',
      `update public.users set status = 'active'`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot clear profile_completed_at',
      `update public.users set profile_completed_at = null`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot soft-delete themselves',
      `update public.users set deleted_at = now()`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot grant themselves an entitlement',
      `insert into public.user_entitlements (user_id, entitlement_key, value)
       values (app.current_user_id(), 'who_viewed_me', 'true'::jsonb)`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot raise an entitlement they hold',
      `update public.user_entitlements set value = '999'::jsonb`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot fabricate a compatibility score',
      `insert into public.compatibility_scores
         (viewer_user_id, candidate_user_id, overall, engine_version)
       values (app.current_user_id(), app.current_user_id(), 100, '1.0.0')`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot place themselves in a candidate list',
      `insert into public.match_candidates
         (user_id, candidate_user_id, section_key, rank, batch_id)
       values (app.current_user_id(), app.current_user_id(), 'recommended', 0, gen_random_uuid())`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot read user_auth_links',
      `select user_id from public.user_auth_links`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot read user_consents',
      `select id from public.user_consents`,
      'authenticated',
      alice.authId,
    );
    await expectDenied(
      'member cannot write security_events',
      `insert into public.security_events (user_id, event_type) values ('${alice.userId}', 'sign_in')`,
      'authenticated',
      alice.authId,
    );
    await expectRows(
      'member updates own display_name',
      1,
      `update public.users set display_name = 'Renamed' returning id`,
      'authenticated',
      alice.authId,
    );
    await expectRows(
      'anon reads reference data',
      1,
      `select code from public.reference_items where code = 'pk'`,
      'anon',
      null,
    );
  } finally {
    await client.query('rollback');
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    console.error('DATABASE_URL is not set. See services/api/.env and docs/SUPABASE_SETUP.md.');
    process.exit(2);
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    application_name: 'nikahmate-verify',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to ${maskedTarget(url)}: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`Verifying ${maskedTarget(url)}\n`);

  try {
    // Recorded as failed checks rather than thrown, so a crash in one section
    // still prints the results of the other. A verifier that reports nothing
    // when something goes wrong is a verifier that tells you least exactly
    // when you need it most.
    try {
      await structural(client);
    } catch (error) {
      fail('structural checks', `crashed: ${(error as Error).message}`);
    }
    try {
      await behavioural(client);
    } catch (error) {
      fail('behavioural checks', `crashed: ${(error as Error).message}`);
      await client.query('rollback').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }

  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  PASS  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${c.name} — ${c.detail}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  if (failed > 0) {
    console.log('The live database does not match the migrations. Do not build on it yet.');
    process.exit(1);
  }
  console.log('The live schema matches the migrations, and nothing is exposed that should not be.');
}

main().catch((error: unknown) => {
  console.error(`verify failed: ${(error as Error).message}`);
  process.exit(1);
});
