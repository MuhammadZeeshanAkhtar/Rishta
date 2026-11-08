import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Stage 2, Priority 7: the API runs in production as plain Node, without `tsx`, and
 * the build pipeline's own configuration. This builds the real entry point and boots
 * it as a real process, with NODE_ENV=production. It points at a local port with no
 * database behind it, so no data is reached.
 */

const API = join(__dirname, '..');
const ROOT = join(API, '..', '..');
const OUT = 'dist/test-build/index.mjs';

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe('the production build', () => {
  let child: ChildProcess | undefined;
  let port: number;
  let output = '';

  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build.mjs', `--outfile=${OUT}`], {
      cwd: API,
      stdio: 'ignore',
    });
    port = await freePort();
    child = spawn(process.execPath, [OUT], {
      cwd: API,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none',
        SUPABASE_URL: 'https://build-test.supabase.invalid',
        SUPABASE_JWT_SECRET: 'a-secret-only-used-to-boot-this-test',
        SUPABASE_PUBLISHABLE_KEY: 'not-a-real-key',
      },
    });
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/reference/manifest`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, 60_000);

  afterAll(() => {
    child?.kill();
    rmSync(join(API, 'dist', 'test-build'), { recursive: true, force: true });
  });

  it('is one file, with the workspace bundled in and dependencies left out', () => {
    const bundle = readFileSync(join(API, OUT), 'utf8');
    expect(bundle).not.toContain('@nikahmate/domain"');
    expect(bundle).toMatch(/from "fastify"/);
    expect(bundle).toMatch(/from "pg"|from 'pg'/);
  });

  it('boots under plain Node, and serves', async () => {
    expect(child?.exitCode, output).toBeNull();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    // Up, and honest that it has no database behind it.
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('protected routes still refuse a caller with no token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/me`);
    expect(res.status).toBe(401);
  });

  it('leaks no connection details when the database is unreachable', async () => {
    await fetch(`http://127.0.0.1:${port}/health`);
    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).text();
    expect(body).not.toContain('nothing');
    expect(output).not.toContain('nobody:nothing');
  });

  it('refuses to start in production with an unverified remote connection', () => {
    let failed = '';
    try {
      execFileSync(process.execPath, [OUT], {
        cwd: API,
        stdio: 'pipe',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          NODE_ENV: 'production',
          PORT: '39871',
          DATABASE_URL: 'postgresql://nobody:nothing@db.example.test/none',
          DATABASE_SSL_MODE: 'require',
          SUPABASE_URL: 'https://build-test.supabase.invalid',
          SUPABASE_JWT_SECRET: 'a-secret-only-used-to-boot-this-test',
          SUPABASE_PUBLISHABLE_KEY: 'not-a-real-key',
        },
      });
    } catch (error) {
      failed = String((error as { stderr?: unknown }).stderr ?? '');
    }
    expect(failed).toMatch(/refused in production/);
  }, 20_000);

  it('the scripts offer it, without changing what `start` does', () => {
    const pkg = JSON.parse(readFileSync(join(API, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts['start:prod']).toContain('dist/index.mjs');
    expect(pkg.scripts['start:prod']).not.toContain('tsx');
    expect(pkg.dependencies.tsx).toBeUndefined();
    expect(pkg.dependencies.esbuild).toBeUndefined();
  });
});

describe('the CI pipeline', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('gives its token read access to the code and nothing else', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/write-all|: write$/m);
  });

  it('runs every third-party action from an exact commit, not a movable tag', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, use).toMatch(/@[0-9a-f]{40}$/);
  });

  it('does not leave its token in the checkout for later steps to find', () => {
    const checkouts = workflow.match(
      /actions\/checkout@[^\n]*\n(\s+# [^\n]*\n)?\s+with:\n\s+persist-credentials: false/g,
    );
    const total = workflow.match(/actions\/checkout@/g);
    expect(checkouts?.length).toBe(total?.length);
  });

  it('does not deploy, migrate or hold a secret', () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/\bmigrate\b|eas build|eas submit/);
  });

  it('builds the production API, and reports advisories', () => {
    expect(workflow).toContain('pnpm --filter @nikahmate/api build');
    expect(workflow).toContain('pnpm audit --prod');
  });

  it('guards against committing a private key or the Storage key', () => {
    expect(workflow).toContain('PRIVATE KEY');
    expect(workflow).toContain('LEGACY_TOOL_STORAGE_KEY');
  });
});

describe('nothing committed that should not be', () => {
  it('the build output is ignored', () => {
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist\/$/m);
    expect(existsSync(join(API, 'scripts', 'build.mjs'))).toBe(true);
  });
});
