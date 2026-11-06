import { existsSync, readFileSync } from 'node:fs';

/**
 * How every connection to Postgres is secured: the API's pool and every script.
 *
 * The pool set no TLS option at all, so it was encrypted only if the URL happened
 * to ask for it. Four scripts set `rejectUnauthorized: false`, which encrypts but
 * accepts any certificate, so anyone able to intercept the connection could read
 * the database password and every query. They did that because Supabase signs its
 * certificates with its own CA, which is not in Node's trust store.
 *
 *   verify-full  (default for any non-local host) encrypted, and the certificate
 *                must chain to a trusted CA and match the host. Against Supabase
 *                that means providing the project's CA in DATABASE_SSL_CA.
 *   require      encrypted, certificate not checked. Must be asked for by name,
 *                and refused when NODE_ENV=production.
 *   disable      not encrypted. The default for localhost only. Anywhere else it
 *                must be asked for by name, and refused when NODE_ENV=production.
 *
 * `ssl*` parameters on the URL are removed. node-postgres lets them OVERRIDE the
 * `ssl` option it is given, so `?sslmode=no-verify` in a pasted connection string
 * would otherwise switch verification off without anyone deciding to.
 */

export const DATABASE_SSL_MODES = ['verify-full', 'require', 'disable'] as const;
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

export interface DatabaseTlsEnv {
  NODE_ENV?: string | undefined;
  DATABASE_SSL_MODE?: string | undefined;
  /** The CA as PEM text (`\n` escapes allowed), or the path of a PEM file. */
  DATABASE_SSL_CA?: string | undefined;
}

export type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string };

export interface DatabaseConnection {
  connectionString: string;
  ssl: DatabaseSsl;
  mode: DatabaseSslMode;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|[^.]+\.localhost)$/i;

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    // Never echo the value: it holds the database password.
    throw new Error('DATABASE_URL is not a valid connection string');
  }
}

/** Without `ssl*` parameters, which would otherwise override the `ssl` option. */
function withoutSslParameters(url: URL): string {
  for (const key of [...url.searchParams.keys()]) {
    if (/^ssl|^uselibpqcompat$/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function readCa(value: string): string {
  const inline = value.replace(/\\n/g, '\n').trim();
  if (inline.startsWith('-----BEGIN')) return inline;
  if (!existsSync(value)) {
    throw new Error('DATABASE_SSL_CA is neither PEM text nor a file that exists');
  }
  return readFileSync(value, 'utf8');
}

/**
 * The settings for one connection. Throws, rather than connecting less safely,
 * when the configuration asks for something production must not do.
 */
export function databaseConnection(
  url: string,
  env: DatabaseTlsEnv = process.env,
): DatabaseConnection {
  const parsed = parseUrl(url);
  const isLocal = LOCAL_HOST.test(parsed.hostname);
  const asked = env.DATABASE_SSL_MODE?.trim() || undefined;

  if (asked !== undefined && !(DATABASE_SSL_MODES as readonly string[]).includes(asked)) {
    throw new Error(`DATABASE_SSL_MODE must be one of: ${DATABASE_SSL_MODES.join(', ')}`);
  }
  const mode = (asked ?? (isLocal ? 'disable' : 'verify-full')) as DatabaseSslMode;

  if (mode !== 'verify-full' && !isLocal && env.NODE_ENV === 'production') {
    throw new Error(
      `DATABASE_SSL_MODE=${mode} is refused in production: the certificate must be verified`,
    );
  }

  const connectionString = withoutSslParameters(parsed);
  if (mode === 'disable') return { connectionString, ssl: false, mode };
  if (mode === 'require') return { connectionString, ssl: { rejectUnauthorized: false }, mode };

  const ca = env.DATABASE_SSL_CA?.trim();
  return {
    connectionString,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca: readCa(ca) } : {}) },
    mode,
  };
}

/** What a failed connection most likely means, without the URL or its password. */
export function explainTlsFailure(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  const text = String((error as { message?: unknown } | null)?.message ?? '');
  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    /self.signed|unable to verify|does not support ssl/i.test(text)
  ) {
    return (
      'The database certificate could not be verified. For Supabase, download the CA from ' +
      'Project Settings -> Database -> SSL Configuration and set DATABASE_SSL_CA. ' +
      'See docs/SUPABASE_SETUP.md.'
    );
  }
  return null;
}
