import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBLEM_CODES } from '@nikahmate/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

/**
 * docs/openapi.yaml against the running Fastify routes (code review Phase 4).
 *
 * Both directions: every route the server registers is documented, and every
 * documented operation is served — unless it is marked
 * `x-status: not-implemented`, in which case it must NOT be served, so the
 * day someone builds it this test asks for the marker to come off.
 *
 * Structural checks on the document itself: unique operationIds, every `$ref`
 * resolves, every path placeholder is a declared path parameter, every
 * operation has a success response, and every authenticated one documents
 * 401.
 *
 * This is a line-based reader of the document's own conventions (two-space
 * indentation, one key per line), not a general YAML parser or an OpenAPI
 * schema validator: the repository has no YAML parser as a direct
 * dependency. It fails loudly on a shape it does not recognise rather than
 * passing it.
 */

const SPEC_PATH = join(__dirname, '..', '..', '..', 'docs', 'openapi.yaml');
const spec = readFileSync(SPEC_PATH, 'utf8');
const lines = spec.split(/\r?\n/);

interface Operation {
  method: string;
  path: string;
  body: string[];
  operationId: string | undefined;
  notImplemented: boolean;
  blockedBy: string | undefined;
}

function readOperations(): Operation[] {
  const start = lines.indexOf('paths:');
  const end = lines.indexOf('components:');
  expect(start, 'paths: section').toBeGreaterThan(0);
  expect(end, 'components: section').toBeGreaterThan(start);

  const ops: Operation[] = [];
  let path: string | undefined;
  let current: Operation | undefined;
  for (const line of lines.slice(start + 1, end)) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      current = undefined;
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (methodMatch && path) {
      current = {
        method: methodMatch[1]!.toUpperCase(),
        path,
        body: [],
        operationId: undefined,
        notImplemented: false,
        blockedBy: undefined,
      };
      ops.push(current);
      continue;
    }
    // A path-level key other than an operation ends the current operation.
    if (/^ {4}\S/.test(line)) current = undefined;
    if (!current) continue;
    current.body.push(line);
    const id = /^ {6}operationId: (\S+)\s*$/.exec(line);
    if (id) current.operationId = id[1];
    if (/^ {6}x-status: not-implemented\s*$/.test(line)) current.notImplemented = true;
    const blocked = /^ {6}x-blocked-by: (.+)$/.exec(line);
    if (blocked) current.blockedBy = blocked[1];
  }
  return ops;
}

/** Fastify's route tree, flattened: "METHOD /path/{}" with placeholders anonymised. */
function readRoutes(tree: string): Set<string> {
  const routes = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split(/\r?\n/)) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const full = (stack[depth - 1] ?? '') + m[2]!;
    stack[depth] = full;
    for (const method of (m[3] ?? '').split(',').map((x) => x.trim())) {
      if (!method || method === 'HEAD' || method === 'OPTIONS') continue;
      routes.add(`${method} ${full.replace(/:\w+/g, '{}')}`);
    }
  }
  return routes;
}

const key = (op: Operation): string => `${op.method} ${op.path.replace(/\{\w+\}/g, '{}')}`;

let harness: TestHarness;
let routes: Set<string>;
const ops = readOperations();

beforeAll(async () => {
  harness = await createHarness();
  routes = readRoutes(harness.app.printRoutes({ commonPrefix: false }));
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('docs/openapi.yaml and the running routes', () => {
  it('reads a plausible number of operations and routes (the readers work)', () => {
    expect(ops.length).toBeGreaterThan(100);
    expect(routes.size).toBeGreaterThan(90);
    expect(routes).toContain('GET /me');
    expect(routes).toContain('DELETE /me/photos/{}');
  });

  it('documents every route the server registers', () => {
    const documented = new Set(ops.map(key));
    expect([...routes].filter((r) => !documented.has(r)).sort()).toEqual([]);
  });

  it('serves every documented operation not marked not-implemented', () => {
    const missing = ops.filter((op) => !op.notImplemented && !routes.has(key(op))).map(key);
    expect(missing.sort()).toEqual([]);
  });

  it('serves every path the api-client package calls (client compatibility)', () => {
    const client = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'api-client', 'src', 'client.ts'),
      'utf8',
    );
    const calls = [
      ...client.matchAll(/\b(get|post|put|patch|delete)\b(?:<[^>]*>)?\(\s*[`']([^`']+)[`']/g),
    ].map((m) => `${m[1]!.toUpperCase()} ${m[2]!.replace(/\$\{[^}]+\}/g, '{}').split('?')[0]}`);
    expect(calls.length).toBeGreaterThan(50);
    expect(calls.filter((c) => !routes.has(c))).toEqual([]);
  });

  it('does NOT serve an operation marked not-implemented, and each names its blocker', () => {
    const marked = ops.filter((op) => op.notImplemented);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.filter((op) => routes.has(key(op))).map(key)).toEqual([]);
    expect(marked.filter((op) => !op.blockedBy || op.blockedBy.length < 10).map(key)).toEqual([]);
  });
});

describe('docs/openapi.yaml structure', () => {
  it('gives every operation a unique operationId', () => {
    const ids = ops.map((op) => op.operationId);
    expect(ids.filter((id) => id === undefined)).toEqual([]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('resolves every $ref to a declared component', () => {
    const declared = new Set<string>();
    let section: string | undefined;
    for (const line of lines.slice(lines.indexOf('components:') + 1)) {
      const sec = /^ {2}(\w+):\s*$/.exec(line);
      if (sec) section = sec[1];
      const name = /^ {4}(\w+):/.exec(line);
      if (name && section) declared.add(`#/components/${section}/${name[1]}`);
    }
    const refs = [...spec.matchAll(/\$ref: '([^']+)'/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(100);
    expect([...new Set(refs.filter((r) => !declared.has(r)))]).toEqual([]);
  });

  it('declares every path placeholder as a path parameter', () => {
    const componentPathParams = new Map<string, string>();
    const comp = lines.slice(lines.indexOf('  parameters:', lines.indexOf('components:')));
    let name: string | undefined;
    let paramName: string | undefined;
    for (const line of comp) {
      if (/^ {2}\w+:\s*$/.test(line) && !line.startsWith('  parameters:')) break;
      const head = /^ {4}(\w+):\s*$/.exec(line);
      if (head) {
        name = head[1];
        paramName = undefined;
      }
      const n = /^ {6}name: (\S+)/.exec(line);
      if (n) paramName = n[1];
      if (/^ {6}in: path/.test(line) && name && paramName) componentPathParams.set(name, paramName);
    }

    const problems: string[] = [];
    for (const op of ops) {
      const text = op.body.join('\n');
      const declared = new Set<string>();
      for (const m of text.matchAll(/name: (\w+), in: path/g)) declared.add(m[1]!);
      for (const m of text.matchAll(/name: (\w+)\n\s+in: path/g)) declared.add(m[1]!);
      for (const m of text.matchAll(/#\/components\/parameters\/(\w+)/g)) {
        const p = componentPathParams.get(m[1]!);
        if (p) declared.add(p);
      }
      for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
        if (!declared.has(m[1]!)) problems.push(`${key(op)} (${op.path}): {${m[1]}} undeclared`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every operation a success response, and every authenticated one a 401', () => {
    const problems: string[] = [];
    for (const op of ops) {
      const text = op.body.join('\n');
      if (!/^ {8}'2\d\d':/m.test(text)) problems.push(`${key(op)} ${op.path}: no 2xx`);
      const isPublic = /^ {6}security: \[\]/m.test(text);
      if (!isPublic && !/^ {8}'401':/m.test(text)) problems.push(`${key(op)} ${op.path}: no 401`);
    }
    expect(problems).toEqual([]);
  });

  it('lists exactly the problem codes the server emits (PROBLEM_CODES)', () => {
    const block = /code:\r?\n\s+type: string\r?\n[^\n]*\n\s+enum: \[([^\]]+)\]/.exec(spec);
    expect(block, 'Problem.code enum').not.toBeNull();
    const documented = block![1]!.split(',').map((c) => c.trim());
    expect([...documented].sort()).toEqual([...PROBLEM_CODES].sort());
  });
});
