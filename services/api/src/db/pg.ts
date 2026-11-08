import pg from 'pg';
import { databaseConnection, type DatabaseTlsEnv } from './tls';
import type { Db, DbSession, ServiceRoleUse, ServiceUseRecorder } from './types';

/**
 * Production database access over node-postgres.
 *
 * Every path opens a transaction and uses `SET LOCAL`, so the role and the JWT
 * claims are scoped to that transaction and cannot leak into whichever request
 * next borrows the connection from the pool. A leaked `api_member` role on a
 * pooled connection is the kind of bug that looks like it works.
 */

export interface PgDbOptions {
  connectionString: string;
  /** TLS settings; see ./tls.ts. Defaults to the process environment. */
  tls?: DatabaseTlsEnv;
  max?: number;
  onServiceUse?: ServiceUseRecorder;
}

export function createPgDb(options: PgDbOptions): Db {
  const { connectionString, ssl } = databaseConnection(options.connectionString, options.tls);
  const pool = new pg.Pool({
    connectionString,
    ssl,
    // Deliberately small. One API instance in front of Supabase's pooler
    // (Supavisor) in transaction mode — a large pool here just exhausts the
    // upstream one (R10).
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  async function inTransaction<T>(
    setup: (client: pg.PoolClient) => Promise<void>,
    fn: (session: DbSession) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await setup(client);

      const session: DbSession = {
        async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
          const result = await client.query(sql, params as never[]);
          return result.rows as R[];
        },
      };

      const value = await fn(session);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => {
        // The rollback failing means the connection is already broken; the
        // original error is the useful one, so do not mask it.
      });
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    asUser(authUserId, fn) {
      return inTransaction(async (client) => {
        const claims = JSON.stringify({ sub: authUserId, role: 'authenticated' });
        await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
        // Review B7: not `authenticated`, which the Data API can reach. See migration
        // 0033. The claims still say `authenticated`: that is the JWT's own role.
        await client.query('set local role api_member');
      }, fn);
    },

    asAnon(fn) {
      return inTransaction(async (client) => {
        await client.query('select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify({ role: 'anon' }),
        ]);
        await client.query('set local role anon');
      }, fn);
    },

    asService(use: ServiceRoleUse, fn) {
      options.onServiceUse?.(use);
      return inTransaction(async (client) => {
        await client.query('set local role service_role');
      }, fn);
    },

    async close() {
      await pool.end();
    },
  };
}
