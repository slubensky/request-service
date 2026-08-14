/**
 * Demo invitation-code acceptance routes (SDD §6.3). DEMO_MODE only.
 *
 * These routes are registered ONLY when DEMO_MODE is on; in production they do
 * not exist and `/invite/accept` is a plain 404. They let an invited person walk
 * the accept -> activation loop in a browser without live SMS/Cognito:
 *
 *   GET  /invite/accept  -- renders the code-entry form and mints a short-lived,
 *                           origin-bound double-submit CSRF token (cookie + hidden
 *                           field). The accepter has no session yet.
 *   POST /invite/accept  -- validates the double-submit token, then the code;
 *                           on success stands in for SMS-OTP verification and runs
 *                           the §3.3 bridge UNCHANGED, issues the same signed
 *                           session cookie the Cognito callback issues, and
 *                           renders the outcome. Fails closed otherwise.
 *
 * The pre-session POST is exempt from the global session-bound CSRF gate (see
 * `isDemoAcceptSubmission`, consumed in server/app.ts) -- an exemption that is
 * itself DEMO_MODE-gated -- and is protected here by the double-submit token,
 * compared in constant time.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import { clearCookie, parseCookies, serializeCookie } from '../auth/cookies.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '../auth/routes.js';
import { signSession } from '../auth/session.js';
import { readFormBody, BodyTooLargeError } from '../server/body.js';
import { sendText } from '../server/respond.js';
import { requireField } from '../server/validation.js';
import {
  renderAcceptForm,
  renderAcceptRejected,
  renderAcceptResult,
} from '../render/templates/demo-invite.js';
import { acceptDemoInviteCode } from './service.js';
import { isDemoMode } from './config.js';

const ACCEPT_PATH = '/invite/accept';
export const DEMO_CSRF_COOKIE = 'rs_demo_csrf';
const DEMO_CSRF_MAX_AGE_SECONDS = 600;

function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Writes the accept form with a freshly minted double-submit token: the token
 * goes into an HttpOnly `rs_demo_csrf` cookie and the matching hidden field, so
 * the subsequent POST can prove same-origin provenance without a session.
 */
function respondWithForm(
  res: ServerResponse,
  status: number,
  options: { code?: string; error?: string },
): void {
  const token = randomToken();
  const cookie = serializeCookie(DEMO_CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: DEMO_CSRF_MAX_AGE_SECONDS,
  });
  res.setHeader('Set-Cookie', cookie);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderAcceptForm({ csrfToken: token, code: options.code, error: options.error }));
}

function handleAcceptForm({ res, query }: RouteContext): void {
  respondWithForm(res, 200, { code: query.code });
}

async function handleAcceptSubmit(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const { req, res } = ctx;
  const db = runtime.connection?.db;
  const secret = runtime.sessionSecret;
  if (!db || !secret) {
    sendText(res, 503, 'Demo acceptance is not configured');
    return;
  }

  let fields: Record<string, string>;
  try {
    fields = await readFormBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendText(res, 413, 'Payload too large');
      return;
    }
    throw error;
  }

  // Double-submit CSRF: the hidden field must equal the cookie minted by GET.
  const cookieToken = parseCookies(req.headers.cookie)[DEMO_CSRF_COOKIE];
  const submittedToken = fields.demo_csrf ?? '';
  if (!cookieToken || !constantTimeEquals(cookieToken, submittedToken)) {
    sendText(res, 403, 'Invalid or missing form token');
    return;
  }

  const code = requireField(fields, 'code', 32);
  if (!code.ok) {
    respondWithForm(res, 400, { error: code.error });
    return;
  }

  const outcome = await acceptDemoInviteCode(db, code.value);
  if (!outcome) {
    // Unknown or already-used code: fail closed, mint no session.
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAcceptRejected());
    return;
  }

  // Issue the same signed session cookie the Cognito callback issues (§6.1), and
  // clear the one-time form token. The accepter is now authenticated as the
  // verified demo identity; authority still flows only from the §3.3 bridge.
  const sessionToken = signSession({ userId: outcome.userId, sub: outcome.sub }, secret);
  const sessionCookie = serializeCookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  res.setHeader('Set-Cookie', [
    sessionCookie,
    clearCookie(DEMO_CSRF_COOKIE, { httpOnly: true, sameSite: 'Lax' }),
  ]);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderAcceptResult({ activated: outcome.activated, role: outcome.role }));
}

/**
 * True for the pre-session demo accept POST, which carries its own double-submit
 * CSRF token and is therefore exempt from the session-bound CSRF gate. Gated on
 * DEMO_MODE, so it is always false (and the gate fully applies) in production.
 */
export function isDemoAcceptSubmission(method: string, pathname: string): boolean {
  return isDemoMode() && method === 'POST' && pathname === ACCEPT_PATH;
}

/** Registers the demo accept routes -- ONLY in DEMO_MODE; otherwise a no-op (404). */
export function registerDemoRoutes(router: Router, runtime: AuthRuntime): void {
  if (!isDemoMode()) {
    return;
  }
  router.get(ACCEPT_PATH, (ctx) => handleAcceptForm(ctx));
  router.post(ACCEPT_PATH, (ctx) => handleAcceptSubmit(runtime, ctx));
}
