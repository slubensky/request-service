/**
 * Public QR scan resolution + authenticated authorize-hold routes (see
 * SDD.md §5, §9.3, §11.2, §11.6).
 *
 * `GET /s/:token` performs a rate-limited, hash-based token lookup. For any
 * caller WITHOUT authorized site authority at the resolved site -- anonymous,
 * no SiteRole, an invited-but-not-accepted member, a manager authorized
 * elsewhere -- the response is the neutral "see staff" page, byte-for-byte
 * identical whether the token is active, revoked, or unknown, and whether or not
 * the site has an activated manager: there is deliberately no oracle for that
 * population. An authorized Manager or authorized user at the resolved site is
 * the sole, deliberate exception (§11.2): they see a price-confirmation page
 * instead, gated by the same deny-by-default matrix (§7) as every other action.
 *
 * `POST /s/:token/authorize` places the hold (§9.3) for a caller who clears the
 * matrix directly (a manager at any amount, or an authorized user within their
 * limit). An authorized user's over-limit request instead records a pending
 * approval a manager must grant (§10) -- no hold is placed here.
 */
import type { ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import type { AppDatabase } from '../db/client.js';
import { FixedWindowRateLimiter } from '../server/rate-limit.js';
import { resolveActiveQrToken, type ResolvedQrTarget } from '../qr/tokens.js';
import { renderPublicScanPage } from '../render/templates/public-scan.js';
import {
  renderAddPaymentMethodPage,
  renderApprovalPendingPage,
  renderAuthorizedPage,
  renderConfirmPage,
  renderReauthRequiredPage,
  renderRequestApprovalPage,
} from '../render/templates/confirm.js';
import { readSession, sessionAuthenticatedWithin, csrfTokenForRequest } from '../auth/guard.js';
import type { SessionPayload } from '../auth/session.js';
import { authorizeAction } from '../auth/enforce.js';
import { sendText } from '../server/respond.js';
import { sites } from '../db/schema.js';
import {
  createCleaningRequest,
  getSitePaymentMethod,
  saveSitePaymentMethod,
  SitePaymentMethodAlreadyExistsError,
} from '../payments/service.js';
import { createRequestApproval, findPendingApproval } from '../payments/approvals.js';
import { MockPaymentGateway, type PaymentGateway } from '../payments/gateway.js';

// Per-IP budget for scan resolution: enough for a genuine scanner retrying,
// low enough to blunt brute-force token enumeration (SDD §5).
const SCAN_LIMIT = 30;
const SCAN_WINDOW_MS = 60_000;

// Step-up re-authentication window for reusing a saved payment method (SDD §6.4, §9.4).
const RECENT_AUTH_WINDOW_SECONDS = 300;

function sendNeutralPage(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPublicScanPage());
}

async function siteFixedPriceCents(db: AppDatabase, siteId: string): Promise<number | null> {
  const [site] = await db
    .select({ fixedPriceCents: sites.fixedPriceCents })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  return site?.fixedPriceCents ?? null;
}

/**
 * Renders whichever of the three saved-payment-method states applies (SDD §9.4, §11.7) for
 * a caller who has already cleared the `create_cleaning_request` gate at this site: add a
 * method, authorize with the saved one, or re-authenticate first. Shared by the `GET`
 * handler and the successful `POST /s/:token/payment-method` response so "add, then
 * authorize" needs only two clicks -- without ever skipping the step-up check that follows.
 */
async function renderSiteAuthorizedState(
  db: AppDatabase,
  session: SessionPayload,
  siteId: string,
  siteName: string,
  amountCents: number,
  rawToken: string,
  csrfToken: string,
): Promise<string> {
  const savedMethod = await getSitePaymentMethod(db, siteId);
  if (!savedMethod) {
    return renderAddPaymentMethodPage({ siteName, amountCents, token: rawToken, csrfToken });
  }
  if (!sessionAuthenticatedWithin(session, RECENT_AUTH_WINDOW_SECONDS)) {
    return renderReauthRequiredPage({
      siteName,
      token: rawToken,
      savedMethodLabel: savedMethod.displayLabel,
    });
  }
  return renderConfirmPage({
    siteName,
    amountCents,
    token: rawToken,
    csrfToken,
    savedMethodLabel: savedMethod.displayLabel,
  });
}

/**
 * Renders the appropriate authorized-caller state (see `renderSiteAuthorizedState`), or
 * null if this caller/token combination does not clear the matrix -- in which case the
 * handler falls back to the unchanged neutral page.
 */
async function tryRenderConfirmPage(
  runtime: AuthRuntime,
  db: AppDatabase,
  req: RouteContext['req'],
  resolved: ResolvedQrTarget,
  rawToken: string,
): Promise<string | null> {
  const session = readSession(req, runtime);
  if (!session) {
    return null;
  }
  const amountCents = await siteFixedPriceCents(db, resolved.siteId);
  if (amountCents === null) {
    return null;
  }
  const decision = await authorizeAction(db, session.userId, {
    type: 'create_cleaning_request',
    siteId: resolved.siteId,
    bathroomId: resolved.bathroomId,
    amountCents,
  });
  // Not authorized to place a hold and not an over-limit authorized user -> neutral page.
  if (!runtime.sessionSecret) {
    return null;
  }
  if (!decision.allowed && decision.reason !== 'exceeds_max_authorization') {
    return null;
  }
  const [site] = await db
    .select({ name: sites.name })
    .from(sites)
    .where(eq(sites.id, resolved.siteId))
    .limit(1);
  if (!site) {
    return null;
  }
  const csrfToken = csrfTokenForRequest(req, runtime.sessionSecret);
  if (decision.allowed) {
    return renderSiteAuthorizedState(
      db,
      session,
      resolved.siteId,
      site.name,
      amountCents,
      rawToken,
      csrfToken,
    );
  }
  // Over-limit authorized user (SDD §10): show "awaiting approval" if one is already pending
  // for this bathroom, otherwise the "request manager approval" affordance.
  const pending = await findPendingApproval(db, resolved.bathroomId, session.userId);
  if (pending) {
    return renderApprovalPendingPage(site.name, amountCents);
  }
  return renderRequestApprovalPage({
    siteName: site.name,
    amountCents,
    token: rawToken,
    csrfToken,
  });
}

/**
 * Registers the public scan + authorize routes. The rate limiter and payment
 * gateway are injectable so tests can drive them deterministically and share
 * a gateway instance with the admin capture/cancel routes; production uses
 * the default policy and a fresh MockPaymentGateway (SDD §9.3).
 */
export function registerPublicRoutes(
  router: Router,
  runtime: AuthRuntime,
  limiter: FixedWindowRateLimiter = new FixedWindowRateLimiter({
    limit: SCAN_LIMIT,
    windowMs: SCAN_WINDOW_MS,
  }),
  gateway: PaymentGateway = new MockPaymentGateway(),
): void {
  router.get('/s/:token', async ({ req, res, params }: RouteContext) => {
    const clientKey = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.check(clientKey)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many requests');
      return;
    }

    const rawToken = params.token ?? '';
    const db = runtime.connection?.db;
    const resolved = db ? await resolveActiveQrToken(db, rawToken) : null;

    if (db && resolved) {
      const confirmHtml = await tryRenderConfirmPage(runtime, db, req, resolved, rawToken);
      if (confirmHtml !== null) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(confirmHtml);
        return;
      }
    }

    sendNeutralPage(res);
  });

  router.post('/s/:token/authorize', async ({ req, res, params }: RouteContext) => {
    const session = readSession(req, runtime);
    if (!session) {
      sendText(res, 401, 'Authentication required');
      return;
    }
    const db = runtime.connection?.db;
    if (!db) {
      sendText(res, 503, 'This action is not configured');
      return;
    }
    const resolved = await resolveActiveQrToken(db, params.token ?? '');
    if (!resolved) {
      sendText(res, 404, 'Unknown or inactive QR code');
      return;
    }
    const amountCents = await siteFixedPriceCents(db, resolved.siteId);
    if (amountCents === null) {
      sendText(res, 404, 'Site not found');
      return;
    }
    const decision = await authorizeAction(db, session.userId, {
      type: 'create_cleaning_request',
      siteId: resolved.siteId,
      bathroomId: resolved.bathroomId,
      amountCents,
    });
    if (!decision.allowed) {
      // Over-limit authorized user (SDD §10): record a pending approval instead of a hold.
      // No saved-method / step-up gate here -- recording an approval moves no money; the
      // manager's grant is what places the hold.
      if (decision.reason === 'exceeds_max_authorization') {
        await createRequestApproval(db, {
          siteId: resolved.siteId,
          bathroomId: resolved.bathroomId,
          requesterUserId: session.userId,
          priceVersion: 1,
          amountCents,
        });
        const [site] = await db
          .select({ name: sites.name })
          .from(sites)
          .where(eq(sites.id, resolved.siteId))
          .limit(1);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderApprovalPendingPage(site?.name ?? 'this site', amountCents));
        return;
      }
      sendText(res, 403, 'Forbidden');
      return;
    }
    // Placing a hold now requires a saved (mock) payment method (SDD §9.4) -- re-checked
    // here regardless of what the GET page showed, per "authorization precedes any
    // business logic" (§7). Reusing it further requires a recent authentication (§6.4);
    // this is the real enforcement point, not the GET page's re-authenticate prompt.
    const savedMethod = await getSitePaymentMethod(db, resolved.siteId);
    if (!savedMethod) {
      sendText(res, 409, 'Add a payment method before authorizing a hold');
      return;
    }
    if (!sessionAuthenticatedWithin(session, RECENT_AUTH_WINDOW_SECONDS)) {
      sendText(res, 401, 'Re-authentication required');
      return;
    }
    const { request } = await createCleaningRequest(db, gateway, {
      siteId: resolved.siteId,
      bathroomId: resolved.bathroomId,
      requestedByUserId: session.userId,
      amountCents,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAuthorizedPage(request.amountCents));
  });

  router.post('/s/:token/payment-method', async ({ req, res, params }: RouteContext) => {
    const session = readSession(req, runtime);
    if (!session) {
      sendText(res, 401, 'Authentication required');
      return;
    }
    const db = runtime.connection?.db;
    if (!db || !runtime.sessionSecret) {
      sendText(res, 503, 'This action is not configured');
      return;
    }
    const rawToken = params.token ?? '';
    const resolved = await resolveActiveQrToken(db, rawToken);
    if (!resolved) {
      sendText(res, 404, 'Unknown or inactive QR code');
      return;
    }
    const amountCents = await siteFixedPriceCents(db, resolved.siteId);
    if (amountCents === null) {
      sendText(res, 404, 'Site not found');
      return;
    }
    const decision = await authorizeAction(db, session.userId, {
      type: 'save_payment_method',
      siteId: resolved.siteId,
    });
    if (!decision.allowed) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    try {
      await saveSitePaymentMethod(db, resolved.siteId, session.userId);
    } catch (error) {
      if (error instanceof SitePaymentMethodAlreadyExistsError) {
        sendText(res, 409, error.message);
        return;
      }
      throw error;
    }
    const [site] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(eq(sites.id, resolved.siteId))
      .limit(1);
    if (!site) {
      sendText(res, 404, 'Site not found');
      return;
    }
    const csrfToken = csrfTokenForRequest(req, runtime.sessionSecret);
    const html = await renderSiteAuthorizedState(
      db,
      session,
      resolved.siteId,
      site.name,
      amountCents,
      rawToken,
      csrfToken,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}
