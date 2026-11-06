export function releaseAddressProblems(config: {
  supabaseUrl: string;
  apiBaseUrl: string;
}): string[];
export function buildCsp(config: { supabaseUrl: string; apiBaseUrl: string }): string;
export function injectCsp(html: string, csp: string): string;
export function securityHeadersFile(csp: string): string;
