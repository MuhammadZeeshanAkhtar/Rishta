import { NikahMateError, type ApiErrorKind } from './errors';

/**
 * Typed transport for the NikahMate API.
 *
 * Path B from README §9.2: everything privileged, cross-user, quota-bearing or
 * rule-heavy. The app never reimplements those rules; it asks the server.
 *
 * Responses are validated by the caller with the shared Zod schemas, so a
 * server that changes shape fails loudly at the boundary rather than producing
 * `undefined` three screens later.
 */

export interface HttpClientOptions {
  baseUrl: string;
  /** Resolved per request: a token cached at start-up is expired by mid-session. */
  getAccessToken: () => Promise<string | null>;
  /** Sent as Accept-Language so the server can localise its own messages. */
  getLocale?: () => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Public endpoints (reference data) skip the token entirely. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

const STATUS_TO_KIND: Record<number, ApiErrorKind> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'rate_limited',
};

interface ProblemBody {
  code?: unknown;
  message?: unknown;
  fields?: unknown;
}

/** Turns the API's Problem body into field errors the form can show inline. */
function toFieldMap(fields: unknown): Record<string, string> | undefined {
  if (!fields || typeof fields !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly getLocale: (() => string) | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = options.getAccessToken;
    this.getLocale = options.getLocale;
    // Target markets have slow, lossy networks. Long enough to succeed on 3G,
    // short enough that a dead connection does not look like a frozen app.
    this.timeoutMs = options.timeoutMs ?? 20_000;
    // Bound to globalThis: React Native's fetch throws "Illegal invocation" if
    // it is detached from its receiver.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, anonymous = false } = options;

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.getLocale) headers['Accept-Language'] = this.getLocale();

    if (!anonymous) {
      const token = await this.getAccessToken();
      // No token for a protected call is a dead session, not a server problem.
      // Saying so here means the caller gets one clear reason instead of a 401
      // that looks like a backend failure.
      if (!token) throw new NikahMateError('unauthenticated');
      headers.Authorization = `Bearer ${token}`;
    }

    // Times out without leaking the abort: AbortError would otherwise surface
    // as an unknown failure rather than a network one.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NikahMateError('network', { detail: (error as Error)?.message });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (response.ok) return parsed as T;

    const problem = (parsed ?? {}) as ProblemBody;
    const kind = STATUS_TO_KIND[response.status] ?? (response.status >= 500 ? 'server' : 'unknown');
    const retryAfter = Number(response.headers.get('Retry-After'));

    throw new NikahMateError(kind, {
      detail: typeof problem.message === 'string' ? problem.message : `HTTP ${response.status}`,
      fields: toFieldMap(problem.fields),
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }

  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}
