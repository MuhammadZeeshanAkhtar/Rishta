/**
 * @nikahmate/api-client — the only route to Supabase Auth and the NikahMate API.
 *
 * Why this package exists rather than calling Supabase from screens:
 *
 *   - **One definition of "signed in."** The website will reuse this against
 *     the same user records. A second implementation is how two subtly
 *     different session models appear.
 *   - **No raw provider errors reach a screen.** Everything leaves here as a
 *     NikahMateError with a stable kind and an i18n key.
 *   - **Path B stays honest** (README §9.2). Privileged, cross-user and
 *     rule-heavy operations go through the API, so authorization is never
 *     something React Native decides.
 *
 * ESLint blocks `@supabase/supabase-js` everywhere else in the repo.
 */

export { NikahMateClient, type NikahMateClientOptions } from './client';
export {
  AuthClient,
  type AuthClientOptions,
  type AuthListener,
  type AuthSession,
  type AuthUser,
} from './auth';
export { HttpClient, type HttpClientOptions } from './http';
export {
  NikahMateError,
  isNikahMateError,
  fromAuthError,
  type ApiErrorKind,
  type AuthErrorKind,
  type ErrorKind,
} from './errors';
export type { SupportedStorage } from '@supabase/supabase-js';
