/**
 * Site Manager console + invitation routes (see SDD.md §11.4).
 *
 * Every handler re-derives authority server-side through `authorizeOrReject`
 * (the deny-by-default matrix, §7) BEFORE any business logic or side effect,
 * and before parsing the request body -- the same single seam
 * `src/admin/routes.ts` uses, not a parallel copy. Authorization is keyed on
 * the target site's route param only -- never on a client-submitted role
 * claim. State-changing requests have already cleared the global
 * session-bound CSRF guard (app.ts) by the time these handlers run.
 *
 * `invite_site_role` is granted to an authorized `role=manager` SiteRole at its
 * own site; Company Admin's `invite_initial_manager` authority is unrelated and
 * unaffected by this module.
 */
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import { readSession } from '../auth/guard.js';
import { authorizeOrReject } from '../auth/gate.js';
import { parseCookies } from '../auth/cookies.js';
import { SESSION_COOKIE } from '../auth/routes.js';
import { csrfTokenForSession } from '../auth/csrf.js';
import { readFormBody, BodyTooLargeError } from '../server/body.js';
import { sendText } from '../server/respond.js';
import { requireField, parsePhone, type ParseResult } from '../server/validation.js';
import { FixedWindowRateLimiter } from '../server/rate-limit.js';
import { inviteSiteMember, listManagedSites, type InvitableRole } from './service.js';
import { SiteNotFoundError } from '../admin/service.js';
import { renderManagerConsole } from '../render/templates/manager.js';

// Per-user budget for invite creation: generous for genuine onboarding, low
// enough to bound spam pending-row creation since no SMS cost gates it yet.
const INVITE_LIMIT = 20;
const INVITE_WINDOW_MS = 60_000;

function isInvitableRole(value: string): value is InvitableRole {
  return value === 'manager' || value === 'assistant';
}

/** Validates the invited member's role: exactly `manager` or `assistant`, no fallback. */
function parseInviteRole(fields: Record<string, string>): ParseResult<InvitableRole> {
  const field = requireField(fields, 'role', 16);
  if (!field.ok) return field;
  if (!isInvitableRole(field.value)) {
    return { ok: false, error: 'role must be "manager" or "assistant"' };
  }
  return { ok: true, value: field.value };
}

async function handleConsole(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const { req, res } = ctx;
  const session = readSession(req, runtime);
  if (!session) {
    res.writeHead(302, { Location: '/auth/login' });
    res.end();
    return;
  }
  const db = runtime.connection?.db;
  const secret = runtime.sessionSecret;
  if (!db || !secret) {
    sendText(res, 503, 'The manager console is not configured');
    return;
  }
  // Self-scoped read: filtered by the caller's own user id, so it needs no
  // separate capability -- a non-manager session simply sees an empty console.
  const managedSites = await listManagedSites(db, session.userId);
  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
  const csrfToken = csrfTokenForSession(sessionToken, secret);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderManagerConsole(managedSites, csrfToken));
}

function registerInviteHandler(
  router: Router,
  runtime: AuthRuntime,
  limiter: FixedWindowRateLimiter,
): void {
  router.post('/manager/sites/:siteId/invites', async (ctx) => {
    const siteId = ctx.params.siteId ?? '';
    const gate = await authorizeOrReject(runtime, ctx, { type: 'invite_site_role', siteId });
    if (!gate) return;

    if (!limiter.check(gate.userId)) {
      sendText(ctx.res, 429, 'Too many invites, try again shortly');
      return;
    }

    let fields: Record<string, string>;
    try {
      fields = await readFormBody(ctx.req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendText(ctx.res, 413, 'Payload too large');
        return;
      }
      throw error;
    }

    const phone = parsePhone(fields);
    if (!phone.ok) {
      sendText(ctx.res, 400, phone.error);
      return;
    }
    const role = parseInviteRole(fields);
    if (!role.ok) {
      sendText(ctx.res, 400, role.error);
      return;
    }

    try {
      await inviteSiteMember(gate.db, siteId, role.value, phone.value);
    } catch (error) {
      if (error instanceof SiteNotFoundError) {
        sendText(ctx.res, 404, 'Site not found');
        return;
      }
      throw error;
    }
    ctx.res.writeHead(204).end();
  });
}

/**
 * Registers the Site Manager console and invitation endpoints. The rate
 * limiter is injectable so tests can drive the window deterministically;
 * production uses the default policy.
 */
export function registerManagerRoutes(
  router: Router,
  runtime: AuthRuntime,
  limiter: FixedWindowRateLimiter = new FixedWindowRateLimiter({
    limit: INVITE_LIMIT,
    windowMs: INVITE_WINDOW_MS,
  }),
): void {
  router.get('/manager', (ctx) => handleConsole(runtime, ctx));
  registerInviteHandler(router, runtime, limiter);
}
