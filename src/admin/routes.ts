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
import type { ServerResponse } from 'node:http';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import type { AppDatabase } from '../db/client.js';
import type { Action } from '../auth/authorize.js';
import { readSession } from '../auth/guard.js';
import { authorizeAction } from '../auth/enforce.js';
import { parseCookies } from '../auth/cookies.js';
import { SESSION_COOKIE } from '../auth/routes.js';
import { csrfTokenForSession } from '../auth/csrf.js';
import { getEnv } from '../config/env.js';
import { readFormBody, BodyTooLargeError } from '../server/body.js';
import {
  addBathroom,
  createSite,
  inviteInitialManager,
  issueQrToken,
  listSitesWithBathrooms,
  SiteNotFoundError,
  BathroomNotFoundError,
  type CreateSiteInput,
  type IssuedQrToken,
} from './service.js';
import { renderAdminConsole, renderQrIssued } from '../render/templates/admin.js';
import { renderQrSvg } from '../qr/image.js';

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function requireField(
  fields: Record<string, string>,
  name: string,
  max: number,
): ParseResult<string> {
  const value = (fields[name] ?? '').trim();
  if (value.length === 0) {
    return { ok: false, error: `Missing ${name}` };
  }
  if (value.length > max) {
    return { ok: false, error: `${name} is too long` };
  }
  return { ok: true, value };
}

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

/** Validates an invited-manager phone: a lenient E.164-ish shape, length-capped. */
function parsePhone(fields: Record<string, string>): ParseResult<string> {
  const field = requireField(fields, 'phone', 32);
  if (!field.ok) return field;
  if (!/^[+0-9()\-\s]{4,32}$/.test(field.value)) {
    return { ok: false, error: 'phone has an unexpected format' };
  }
  return { ok: true, value: field.value };
}

/**
 * Shared gate: resolves the session, ensures the DB is configured, and
 * authorizes `action` via the matrix. Returns the authenticated user id + db on
 * success, or writes the appropriate 401/403/503 and returns null.
 */
async function authorizeOrReject(
  runtime: AuthRuntime,
  { req, res }: RouteContext,
  action: Action,
): Promise<{ db: AppDatabase; userId: string } | null> {
  const session = readSession(req, runtime);
  if (!session) {
    sendText(res, 401, 'Authentication required');
    return null;
  }
  const db = runtime.connection?.db;
  if (!db) {
    sendText(res, 503, 'Onboarding is not configured');
    return null;
  }
  const decision = await authorizeAction(db, session.userId, action);
  if (!decision.allowed) {
    sendText(res, 403, 'Forbidden');
    return null;
  }
  return { db, userId: session.userId };
}

/** Base URL a printed QR should point at: an explicit env override, else the request host. */
function scanBaseUrl({ req }: RouteContext): string {
  const configured = getEnv('PUBLIC_BASE_URL');
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
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
  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
  const csrfToken = csrfTokenForSession(sessionToken, secret);
  const siteList = await listSitesWithBathrooms(db);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderAdminConsole(siteList, csrfToken));
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
  const scanUrl = `${scanBaseUrl(ctx)}/s/${issued.rawToken}`;
  const qrSvg = await renderQrSvg(scanUrl);
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(renderQrIssued(scanUrl, qrSvg));
}

async function handleInviteManager(runtime: AuthRuntime, ctx: RouteContext): Promise<void> {
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
  try {
    await inviteInitialManager(gate.db, siteId, phone.value);
  } catch (error) {
    if (error instanceof SiteNotFoundError) {
      sendText(ctx.res, 404, 'Site not found');
      return;
    }
    throw error;
  }
  ctx.res.writeHead(204).end();
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

/** Registers the Company-Admin console and onboarding endpoints. */
export function registerAdminRoutes(router: Router, runtime: AuthRuntime): void {
  router.get('/admin', (ctx) => handleConsole(runtime, ctx));
  router.post('/admin/sites', (ctx) => withBodyLimit(handleCreateSite)(runtime, ctx));
  router.post('/admin/sites/:siteId/bathrooms', (ctx) =>
    withBodyLimit(handleAddBathroom)(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/bathrooms/:bathroomId/qr', (ctx) =>
    withBodyLimit(handleIssueQr)(runtime, ctx),
  );
  router.post('/admin/sites/:siteId/managers', (ctx) =>
    withBodyLimit(handleInviteManager)(runtime, ctx),
  );
}
