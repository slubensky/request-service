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
  exchangeCodeForTokens,
  verifiedPhoneNumber,
  verifyIdToken,
} from './cognito.js';
import { clearCookie, parseCookies, serializeCookie } from './cookies.js';
import { findOrCreateUserByCognitoSub } from '../db/access.js';
import { signSession } from './session.js';

export const SESSION_COOKIE = 'rs_session';
const STATE_COOKIE = 'rs_oauth_state';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
const STATE_MAX_AGE_SECONDS = 600;

function randomToken(): string {
  return randomBytes(16).toString('base64url');
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

function handleLogin(runtime: AuthRuntime, { res }: RouteContext): void {
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
  redirect(res, buildAuthorizeUrl(runtime.cognito, state, nonce), [stateCookie]);
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
    const user = await findOrCreateUserByCognitoSub(
      runtime.connection.db,
      identity.sub,
      verifiedPhoneNumber(identity),
    );
    const token = signSession({ userId: user.id, sub: identity.sub }, runtime.sessionSecret);
    const sessionCookie = serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    redirect(res, '/', [sessionCookie, clearCookie(STATE_COOKIE)]);
  } catch {
    // Do not leak verification detail to the client; identity failed to verify.
    sendStatus(res, 401, 'Authentication failed');
  }
}

function handleLogout(runtime: AuthRuntime, { res }: RouteContext): void {
  const cleared = clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax' });
  redirect(res, runtime.cognito ? buildLogoutUrl(runtime.cognito) : '/', [cleared]);
}

/** Registers the auth routes against the shared router, closing over the runtime. */
export function registerAuthRoutes(router: Router, runtime: AuthRuntime): void {
  router.get('/auth/login', (ctx) => handleLogin(runtime, ctx));
  router.get('/auth/callback', (ctx) => handleCallback(runtime, ctx));
  router.get('/auth/logout', (ctx) => handleLogout(runtime, ctx));
}
