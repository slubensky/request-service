/**
 * Cognito Hosted UI auth routes: GET /auth/login, /auth/callback, /auth/logout.
 *
 * - login: mints a single-use `state`, stores it in a short-lived HttpOnly
 *   cookie, and redirects to the Hosted UI.
 * - callback: validates `state` against the cookie (CSRF defense for the OAuth
 *   handshake), exchanges the code, verifies the ID token, maps the subject to
 *   a User, and issues a signed session cookie.
 * - logout: clears the session cookie and bounces through Cognito logout.
 *
 * Every handler fails closed (503) when its dependencies are not configured, so
 * the scaffold runs locally without secrets and never authenticates in a
 * half-configured state.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from './config.js';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  buildPasskeyRegistrationUrl,
  exchangeCodeForTokens,
  verifiedPhoneNumber,
  verifyIdToken,
} from './cognito.js';
import { clearCookie, parseCookies, serializeCookie } from './cookies.js';
import {
  bridgePendingSiteRoles,
  findOrCreateUserByCognitoSub,
  resolvePostLoginDestination,
} from '../db/access.js';
import { readSession } from './guard.js';
import { signSession } from './session.js';

export const SESSION_COOKIE = 'rs_session';
const STATE_COOKIE = 'rs_oauth_state';
// Step-up re-authentication (SDD §6.4): where to send the caller back to once
// authentication completes. Short-lived like the state cookie; only ever set to a value
// that already passed `isSafeReturnPath`.
const RETURN_TO_COOKIE = 'rs_oauth_return_to';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
const STATE_MAX_AGE_SECONDS = 600;

function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Allow-list for the `next` redirect target (SDD §6.4): only the exact QR scan path shape
 * -- no scheme, no protocol-relative `//`, nothing else -- so this can never become a
 * general open-redirect surface. Anything that doesn't match is ignored, not sanitized.
 */
function isSafeReturnPath(value: string): boolean {
  return /^\/s\/[A-Za-z0-9_-]+$/.test(value);
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
  if (setCookies.length > 0) {
    res.setHeader('Set-Cookie', setCookies);
  }
  res.writeHead(302, { Location: location });
  res.end();
}

function sendStatus(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function handleLogin(runtime: AuthRuntime, { res, query }: RouteContext): void {
  if (!runtime.cognito) {
    sendStatus(res, 503, 'Authentication is not configured');
    return;
  }
  const state = randomToken();
  const nonce = randomToken();
  const stateCookie = serializeCookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  // Step-up re-authentication (SDD §6.4): only a `next` that clears the allow-list is
  // carried through; anything else is dropped rather than trusted, and any stale value
  // from an earlier login attempt is cleared so it can never leak into this one.
  const next = query.next;
  const returnToCookie =
    next !== undefined && isSafeReturnPath(next)
      ? serializeCookie(RETURN_TO_COOKIE, next, {
          httpOnly: true,
          sameSite: 'Lax',
          maxAge: STATE_MAX_AGE_SECONDS,
        })
      : clearCookie(RETURN_TO_COOKIE);
  redirect(res, buildAuthorizeUrl(runtime.cognito, state, nonce), [stateCookie, returnToCookie]);
}

async function handleCallback(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const { req, res, query } = ctx;
  if (!runtime.cognito || !runtime.sessionSecret || !runtime.connection) {
    sendStatus(res, 503, 'Authentication is not configured');
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies[STATE_COOKIE];
  const { code, state } = query;
  if (!code || !state || !expectedState || state !== expectedState) {
    sendStatus(res, 400, 'Invalid authentication state');
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(runtime.cognito, code);
    const identity = await verifyIdToken(
      tokens.idToken,
      runtime.cognito,
      runtime.jwksFor(runtime.cognito),
    );
    // Persist the phone only when the SMS OTP sign-in verified it; an
    // unverified number is never trusted as contact identity (SDD §6).
    const verifiedPhone = verifiedPhoneNumber(identity);
    const user = await findOrCreateUserByCognitoSub(
      runtime.connection.db,
      identity.sub,
      verifiedPhone,
    );
    // Invite bridge (SDD §3.3): link/activate any pending SiteRole invited by
    // this VERIFIED phone. An unverified claim links nothing, and authority is
    // still conferred only through the capability matrix.
    await bridgePendingSiteRoles(runtime.connection.db, user.id, verifiedPhone);
    const token = signSession({ userId: user.id, sub: identity.sub }, runtime.sessionSecret);
    const sessionCookie = serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    // Step-up re-authentication (SDD §6.4): return to the page that requested re-auth, if
    // one was recorded and still passes the allow-list -- re-checked here even though only
    // an already-validated value is ever stored, since this cookie is the sole source of
    // truth for where to redirect. Otherwise, land on the console matching the user's own
    // authority (resolvePostLoginDestination) rather than the generic home page.
    const returnTo = parseCookies(req.headers.cookie)[RETURN_TO_COOKIE];
    const destination =
      returnTo && isSafeReturnPath(returnTo)
        ? returnTo
        : await resolvePostLoginDestination(runtime.connection.db, user.id);
    redirect(res, destination, [
      sessionCookie,
      clearCookie(STATE_COOKIE),
      clearCookie(RETURN_TO_COOKIE),
    ]);
  } catch {
    // Do not leak verification detail to the client; identity failed to verify.
    sendStatus(res, 401, 'Authentication failed');
  }
}

/**
 * Initiates passkey (WebAuthn) enrollment for an already-authenticated session
 * (SDD §6.2 / §11.5). Enrollment is an identity action, so the only gate is a
 * valid session -- no role is consulted. Fails closed (503) when Cognito is
 * unconfigured and (401) when no valid session is present, so an anonymous
 * caller can never start enrollment. Mints a single-use `state` into the same
 * `rs_oauth_state` cookie the factor-shared callback validates, then redirects
 * to managed login; the ceremony returns through `/auth/callback` unchanged.
 */
function handlePasskeyRegister(runtime: AuthRuntime, ctx: RouteContext): void {
  const { req, res } = ctx;
  if (!runtime.cognito || !runtime.sessionSecret) {
    sendStatus(res, 503, 'Authentication is not configured');
    return;
  }
  if (!readSession(req, runtime)) {
    sendStatus(res, 401, 'Authentication required');
    return;
  }
  const state = randomToken();
  const nonce = randomToken();
  const stateCookie = serializeCookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  // Passkey enrollment does not accept `next` (SDD §6.4) -- it is a pure identity action,
  // not a step-up flow. Always clear any return-to value a prior login attempt may have
  // left behind so it can never leak into this redirect.
  redirect(res, buildPasskeyRegistrationUrl(runtime.cognito, state, nonce), [
    stateCookie,
    clearCookie(RETURN_TO_COOKIE),
  ]);
}

function handleLogout(runtime: AuthRuntime, { res }: RouteContext): void {
  const cleared = clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax' });
  redirect(res, runtime.cognito ? buildLogoutUrl(runtime.cognito) : '/', [cleared]);
}

/** Registers the auth routes against the shared router, closing over the runtime. */
export function registerAuthRoutes(router: Router, runtime: AuthRuntime): void {
  router.get('/auth/login', (ctx) => handleLogin(runtime, ctx));
  router.get('/auth/callback', (ctx) => handleCallback(runtime, ctx));
  router.get('/auth/passkey/register', (ctx) => handlePasskeyRegister(runtime, ctx));
  router.get('/auth/logout', (ctx) => handleLogout(runtime, ctx));
}
