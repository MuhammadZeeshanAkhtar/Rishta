import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { databaseConnection, explainTlsFailure } from '../src/db/tls';

/**
 * Stage 2, Priority 4: how database connections are secured.
 *
 * The handshake tests use the real `pg` client against a real TLS listener speaking
 * the start of the Postgres protocol, with a certificate generated for the run. That
 * is a real certificate check, by the same code production uses. Nothing here
 * connects to a real database or to anything off this machine.
 */

const REMOTE = 'postgresql://user:p%40ss@db.example.test:5432/postgres';
const LOCAL = 'postgresql://postgres:postgres@localhost:5432/postgres';

describe('what each configuration asks for', () => {
  it('a remote database is verified by default', () => {
    expect(databaseConnection(REMOTE, {})).toMatchObject({
      mode: 'verify-full',
      ssl: { rejectUnauthorized: true },
    });
  });

  it.each([
    'postgresql://u:p@localhost:5432/db',
    'postgresql://u:p@127.0.0.1:5432/db',
    'postgresql://u:p@[::1]:5432/db',
    'postgresql://u:p@db.localhost:5432/db',
  ])('local development needs no TLS and no setup: %s', (url) => {
    expect(databaseConnection(url, {})).toMatchObject({ mode: 'disable', ssl: false });
  });

  it.each(['postgresql://u:p@localhost.evil.test/db', 'postgresql://u:p@127.0.0.1.evil.test/db'])(
    'a host that only looks local is not: %s',
    (url) => {
      expect(databaseConnection(url, {}).mode).toBe('verify-full');
    },
  );

  it('a CA can be given as text, with or without escaped newlines', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const escaped = pem.replace(/\n/g, '\\n');
    expect(databaseConnection(REMOTE, { DATABASE_SSL_CA: pem }).ssl).toEqual({
      rejectUnauthorized: true,
      ca: pem,
    });
    expect(databaseConnection(REMOTE, { DATABASE_SSL_CA: escaped }).ssl).toEqual({
      rejectUnauthorized: true,
      ca: pem,
    });
  });

  it('a CA that is neither text nor a file stops the start rather than being ignored', () => {
    expect(() => databaseConnection(REMOTE, { DATABASE_SSL_CA: '/no/such/ca.pem' })).toThrow(
      /neither PEM text nor a file/,
    );
  });

  it('require is available to a developer who asks for it by name', () => {
    expect(databaseConnection(REMOTE, { DATABASE_SSL_MODE: 'require' }).ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it.each(['require', 'disable'])('%s is refused for a remote database in production', (mode) => {
    expect(() =>
      databaseConnection(REMOTE, { NODE_ENV: 'production', DATABASE_SSL_MODE: mode }),
    ).toThrow(/refused in production/);
  });

  it('production against a local database is still fine: it is not on the network', () => {
    expect(databaseConnection(LOCAL, { NODE_ENV: 'production' }).ssl).toBe(false);
  });

  it('an unknown mode stops the start', () => {
    expect(() => databaseConnection(REMOTE, { DATABASE_SSL_MODE: 'off' })).toThrow(
      /must be one of/,
    );
  });

  it('a bad URL is reported without repeating it, because it holds the password', () => {
    expect(() => databaseConnection('not a url with s3cret', {})).toThrow(
      /^DATABASE_URL is not a valid connection string$/,
    );
  });

  it.each([
    'sslmode=no-verify',
    'sslmode=disable',
    'ssl=false',
    'sslrootcert=/tmp/x',
    'uselibpqcompat=true',
    'sslmode=no-verify&application_name=x',
  ])('?%s on the URL cannot weaken it', (query) => {
    const { connectionString, ssl } = databaseConnection(`${REMOTE}?${query}`, {});
    expect(connectionString).not.toMatch(/ssl|uselibpqcompat/i);
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(new pg.Pool({ connectionString, ssl }).options.ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('other URL parameters, and the password, survive', () => {
    const { connectionString } = databaseConnection(
      `${REMOTE}?sslmode=require&application_name=x`,
      {},
    );
    const parsed = new URL(connectionString);
    expect(parsed.searchParams.get('application_name')).toBe('x');
    expect(parsed.password).toBe('p%40ss');
  });
});

describe('the settings reach the service', () => {
  const env = {
    DATABASE_URL: REMOTE,
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_JWT_SECRET: 'a-long-enough-secret-for-config',
  };

  it('the configuration accepts them, and refuses a mode that does not exist', () => {
    expect(loadConfig({ ...env, DATABASE_SSL_MODE: 'require' }).DATABASE_SSL_MODE).toBe('require');
    expect(() => loadConfig({ ...env, DATABASE_SSL_MODE: 'off' })).toThrow(/DATABASE_SSL_MODE/);
  });

  it('no script still turns verification off', () => {
    const dir = join(__dirname, '..', 'scripts');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /rejectUnauthorized/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every script and the pool go through the one helper', () => {
    const uses = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
    for (const script of [
      'scripts/migrate.ts',
      'scripts/verify-db.ts',
      'scripts/maintenance.ts',
      'scripts/seed-demo.ts',
      'scripts/legacy-content.ts',
      'src/db/pg.ts',
    ]) {
      expect(uses(script), script).toContain('databaseConnection(');
    }
  });
});

const openssl = spawnSync('openssl', ['version']).status === 0;

describe.skipIf(!openssl)('a real TLS handshake, with the real client', () => {
  let dir: string;
  let ca: string;
  let server: Server;
  let port: number;

  // After a handshake the client sends its startup message; answering with a
  // Postgres error is enough to prove the handshake got that far.
  const POSTGRES_ERROR = (() => {
    const fields = Buffer.from('SFATAL\0C28000\0Mhandshake reached the server\0\0', 'latin1');
    const header = Buffer.alloc(5);
    header.write('E', 0, 'latin1');
    header.writeUInt32BE(fields.length + 4, 1);
    return Buffer.concat([header, fields]);
  })();

  const listen = (handler: (socket: Socket) => void) =>
    new Promise<{ server: Server; port: number }>((resolve) => {
      const s = createServer(handler);
      s.listen(0, '127.0.0.1', () =>
        resolve({ server: s, port: (s.address() as AddressInfo).port }),
      );
    });

  // A config file of its own, because not every openssl has a default one to find.
  const openSslConfig = () => {
    const path = join(dir, 'openssl.cnf');
    writeFileSync(path, '[req]\ndistinguished_name=dn\n[dn]\n');
    return path;
  };

  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });

  const generate = (name: string, san: string, signWith?: string) => {
    const key = join(dir, `${name}.key`);
    const cert = join(dir, `${name}.crt`);
    const subject = ['-subj', `/CN=${name}`, '-config', openSslConfig()];
    if (!signWith) {
      run([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '2',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        ...subject,
      ]);
      return;
    }
    const csr = join(dir, `${name}.csr`);
    const ext = join(dir, `${name}.ext`);
    writeFileSync(ext, `subjectAltName=${san}\n`);
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, ...subject]);
    run([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      join(dir, `${signWith}.crt`),
      '-CAkey',
      join(dir, `${signWith}.key`),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '2',
      '-extfile',
      ext,
    ]);
  };

  const speakingTls = (certName: string) => (socket: Socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('S');
      const secure = new TLSSocket(socket, {
        isServer: true,
        key: readFileSync(join(dir, `${certName}.key`)),
        cert: readFileSync(join(dir, `${certName}.crt`)),
      });
      secure.on('error', () => {});
      secure.once('data', () => secure.end(POSTGRES_ERROR));
    });
  };

  const attempt = async (
    targetPort: number,
    env: { DATABASE_SSL_MODE?: string; DATABASE_SSL_CA?: string },
    query = '',
    host = 'localhost',
  ): Promise<string> => {
    const client = new pg.Client({
      ...databaseConnection(`postgresql://u:secret@${host}:${targetPort}/db${query}`, env),
      connectionTimeoutMillis: 5000,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      return 'connected';
    } catch (error) {
      return `${(error as { code?: string }).code ?? ''} ${(error as Error).message}`;
    } finally {
      await client.end().catch(() => {});
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nikahmate-tls-'));
    generate('ca', '');
    generate('good', 'DNS:localhost', 'ca');
    generate('wrong-host', 'DNS:db.example.test', 'ca');
    ca = readFileSync(join(dir, 'ca.crt'), 'utf8');
    ({ server, port } = await listen(speakingTls('good')));
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  it('with the right CA the handshake succeeds and reaches the server', async () => {
    const result = await attempt(port, { DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA: ca });
    expect(result).toContain('handshake reached the server');
  });

  it('with no CA an unknown certificate is refused, which is the attack this stops', async () => {
    const result = await attempt(port, { DATABASE_SSL_MODE: 'verify-full' });
    expect(result).not.toContain('handshake reached the server');
    expect(result).toMatch(/self.signed|unable to (get|verify)|SELF_SIGNED|UNABLE_TO/i);
  });

  it('with a different CA it is refused too', async () => {
    generate('other-ca', '');
    const result = await attempt(port, {
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA: readFileSync(join(dir, 'other-ca.crt'), 'utf8'),
    });
    expect(result).not.toContain('handshake reached the server');
  });

  it('a certificate from the right CA for another host is refused', async () => {
    const other = await listen(speakingTls('wrong-host'));
    try {
      const result = await attempt(other.port, {
        DATABASE_SSL_MODE: 'verify-full',
        DATABASE_SSL_CA: ca,
      });
      expect(result).not.toContain('handshake reached the server');
      expect(result).toMatch(/ALTNAME|does not match|altnames/i);
    } finally {
      await new Promise((resolve) => other.server.close(resolve));
    }
  });

  it('?sslmode=no-verify on the URL does not get past it', async () => {
    const result = await attempt(port, { DATABASE_SSL_MODE: 'verify-full' }, '?sslmode=no-verify');
    expect(result).not.toContain('handshake reached the server');
  });

  it('a server that refuses TLS is not silently used in plain text', async () => {
    const plain = await listen((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.write('N'));
    });
    try {
      const result = await attempt(plain.port, {
        DATABASE_SSL_MODE: 'verify-full',
        DATABASE_SSL_CA: ca,
      });
      expect(result).toMatch(/does not support SSL/i);
    } finally {
      await new Promise((resolve) => plain.server.close(resolve));
    }
  });

  it('require encrypts without checking: what the old scripts did, now by name only', async () => {
    const result = await attempt(port, { DATABASE_SSL_MODE: 'require' });
    expect(result).toContain('handshake reached the server');
  });

  it('a failed check says what to do, without the URL or password', () => {
    const advice = explainTlsFailure({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' });
    expect(advice).toMatch(/DATABASE_SSL_CA/);
    expect(advice).not.toMatch(/secret/);
    expect(explainTlsFailure(new Error('password authentication failed'))).toBeNull();
  });
});
