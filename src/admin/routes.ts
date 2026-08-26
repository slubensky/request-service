/**
 * Company-Admin onboarding routes (see SDD.md §11.1, §11.3).
 *
 * Every handler re-derives authority server-side through `authorizeAction`
 * (the deny-by-default matrix, §7) BEFORE any business logic or side effect,
 * and before parsing the request body. Authorization is keyed on the target
 * site's route params only -- never on client-submitted role claims. State-
 * changing requests have already cleared the global session-bound CSRF guard
 * (app.ts) by the time these handlers run.
 *
 * Company Admin is a platform role: `create_site` needs no SiteRole, and the
 * site-scoped onboarding actions are satisfied by the platform matrix cross-
 * site. No route branches on role directly.
 */
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import { readSession, csrfTokenForRequest } from '../auth/guard.js';
import { authorizeAction } from '../auth/enforce.js';
import { authorizeOrReject } from '../auth/gate.js';
import { publicBaseUrl } from '../server/base-url.js';
import { readFormBody, BodyTooLargeError } from '../server/body.js';
import { sendText } from '../server/respond.js';
import { requireField, parsePhone, type ParseResult } from '../server/validation.js';
import {
  addBathroom,
  createSite,
  inviteInitialManager,
  issueQrToken,
  listSitesWithBathrooms,
  revokeSiteRole,
  SiteNotFoundError,
  SiteRoleNotFoundError,
  BathroomNotFoundError,
  type CreateSiteInput,
  type IssuedQrToken,
  type SiteWithBathrooms,
} from './service.js';
import { setAuthorizedUserLimit, RoleNotManageableError } from '../manager/service.js';
import { renderAdminConsole, renderQrIssued } from '../render/templates/admin.js';
import { renderPaymentsConsole } from '../render/templates/payments.js';
import { renderQrSvg } from '../qr/image.js';
import { isDemoMode } from '../demo/config.js';
import { unusedCodesForSiteRoles } from '../demo/service.js';
import { respondToInviteOutcome } from '../server/invite-notify.js';
import type { AppDatabase } from '../db/client.js';
import {
  cancelCleaningRequest,
  captureCleaningRequest,
  InvalidPaymentStateError,
  listPendingCaptures,
  loadPaymentAuthorization,
  PaymentAuthorizationNotFoundError,
} from '../payments/service.js';
import { MockPaymentGateway, type PaymentGateway } from '../payments/gateway.js';
import { MockSmsGateway, type SmsGateway } from '../sms/gateway.js';

/** Parses and validates the create-site form. Nothing here is trusted unvalidated. */
function parseCreateSiteInput(fields: Record<string, string>): ParseResult<CreateSiteInput> {
  const name = requireField(fields, 'name', 120);
  if (!name.ok) return name;
  const address = requireField(fields, 'address', 240);
  if (!address.ok) return address;
  const timezone = requireField(fields, 'timezone', 64);
  if (!timezone.ok) return timezone;
  const currency = requireField(fields, 'currency', 8);
  if (!currency.ok) return currency;

  const rawPrice = (fields.fixed_price_cents ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(rawPrice)) {
    return { ok: false, error: 'fixed_price_cents must be a whole number of cents' };
  }
  const fixedPriceCents = Number.parseInt(rawPrice, 10);

  return {
    ok: true,
    value: {
      name: name.value,
      address: address.value,
      timezone: timezone.value,
      currency: currency.value.toLowerCase(),
      fixedPriceCents,
    },
  };
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
    sendText(res, 503, 'Onboarding is not configured');
    return;
  }
  // Company-admin gate: viewing the console requires the same platform authority
  // that creating a site does, resolved through the matrix (no role branch here).
  const decision = await authorizeAction(db, session.userId, { type: 'create_site' });
  if (!decision.allowed) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  const csrfToken = csrfTokenForRequest(req, secret);
  const siteList = await listSitesWithBathrooms(db);
  // Demo-only (SDD §6.3): surface the single-use accept code for each pending
  // manager invite. `demoCodesForConsole` returns an empty map off DEMO_MODE, so
  // no codes render in production; the managers list itself renders everywhere.
  const demoCodes = await demoCodesForConsole(db, siteList);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderAdminConsole(siteList, csrfToken, demoCodes));
}

/**
 * Collects the outstanding demo accept code for every pending invite on the
 * console. Returns an empty map when DEMO_MODE is off, so the console renders no
 * codes in production. Mirrors `demoCodesForConsole` in `manager/routes.ts`.
 */
async function demoCodesForConsole(
  db: AppDatabase,
  siteList: SiteWithBathrooms[],
): Promise<Map<string, string>> {
  if (!isDemoMode()) {
    return new Map();
  }
  const pendingIds = siteList.flatMap((entry) =>
    entry.members.filter((member) => member.status === 'pending').map((member) => member.id),
  );
  return unusedCodesForSiteRoles(db, pendingIds);
}

async function handleCreateSite(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const gate = await authorizeOrReject(runtime, ctx, { type: 'create_site' });
  if (!gate) return;
  const fields = await readFormBody(ctx.req);
  const parsed = parseCreateSiteInput(fields);
  if (!parsed.ok) {
    sendText(ctx.res, 400, parsed.error);
    return;
  }
  await createSite(gate.db, parsed.value);
  ctx.res.writeHead(204).end();
}

async function handleAddBathroom(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const siteId = ctx.params.siteId ?? '';
  const gate = await authorizeOrReject(runtime, ctx, { type: 'create_bathroom', siteId });
  if (!gate) return;
  const fields = await readFormBody(ctx.req);
  const label = requireField(fields, 'label', 120);
  if (!label.ok) {
    sendText(ctx.res, 400, label.error);
    return;
  }
  try {
    await addBathroom(gate.db, siteId, label.value);
  } catch (error) {
    if (error instanceof SiteNotFoundError) {
      sendText(ctx.res, 404, 'Site not found');
      return;
    }
    throw error;
  }
  ctx.res.writeHead(204).end();
}

async function handleIssueQr(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const siteId = ctx.params.siteId ?? '';
  const bathroomId = ctx.params.bathroomId ?? '';
  const gate = await authorizeOrReject(runtime, ctx, {
    type: 'issue_qr_token',
    siteId,
    bathroomId,
  });
  if (!gate) return;
  let issued: IssuedQrToken;
  try {
    issued = await issueQrToken(gate.db, siteId, bathroomId);
  } catch (error) {
    if (error instanceof BathroomNotFoundError) {
      sendText(ctx.res, 404, 'Bathroom not found for site');
      return;
    }
    throw error;
  }
  const scanUrl = `${publicBaseUrl(ctx)}/s/${issued.rawToken}`;
  const qrSvg = await renderQrSvg(scanUrl);
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(renderQrIssued(scanUrl, qrSvg));
}

async function handleInviteManager(
  runtime: AuthRuntime,
  ctx: RouteContext,
  smsGateway: SmsGateway,
): Promise<void> {
  const siteId = ctx.params.siteId ?? '';
  const gate = await authorizeOrReject(runtime, ctx, {
    type: 'invite_initial_manager',
    siteId,
  });
  if (!gate) return;
  const fields = await readFormBody(ctx.req);
  const phone = parsePhone(fields);
  if (!phone.ok) {
    sendText(ctx.res, 400, phone.error);
    return;
  }
  let outcome;
  try {
    outcome = await inviteInitialManager(gate.db, siteId, phone.value);
  } catch (error) {
    if (error instanceof SiteNotFoundError) {
      sendText(ctx.res, 404, 'Site not found');
      return;
    }
    throw error;
  }
  await respondToInviteOutcome(ctx, gate.db, outcome, phone.value, smsGateway);
}

/** Company Admin revoke of a SiteRole (a Manager) at a site (SDD §11.1, §7). */
async function handleRevokeRole(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const siteId = ctx.params.siteId ?? '';
  const roleId = ctx.params.roleId ?? '';
  const gate = await authorizeOrReject(runtime, ctx, { type: 'revoke_site_role', siteId });
  if (!gate) return;
  try {
    await revokeSiteRole(gate.db, siteId, roleId);
  } catch (error) {
    if (error instanceof SiteRoleNotFoundError) {
      sendText(ctx.res, 404, 'Site role not found');
      return;
    }
    throw error;
  }
  ctx.res.writeHead(204).end();
}

/** Company Admin change of an authorized user's approval limit at a site (SDD §11.1, §7). */
async function handleSetRoleLimit(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
  const siteId = ctx.params.siteId ?? '';
  const roleId = ctx.params.roleId ?? '';
  const gate = await authorizeOrReject(runtime, ctx, { type: 'set_site_role_limit', siteId });
  if (!gate) return;
  const fields = await readFormBody(ctx.req);
  const raw = (fields.max_authorization_cents ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
    sendText(
      ctx.res,
      400,
      'max_authorization_cents must be a whole number of cents greater than zero',
    );
    return;
  }
  try {
    await setAuthorizedUserLimit(gate.db, siteId, roleId, Number.parseInt(raw, 10));
  } catch (error) {
    if (error instanceof SiteRoleNotFoundError) {
      sendText(ctx.res, 404, 'Site role not found');
      return;
    }
    if (error instanceof RoleNotManageableError) {
      sendText(ctx.res, 409, error.message);
      return;
    }
    throw error;
  }
  ctx.res.writeHead(204).end();
}

async function handleListPayments(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
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
    sendText(res, 503, 'Payments are not configured');
    return;
  }
  // Same site-less platform gate the admin console itself uses (`create_site`):
  // viewing outstanding holds is Company-Admin-only and cross-site (§9.1, §11.6).
  // `capture_payment`'s Action type requires a real siteId, so it is deliberately
  // not reused here for a site-less "list everything" view.
  const decision = await authorizeAction(db, session.userId, { type: 'create_site' });
  if (!decision.allowed) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  const csrfToken = csrfTokenForRequest(req, secret);
  const pending = await listPendingCaptures(db);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPaymentsConsole(pending, csrfToken));
}

/**
 * Shared capture/cancel handler builder: resolves the target's site id
 * read-only (never a client-supplied claim) so the authorization gate runs
 * against the real site before any mutation, per §7.
 */
function registerCaptureOrCancel(
  router: Router,
  runtime: AuthRuntime,
  gateway: PaymentGateway,
  path: string,
  actionType: 'capture_payment' | 'cancel_payment',
  mutate: (db: AppDatabase, gateway: PaymentGateway, id: string) => Promise<void>,
): void {
  router.post(path, (ctx) =>
    withBodyLimit(async (rt, c) => {
      const id = c.params.id ?? '';
      const db = rt.connection?.db;
      if (!db) {
        sendText(c.res, 503, 'Payments are not configured');
        return;
      }
      let siteId: string;
      try {
        siteId = (await loadPaymentAuthorization(db, id)).request.siteId;
      } catch (error) {
        if (error instanceof PaymentAuthorizationNotFoundError) {
          sendText(c.res, 404, 'Payment authorization not found');
          return;
        }
        throw error;
      }
      const gate = await authorizeOrReject(rt, c, { type: actionType, siteId });
      if (!gate) return;
      try {
        await mutate(gate.db, gateway, id);
      } catch (error) {
        if (error instanceof InvalidPaymentStateError) {
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
 * Registers the Company-Admin console, onboarding, and payment
 * capture/cancel endpoints (SDD §11.6). The payment gateway is injectable so
 * tests can share one instance with the public authorize route (SDD §9.3);
 * production uses a fresh MockPaymentGateway. The SMS gateway is injectable
 * the same way (src/sms/gateway.ts); production wires a real SnsSmsGateway
 * (see src/server/app.ts), tests default to a fresh MockSmsGateway.
 */
export function registerAdminRoutes(
  router: Router,
  runtime: AuthRuntime,
  gateway: PaymentGateway = new MockPaymentGateway(),
  smsGateway: SmsGateway = new MockSmsGateway(),
): void {
  router.get('/admin', (ctx) => handleConsole(runtime, ctx));
  router.post('/admin/sites', (ctx) => withBodyLimit(handleCreateSite)(runtime, ctx));
  router.post('/admin/sites/:siteId/bathrooms', (ctx) =>
    withBodyLimit(handleAddBathroom)(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/bathrooms/:bathroomId/qr', (ctx) =>
    withBodyLimit(handleIssueQr)(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/managers', (ctx) =>
    withBodyLimit((r, c) => handleInviteManager(r, c, smsGateway))(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/roles/:roleId/revoke', (ctx) =>
    withBodyLimit(handleRevokeRole)(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/roles/:roleId/limit', (ctx) =>
    withBodyLimit(handleSetRoleLimit)(runtime, ctx),
  );
  router.get('/admin/payments', (ctx) => handleListPayments(runtime, ctx));
  registerCaptureOrCancel(
    router,
    runtime,
    gateway,
    '/admin/payments/:id/capture',
    'capture_payment',
    captureCleaningRequest,
  );
  registerCaptureOrCancel(
    router,
    runtime,
    gateway,
    '/admin/payments/:id/cancel',
    'cancel_payment',
    cancelCleaningRequest,
  );
}
