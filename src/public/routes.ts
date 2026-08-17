/**
 * Public QR scan resolution + authenticated authorize-hold routes (see
 * SDD.md §5, §9.3, §11.2, §11.6).
 *
 * `GET /s/:token` performs a rate-limited, hash-based token lookup. For any
 * caller WITHOUT authorized site authority at the resolved site -- anonymous,
 * no SiteRole, a pending assistant, a manager authorized elsewhere -- the
 * response is the neutral "see staff" page, byte-for-byte identical whether
 * the token is active, revoked, or unknown, and whether or not the site has
 * an activated manager: there is deliberately no oracle for that population.
 * An authorized Manager/Assistant at the resolved site is the sole, deliberate
 * exception (§11.2): they see a price-confirmation page instead, gated by the
 * same deny-by-default matrix (§7) as every other authorized action.
 *
 * `POST /s/:token/authorize` places the hold (§9.3) for an authorized caller.
 */
import type { ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import type { AppDatabase } from '../db/client.js';
import { FixedWindowRateLimiter } from '../server/rate-limit.js';
import { resolveActiveQrToken, type ResolvedQrTarget } from '../qr/tokens.js';
import { renderPublicScanPage } from '../render/templates/public-scan.js';
import { renderAuthorizedPage, renderConfirmPage } from '../render/templates/confirm.js';
import { readSession } from '../auth/guard.js';
import { authorizeAction } from '../auth/enforce.js';
import { parseCookies } from '../auth/cookies.js';
import { SESSION_COOKIE } from '../auth/routes.js';
import { csrfTokenForSession } from '../auth/csrf.js';
import { sendText } from '../server/respond.js';
import { sites } from '../db/schema.js';
import { createCleaningRequest } from '../payments/service.js';
import { MockPaymentGateway, type PaymentGateway } from '../payments/gateway.js';

// Per-IP budget for scan resolution: enough for a genuine scanner retrying,
// low enough to blunt brute-force token enumeration (SDD §5).
const SCAN_LIMIT = 30;
const SCAN_WINDOW_MS = 60_000;

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
 * Renders the confirmation page for an already-authorized caller, or null if
 * this caller/token combination does not clear the matrix -- in which case
 * the handler falls back to the unchanged neutral page.
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
  if (!decision.allowed || !runtime.sessionSecret) {
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
  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
  const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
  return renderConfirmPage({ siteName: site.name, amountCents, token: rawToken, csrfToken });
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
      sendText(res, 403, 'Forbidden');
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
}
