/**
 * CSRF protection using a signed, session-bound token (node:crypto HMAC).
 *
 * The token is `HMAC(secret, sessionId)` encoded base64url. It is handed to the
 * client (rendered into forms / readable CSRF cookie) and must be echoed back
 * on every state-changing request via header or form field. Because it is
 * derived from the server-only secret and the caller's own session id, an
 * attacker on another origin cannot forge it, and it is bound to the exact
 * session so it cannot be lifted from a different user. Verification is
 * constant-time.
 *
 * This is the synchronizer-token / signed double-submit pattern -- standard,
 * not invented crypto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The methods that mutate state and therefore require a valid CSRF token. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requiresCsrf(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/** Derives the CSRF token for a session id. */
export function csrfTokenForSession(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}

/**
 * Verifies a submitted CSRF token against the session it claims to belong to.
 * Fails closed on any missing/mismatched value.
 */
export function verifyCsrfToken(
  sessionId: string,
  submittedToken: string | undefined,
  secret: string,
): boolean {
  if (!submittedToken) {
    return false;
  }
  const expected = csrfTokenForSession(sessionId, secret);
  const expectedBuf = Buffer.from(expected);
  const submittedBuf = Buffer.from(submittedToken);
  if (expectedBuf.length !== submittedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, submittedBuf);
}
