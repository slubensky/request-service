/**
 * Signed, tamper-evident session tokens backed by node:crypto HMAC-SHA256.
 *
 * A token is `base64url(payloadJson).base64url(hmac)`. The HMAC is computed
 * over the encoded payload with a server-only secret (SESSION_SECRET, injected
 * from Secrets Manager). Verification recomputes the HMAC and compares in
 * constant time, then enforces a max-age so a leaked cookie cannot be replayed
 * indefinitely. The payload is a bearer of identity only (the resolved User
 * id + Cognito subject); it grants no authority on its own -- authority is
 * always re-derived from SiteRole (see authorize.ts).
 *
 * We do not invent crypto: this is a standard signed-token (HMAC) construction
 * using the platform crypto module, per AGENTS.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** The resolved `users.id` for the authenticated identity. */
  userId: string;
  /** The Cognito subject that authenticated. */
  sub: string;
  /** Issued-at, epoch seconds. Set by `signSession`. */
  iat: number;
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

/** Signs a session payload, stamping `iat` from `nowSeconds` (injectable for tests). */
export function signSession(
  payload: Omit<SessionPayload, 'iat'>,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const full: SessionPayload = { ...payload, iat: nowSeconds };
  const encodedPayload = toBase64Url(JSON.stringify(full));
  const signature = toBase64Url(hmac(encodedPayload, secret));
  return `${encodedPayload}.${signature}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.userId === 'string' &&
    typeof record.sub === 'string' &&
    typeof record.iat === 'number'
  );
}

/**
 * Verifies signature and age, returning the payload or null. Fails closed on
 * any tampering, malformed input, or expiry -- callers treat null as "no
 * session" (unauthenticated).
 */
export function verifySession(
  token: string,
  secret: string,
  maxAgeSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot === -1) {
    return null;
  }
  const encodedPayload = token.slice(0, dot);
  const providedSignature = token.slice(dot + 1);
  const expectedSignature = toBase64Url(hmac(encodedPayload, secret));
  if (!constantTimeEquals(providedSignature, expectedSignature)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isSessionPayload(parsed)) {
    return null;
  }
  if (nowSeconds - parsed.iat > maxAgeSeconds || parsed.iat > nowSeconds) {
    return null;
  }
  return parsed;
}
