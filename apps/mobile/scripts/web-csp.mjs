/**
 * The Content-Security-Policy for the web build, which includes the staff console.
 *
 * A web session lives in browser storage, where any script on the page can read it,
 * so stopping unexpected script from running at all is what protects it. The policy
 * allows script only from this site's own origin, and network calls only to the API
 * and Supabase. `style-src` allows inline styles because react-native-web injects its
 * stylesheet at runtime and the exported page has an inline reset. Inline style cannot
 * run code.
 *
 * Kept free of Expo and React so it can be tested directly.
 */

import { URL } from 'node:url';

function originOf(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL, so the web build cannot be given a policy`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be an http or https URL`);
  }
  return url;
}

/**
 * Why these addresses cannot be published, or an empty list if they can. A web build
 * bakes them in, and the developer `.env` points the API at localhost, so an export from
 * a normal checkout would publish a site that calls each visitor's own machine.
 *
 * @param {{ supabaseUrl: string, apiBaseUrl: string }} config
 * @returns {string[]}
 */
export function releaseAddressProblems({ supabaseUrl, apiBaseUrl }) {
  const problems = [];
  for (const [name, value] of [
    ['EXPO_PUBLIC_SUPABASE_URL', supabaseUrl],
    ['EXPO_PUBLIC_API_BASE_URL', apiBaseUrl],
  ]) {
    const url = originOf(name, value);
    // URL keeps the brackets on IPv6, and writes IPv4 tricks such as 127.1 in full.
    const local =
      /^(localhost|.*\.localhost|.*\.local|.*\.test|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;
    if (local.test(url.hostname)) problems.push(`${name} is a local or test address`);
    else if (url.protocol !== 'https:') problems.push(`${name} is not https`);
  }
  return problems;
}

/**
 * @param {{ supabaseUrl: string, apiBaseUrl: string }} config
 * @returns {string} The policy, as one header value.
 */
export function buildCsp({ supabaseUrl, apiBaseUrl }) {
  const supabase = originOf('EXPO_PUBLIC_SUPABASE_URL', supabaseUrl);
  const api = originOf('EXPO_PUBLIC_API_BASE_URL', apiBaseUrl);
  // Chat's live updates: Supabase Realtime, over a websocket.
  const realtime = `${supabase.protocol === 'https:' ? 'wss:' : 'ws:'}//${supabase.host}`;

  const connect = [...new Set(["'self'", api.origin, supabase.origin, realtime])];
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    // Signed photo URLs come from Supabase Storage. `blob:` shows a picked photo
    // before it is uploaded.
    `img-src 'self' data: blob: ${supabase.origin}`,
    `font-src 'self' data:`,
    `connect-src ${connect.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');
}

/**
 * The page with the policy added as its first head element, so it applies before
 * anything else is read. Refuses a page it cannot place it in rather than publishing
 * one with no policy.
 *
 * @param {string} html
 * @param {string} csp
 * @returns {string}
 */
export function injectCsp(html, csp) {
  if (html.includes('Content-Security-Policy')) {
    throw new Error('This page already has a Content-Security-Policy');
  }
  if (!/<head[^>]*>/i.test(html)) {
    throw new Error('This page has no <head> to put a Content-Security-Policy in');
  }
  const attribute = csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return html.replace(
    /<head[^>]*>/i,
    (head) => `${head}\n    <meta http-equiv="Content-Security-Policy" content="${attribute}" />`,
  );
}

/**
 * Response headers for a host that can set them, which is stronger than the meta tag:
 * `frame-ancestors` and HSTS only work as real headers. Netlify and Cloudflare Pages
 * read this file format. On any other host, set the same headers there.
 *
 * @param {string} csp
 * @returns {string}
 */
export function securityHeadersFile(csp) {
  return [
    '/*',
    `  Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '',
  ].join('\n');
}
