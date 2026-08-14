/**
 * Public QR scan resolution route (see SDD.md §5, §11.2).
 *
 * `GET /s/:token` performs a rate-limited, hash-based token lookup and then
 * renders the neutral "see staff" page. The response is identical regardless of
 * whether the token is active, revoked, or unknown, and regardless of whether
 * the site has an activated manager -- there is deliberately no oracle. The
 * handler creates no PaymentIntent, writes no data, and requires no session.
 */
import type { ServerResponse } from 'node:http';
import type { Router, RouteContext } from '../server/router.js';
import type { AuthRuntime } from '../auth/config.js';
import { FixedWindowRateLimiter } from '../server/rate-limit.js';
import { resolveActiveQrToken } from '../qr/tokens.js';
import { renderPublicScanPage } from '../render/templates/public-scan.js';

// Per-IP budget for scan resolution: enough for a genuine scanner retrying,
// low enough to blunt brute-force token enumeration (SDD §5).
const SCAN_LIMIT = 30;
const SCAN_WINDOW_MS = 60_000;

function sendNeutralPage(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPublicScanPage());
}

/**
 * Registers the public scan route. The rate limiter is injectable so tests can
 * drive the window deterministically; production uses the default policy.
 */
export function registerPublicRoutes(
  router: Router,
  runtime: AuthRuntime,
  limiter: FixedWindowRateLimiter = new FixedWindowRateLimiter({
    limit: SCAN_LIMIT,
    windowMs: SCAN_WINDOW_MS,
  }),
): void {
  router.get('/s/:token', async ({ req, res, params }: RouteContext) => {
    const clientKey = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.check(clientKey)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many requests');
      return;
    }

    // Resolve by one-way hash (SDD §5). The result is intentionally discarded:
    // the page is invariant so the endpoint cannot confirm a token's validity
    // or a site's activation state to an unauthenticated visitor.
    const db = runtime.connection?.db;
    if (db) {
      await resolveActiveQrToken(db, params.token ?? '');
    }

    sendNeutralPage(res);
  });
}
