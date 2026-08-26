/**
 * Site Manager console + membership routes (see SDD.md §11.4).
 *
 * Every handler re-derives authority server-side through `authorizeOrReject`
 * (the deny-by-default matrix, §7) BEFORE any business logic or side effect,
 * and before parsing the request body -- the same single seam
 * `src/admin/routes.ts` uses, not a parallel copy. Authorization is keyed on
 * the target site's route param only -- never on a client-submitted role
 * claim. State-changing requests have already cleared the global
 * session-bound CSRF guard (app.ts) by the time these handlers run.
 *
 * `invite_site_role` / `site_role:set_limit` / `site_role:delete` /
 * `request:approve` are granted to an authorized `role=manager` SiteRole at its
 * own site; Company Admin's `invite_initial_manager` / `site_role:revoke`
 * authority is unrelated and unaffected by this module.
 */
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import { readSession, csrfTokenForRequest } from '../auth/guard.js';
import { authorizeOrReject } from '../auth/gate.js';
import { readFormBody, BodyTooLargeError } from '../server/body.js';
import { sendText } from '../server/respond.js';
import { requireField, parsePhone, type ParseResult } from '../server/validation.js';
import { FixedWindowRateLimiter } from '../server/rate-limit.js';
import {
  deleteAuthorizedUser,
  inviteSiteMember,
  listManagedSites,
  setAuthorizedUserLimit,
  RoleNotManageableError,
  SiteRoleNotFoundError,
  type InvitableRole,
  type ManagedSite,
} from './service.js';
import { SiteNotFoundError } from '../admin/service.js';
import { renderManagerConsole } from '../render/templates/manager.js';
import { isDemoMode } from '../demo/config.js';
import { unusedCodesForSiteRoles } from '../demo/service.js';
import { respondToInviteOutcome } from '../server/invite-notify.js';
import { getSitePaymentMethod } from '../payments/service.js';
import {
  approveRequest,
  listPendingApprovalsForSites,
  loadRequestApproval,
  InvalidApprovalStateError,
  RequestApprovalNotFoundError,
  type PendingApprovalView,
} from '../payments/approvals.js';
import { MockPaymentGateway, type PaymentGateway } from '../payments/gateway.js';
import { MockSmsGateway, type SmsGateway } from '../sms/gateway.js';
import type { AppDatabase } from '../db/client.js';

// Per-user budget for invite creation: generous for genuine onboarding, low
// enough to bound spam pending-row creation since no SMS cost gates it yet.
const INVITE_LIMIT = 20;
const INVITE_WINDOW_MS = 60_000;

function isInvitableRole(value: string): value is InvitableRole {
  return value === 'manager' || value === 'authorized_user';
}

/** Validates the invited member's role: exactly `manager` or `authorized_user`, no fallback. */
function parseInviteRole(fields: Record<string, string>): ParseResult<InvitableRole> {
  const field = requireField(fields, 'role', 32);
  if (!field.ok) return field;
  if (!isInvitableRole(field.value)) {
    return { ok: false, error: 'role must be "manager" or "authorized_user"' };
  }
  return { ok: true, value: field.value };
}

/** Validates a positive authorization limit in whole cents (SDD §7): same shape as a site's
 * fixed price. Required for an authorized_user invite / set-limit; unused for a manager. */
function parseLimitCents(fields: Record<string, string>): ParseResult<number> {
  const raw = (fields.max_authorization_cents ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(raw)) {
    return { ok: false, error: 'max_authorization_cents must be a whole number of cents' };
  }
  const value = Number.parseInt(raw, 10);
  if (value <= 0) {
    return { ok: false, error: 'max_authorization_cents must be greater than zero' };
  }
  return { ok: true, value };
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
  const approvals = await listPendingApprovalsForSites(
    db,
    managedSites.map((entry) => entry.site.id),
  );
  const csrfToken = csrfTokenForRequest(req, secret);
  // Demo-only (SDD §6.3): surface the single-use accept code for each pending
  // invite. Empty (and unrendered) whenever DEMO_MODE is off.
  const demoCodes = await demoCodesForConsole(db, managedSites);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderManagerConsole(managedSites, csrfToken, approvals, demoCodes));
}

/**
 * Collects the outstanding demo accept code for every pending invite on the
 * console. Returns an empty map when DEMO_MODE is off, so the console renders no
 * codes in production.
 */
async function demoCodesForConsole(
  db: AppDatabase,
  managedSites: ManagedSite[],
): Promise<Map<string, string>> {
  if (!isDemoMode()) {
    return new Map();
  }
  const pendingIds = managedSites.flatMap((entry) =>
    entry.members.filter((member) => member.status === 'pending').map((member) => member.id),
  );
  return unusedCodesForSiteRoles(db, pendingIds);
}

function registerInviteHandler(
  router: Router,
  runtime: AuthRuntime,
  limiter: FixedWindowRateLimiter,
  smsGateway: SmsGateway,
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
    // A manager has no limit (SDD §7); an authorized_user requires one at invite.
    let limitCents: number | null = null;
    if (role.value === 'authorized_user') {
      const limit = parseLimitCents(fields);
      if (!limit.ok) {
        sendText(ctx.res, 400, limit.error);
        return;
      }
      limitCents = limit.value;
    }

    let outcome;
    try {
      outcome = await inviteSiteMember(gate.db, siteId, role.value, phone.value, limitCents);
    } catch (error) {
      if (error instanceof SiteNotFoundError) {
        sendText(ctx.res, 404, 'Site not found');
        return;
      }
      throw error;
    }
    await respondToInviteOutcome(ctx, gate.db, outcome, phone.value, smsGateway);
  });
}

/** Registers `POST /manager/sites/:siteId/roles/:roleId/limit` and `.../delete`. */
function registerMembershipHandlers(router: Router, runtime: AuthRuntime): void {
  router.post('/manager/sites/:siteId/roles/:roleId/limit', (ctx) =>
    withBodyLimit(async (rt, c) => {
      const siteId = c.params.siteId ?? '';
      const roleId = c.params.roleId ?? '';
      const gate = await authorizeOrReject(rt, c, { type: 'set_site_role_limit', siteId });
      if (!gate) return;
      const fields = await readFormBody(c.req);
      const limit = parseLimitCents(fields);
      if (!limit.ok) {
        sendText(c.res, 400, limit.error);
        return;
      }
      try {
        await setAuthorizedUserLimit(gate.db, siteId, roleId, limit.value);
      } catch (error) {
        if (mapMembershipError(c, error)) return;
        throw error;
      }
      c.res.writeHead(204).end();
    })(runtime, ctx),
  );

  router.post('/manager/sites/:siteId/roles/:roleId/delete', (ctx) =>
    withBodyLimit(async (rt, c) => {
      const siteId = c.params.siteId ?? '';
      const roleId = c.params.roleId ?? '';
      const gate = await authorizeOrReject(rt, c, { type: 'delete_site_role', siteId });
      if (!gate) return;
      try {
        await deleteAuthorizedUser(gate.db, siteId, roleId);
      } catch (error) {
        if (mapMembershipError(c, error)) return;
        throw error;
      }
      c.res.writeHead(204).end();
    })(runtime, ctx),
  );
}

/** Maps the shared membership-management errors to clean status codes; returns true if handled. */
function mapMembershipError(ctx: RouteContext, error: unknown): boolean {
  if (error instanceof SiteRoleNotFoundError) {
    sendText(ctx.res, 404, 'Site role not found');
    return true;
  }
  if (error instanceof RoleNotManageableError) {
    sendText(ctx.res, 409, error.message);
    return true;
  }
  return false;
}

/** Registers `POST /manager/approvals/:id/approve` (SDD §10). */
function registerApproveHandler(
  router: Router,
  runtime: AuthRuntime,
  gateway: PaymentGateway,
): void {
  router.post('/manager/approvals/:id/approve', (ctx) =>
    withBodyLimit(async (rt, c) => {
      const approvalId = c.params.id ?? '';
      const db = rt.connection?.db;
      if (!db) {
        sendText(c.res, 503, 'This action is not configured');
        return;
      }
      // Resolve the approval's own site so the gate runs against the real site,
      // never a client-supplied claim.
      let approvalSiteId: string;
      try {
        approvalSiteId = (await loadRequestApproval(db, approvalId)).siteId;
      } catch (error) {
        if (error instanceof RequestApprovalNotFoundError) {
          sendText(c.res, 404, 'Approval request not found');
          return;
        }
        throw error;
      }
      const gate = await authorizeOrReject(rt, c, {
        type: 'approve_request',
        siteId: approvalSiteId,
      });
      if (!gate) return;
      // Placing the hold requires the site to have a saved (mock) payment method (SDD §9.4).
      const savedMethod = await getSitePaymentMethod(gate.db, approvalSiteId);
      if (!savedMethod) {
        sendText(c.res, 409, 'Add a payment method for this site before approving a request');
        return;
      }
      try {
        await approveRequest(gate.db, gateway, approvalId, gate.userId);
      } catch (error) {
        if (error instanceof RequestApprovalNotFoundError) {
          sendText(c.res, 404, 'Approval request not found');
          return;
        }
        if (error instanceof InvalidApprovalStateError) {
          sendText(c.res, 409, error.message);
          return;
        }
        throw error;
      }
      c.res.writeHead(204).end();
    })(runtime, ctx),
  );
}

/** Wraps a POST handler to translate an over-cap body into a clean 413. */
function withBodyLimit(
  handler: (runtime: AuthRuntime, ctx: RouteContext) => Promise<void>,
): (runtime: AuthRuntime, ctx: RouteContext) => Promise<void> {
  return async (runtime, ctx) => {
    try {
      await handler(runtime, ctx);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendText(ctx.res, 413, 'Payload too large');
        return;
      }
      throw error;
    }
  };
}

/**
 * Registers the Site Manager console and membership endpoints. The rate limiter
 * and payment gateway are injectable so tests can drive the window
 * deterministically and share a gateway instance with the other routes; production
 * uses the default policy and the shared MockPaymentGateway (SDD §9.3).
 */
export function registerManagerRoutes(
  router: Router,
  runtime: AuthRuntime,
  gateway: PaymentGateway = new MockPaymentGateway(),
  limiter: FixedWindowRateLimiter = new FixedWindowRateLimiter({
    limit: INVITE_LIMIT,
    windowMs: INVITE_WINDOW_MS,
  }),
  smsGateway: SmsGateway = new MockSmsGateway(),
): void {
  router.get('/manager', (ctx) => handleConsole(runtime, ctx));
  registerInviteHandler(router, runtime, limiter, smsGateway);
  registerMembershipHandlers(router, runtime);
  registerApproveHandler(router, runtime, gateway);
}

export type { PendingApprovalView };
