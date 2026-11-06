import { assertNoForbiddenSecrets, loadConfig } from './config';
import { buildApp } from './app';
import { createPgDb } from './db/pg';
import { createTokenVerifier } from './auth/verify';
import { createStorageClient } from './storage/client';
import { flushSentry, initSentry } from './observability/sentry';
import type { ServiceRoleUse } from './db/types';

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
      // Every RLS bypass can leave a trace: "the server read this because
      // account.bootstrap" is an audit trail; "the server read this" is not.
      //
      // REVIEW B26. At `info` this wrote a line for every service-role use —
      // several per request — which is most of the log volume. It is a DEBUG
      // trace now, written only when LOG_LEVEL asks for debug output, e.g.
      // while investigating an incident.
      if (config.LOG_LEVEL !== 'debug' && config.LOG_LEVEL !== 'trace') return;
      process.stdout.write(
        `${JSON.stringify({ level: 'debug', msg: 'service_role_use', use, at: new Date().toISOString() })}\n`,
      );
    },
  });

  // Storage is called with each caller's own JWT, so this client holds no
  // credential of its own beyond the project's public identifier.
  const storage = createStorageClient({
    supabaseUrl: config.SUPABASE_URL,
    publishableKey: config.SUPABASE_PUBLISHABLE_KEY ?? '',
  });

  const app = await buildApp({
    config,
    db,
    verifier: createTokenVerifier(config),
    storage,
  });

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
