import { defineConfig } from 'vitest/config';

/**
 * Timeouts sized for what these tests actually are.
 *
 * Every file here is an INTEGRATION test: `createHarness()` boots a real
 * Postgres in-process (PGlite), applies all 24 migrations, seeds reference
 * data and builds a Fastify app. That is seconds of work before the first
 * assertion, and the tests themselves drive multi-step flows — send an
 * interest, accept it, gate the match, approve it — each of which is several
 * round trips.
 *
 * Vitest's defaults are 5s per test and 10s per hook, which are sized for unit
 * tests. They were survivable while this suite ran alone and stopped being so
 * once the whole workspace ran in parallel: `pnpm test` runs six packages at
 * once, and a dismiss test that takes 1.4s idle took 6.1s under that load and
 * failed. Nothing was wrong with it.
 *
 * Raising the ceiling does not weaken any assertion — a test that is going to
 * fail still fails, it simply gets the time to finish first. The alternative
 * is a suite that fails on a loaded CI runner and passes on a laptop, which
 * teaches everyone to re-run it rather than read it.
 */
export default defineConfig({
  test: {
    // Generous per test, because each one is several HTTP round trips against
    // a real database rather than a function call.
    testTimeout: 30_000,
    // beforeAll builds the database from scratch: 24 migrations plus the
    // reference seed.
    hookTimeout: 180_000,
  },
});
