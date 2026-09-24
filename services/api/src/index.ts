import { assertNoForbiddenSecrets, loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPgDb } from './db/pg.js';
import { createTokenVerifier } from './auth/verify.js';
import { flushSentry, initSentry } from './observability/sentry.js';
import type { ServiceRoleUse } from './db/types.js';

/**
 * Entry point. Nothing here is importable by tests — `buildApp` is the seam,
 * so the process lifecycle and the application are separable concerns.
 */
async function main(): Promise<void> {
  assertNoForbiddenSecrets();
  const config = loadConfig();
  initSentry(config);

  const db = createPgDb({
    connectionString: config.DATABASE_URL,
    onServiceUse: (use: ServiceRoleUse) => {
      // Every RLS bypass leaves a trace. "The server read this" is not an
      // audit trail; "the server read this because account.bootstrap" is.
      process.stdout.write(
        `${JSON.stringify({ level: 'info', msg: 'service_role_use', use, at: new Date().toISOString() })}\n`,
      );
    },
  });

  const app = await buildApp({ config, db, verifier: createTokenVerifier(config) });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await db.close();
      await flushSentry();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  // Startup failures must be loud and must not leave a half-started process
  // holding a database connection.
  process.stderr.write(`Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
