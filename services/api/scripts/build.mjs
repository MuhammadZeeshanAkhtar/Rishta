/**
 * Builds the API into one JavaScript file, so production runs plain Node.
 *
 *   pnpm --filter @nikahmate/api build
 *   pnpm --filter @nikahmate/api start:prod
 *
 * `pnpm start` runs TypeScript through `tsx`, which is a development tool: it is a
 * devDependency, so a production install does not even have it, and it would mean
 * shipping a compiler and transpiling on every start. The workspace packages ship as
 * TypeScript source, so they are bundled in. Everything else stays an ordinary runtime
 * dependency, which is what keeps native modules such as `sharp` working.
 *
 * `--outfile=<path>` builds elsewhere, for the test that boots the result.
 */

import { build } from 'esbuild';

const outfile =
  process.argv.find((arg) => arg.startsWith('--outfile='))?.split('=')[1] ?? 'dist/index.mjs';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile,
  sourcemap: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'bundle-only-the-workspace',
      setup(context) {
        context.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@nikahmate/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
