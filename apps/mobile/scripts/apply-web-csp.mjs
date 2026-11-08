/**
 * Adds the Content-Security-Policy to an exported web build. Runs after
 * `expo export`, because the policy names the API and Supabase addresses, which
 * differ per environment. Fails the build rather than publishing a page without one,
 * or a page that calls a local or test address.
 *
 *   node scripts/apply-web-csp.mjs [output directory, default: dist] [--allow-local]
 *
 * `--allow-local` is for trying an export on this machine. `web:export:local` passes it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCsp, injectCsp, releaseAddressProblems, securityHeadersFile } from './web-csp.mjs';

const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');
const dir = args.find((arg) => !arg.startsWith('--')) ?? 'dist';
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

if (!supabaseUrl || !apiBaseUrl) {
  console.error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_API_BASE_URL are both required.');
  process.exit(2);
}

if (!allowLocal) {
  const problems = releaseAddressProblems({ supabaseUrl, apiBaseUrl });
  if (problems.length > 0) {
    console.error(`This build cannot be published:\n  ${problems.join('\n  ')}`);
    console.error(
      'Set the production addresses in the environment, or run web:export:local to try it locally.',
    );
    process.exit(2);
  }
}

const csp = buildCsp({ supabaseUrl, apiBaseUrl });
const page = join(dir, 'index.html');
writeFileSync(page, injectCsp(readFileSync(page, 'utf8'), csp));
writeFileSync(join(dir, '_headers'), securityHeadersFile(csp));
console.log(
  `Content-Security-Policy added to ${page}; response headers written to ${dir}/_headers`,
);
