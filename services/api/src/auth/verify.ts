import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';
import { unauthenticated } from '../errors.js';

/**
 * Supabase JWT verification.
 *
 * Two signing schemes are supported because Supabase projects use one or the
 * other: asymmetric keys published at a JWKS endpoint (preferred), and the
 * legacy shared HS256 secret. Which one applies is a property of the project,
 * not of our code, so both paths exist and the configured one is used.
 *
 * The token is verified, never merely decoded. A decoded-but-unverified JWT is
 * attacker-controlled input that happens to look official.
 */

export interface AuthContext {
  /** The Supabase auth user id. Resolved to our users.id inside Postgres. */
  authUserId: string;
  email: string | undefined;
  /** Token expiry, seconds since epoch. */
  expiresAt: number | undefined;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

export function createTokenVerifier(config: Config): TokenVerifier {
  const issuer = `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;

  // Cached across requests: the remote key set refetches on rotation by itself,
  // and building it per request would add a network round trip to every call.
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  const hmacKey = config.SUPABASE_JWT_SECRET
    ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
    : undefined;

  async function verifyWith(token: string): Promise<JWTPayload> {
    const options = { issuer, audience: 'authenticated' } as const;

    if (hmacKey) {
      try {
        const { payload } = await jwtVerify(token, hmacKey, options);
        return payload;
      } catch {
        // Fall through to JWKS: a project mid-migration to asymmetric keys
        // issues both kinds for a while.
      }
    }

    const { payload } = await jwtVerify(token, jwks, options);
    return payload;
  }

  return {
    async verify(token: string): Promise<AuthContext> {
      let payload: JWTPayload;
      try {
        payload = await verifyWith(token);
      } catch {
        // Deliberately uninformative. Distinguishing "expired" from "bad
        // signature" from "wrong issuer" tells an attacker which knob to turn.
        throw unauthenticated('Invalid or expired token');
      }

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw unauthenticated('Token has no subject');
      }

      return {
        authUserId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      };
    },
  };
}

/** Extracts a bearer token, or null when the header is absent or malformed. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
