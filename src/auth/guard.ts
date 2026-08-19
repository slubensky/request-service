/**
 * Request-time auth helpers: read the current session and enforce CSRF on
 * state-changing requests.
 *
 * CSRF policy (fail closed): every state-changing method (POST/PUT/PATCH/DELETE)
 * must carry a valid session cookie AND an `x-csrf-token` header whose value is
 * the session-bound token (see csrf.ts). Anything short of that is forbidden --
 * an unauthenticated or tokenless mutation never proceeds. Safe methods (GET,
 * HEAD, OPTIONS) are unaffected.
 */
import type { IncomingMessage } from 'node:http';
import type { AuthRuntime } from './config.js';
import { parseCookies } from './cookies.js';
import { requiresCsrf, verifyCsrfToken } from './csrf.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './routes.js';
import { verifySession, type SessionPayload } from './session.js';

/** Returns the verified session for the request, or null when absent/invalid. */
export function readSession(req: IncomingMessage, runtime: AuthRuntime): SessionPayload | null {
  if (!runtime.sessionSecret) {
    return null;
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) {
    return null;
  }
  return verifySession(token, runtime.sessionSecret, SESSION_MAX_AGE_SECONDS);
}

/**
 * Step-up re-authentication check (SDD §6.4): whether the session was established (or
 * re-established) by a full Cognito authentication within the last `windowSeconds`. A
 * session's `iat` is stamped only by `/auth/callback`, shared across every auth factor
 * (SMS OTP, passkey), so it is exactly "time of last authentication" -- no separate
 * last-activity tracking exists or is needed. Used by actions that need proof of a *recent*
 * authentication, not merely a still-unexpired session cookie (first consumer: reusing a
 * saved payment method to place a new hold, SDD §9.4).
 */
export function sessionAuthenticatedWithin(
  session: SessionPayload,
  windowSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return nowSeconds - session.iat <= windowSeconds && session.iat <= nowSeconds;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decides whether a request clears CSRF protection. Safe methods always pass;
 * state-changing methods require a valid session cookie plus a matching
 * `x-csrf-token` header, and are otherwise rejected.
 */
export function passesCsrf(req: IncomingMessage, runtime: AuthRuntime): boolean {
  const method = req.method ?? 'GET';
  if (!requiresCsrf(method)) {
    return true;
  }
  if (!runtime.sessionSecret) {
    return false;
  }
  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionToken) {
    return false;
  }
  if (!verifySession(sessionToken, runtime.sessionSecret, SESSION_MAX_AGE_SECONDS)) {
    return false;
  }
  const submitted = headerValue(req.headers['x-csrf-token']);
  return verifyCsrfToken(sessionToken, submitted, runtime.sessionSecret);
}
