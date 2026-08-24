import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { serveStaticFile } from './static.js';
import { renderHomePage } from '../render/templates/home.js';
import { getAuthRuntime } from '../auth/config.js';
import { registerAuthRoutes } from '../auth/routes.js';
import { registerAdminRoutes } from '../admin/routes.js';
import { registerManagerRoutes } from '../manager/routes.js';
import { registerPublicRoutes } from '../public/routes.js';
import { registerDemoRoutes, isDemoAcceptSubmission } from '../demo/routes.js';
import { passesCsrf } from '../auth/guard.js';
import type { AuthRuntime } from '../auth/config.js';
import { MockPaymentGateway } from '../payments/gateway.js';
import { MockSmsGateway, type SmsGateway } from '../sms/gateway.js';
import { SnsSmsGateway } from '../sms/sns-gateway.js';
import { isDemoMode } from '../demo/config.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../../public');

function buildRouter(runtime: AuthRuntime, smsGateway: SmsGateway): Router {
  const router = new Router();

  router.get('/healthz', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  router.get('/', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHomePage());
  });

  registerAuthRoutes(router, runtime);
  // One mocked payment gateway instance shared by both routes so a capture/
  // cancel observes the same in-process gateway an authorize went through
  // (SDD §9.3) -- not Stripe; see src/payments/gateway.ts.
  const paymentGateway = new MockPaymentGateway();
  registerAdminRoutes(router, runtime, paymentGateway, smsGateway);
  registerManagerRoutes(router, runtime, paymentGateway, undefined, smsGateway);
  registerPublicRoutes(router, runtime, undefined, paymentGateway);
  // Demo invite-code acceptance (SDD §6.3): registers nothing unless DEMO_MODE is on.
  registerDemoRoutes(router, runtime);

  return router;
}

function parseUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost';
  return new URL(req.url ?? '/', `http://${host}`);
}

/**
 * Builds the request listener for a given runtime: static assets first, then
 * routed handlers, falling back to a plain 404. This is the single trust
 * boundary for the app -- every response is produced here, nowhere else.
 *
 * Runtime is a parameter (not read from the environment internally) so tests
 * can drive the *real* HTTP path -- including the CSRF gate below, which lives
 * only in this closure -- against a PGlite-backed runtime, the same way
 * `createApp()` drives it against the environment-sourced one.
 *
 * `smsGateway` defaults to a fresh `MockSmsGateway` -- same as the payment
 * gateway, real delivery is never the default here, so a test driving this
 * path (all of them, PGlite-backed) can never trigger a real AWS call
 * regardless of `DEMO_MODE`. `createApp()` below is the only caller that
 * opts into real delivery.
 */
export function createAppForRuntime(
  runtime: AuthRuntime,
  smsGateway: SmsGateway = new MockSmsGateway(),
): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(runtime, smsGateway);

  return (req, res) => {
    const method = req.method ?? 'GET';
    const url = parseUrl(req);

    void (async () => {
      if (method === 'GET' && (await serveStaticFile(publicDir, url.pathname, res))) {
        return;
      }

      // Complete mediation: reject state-changing requests that fail CSRF before
      // any handler runs or any side effect can occur. The demo accept POST (SDD
      // §6.3) is the sole exemption -- it is a pre-session flow that carries its
      // own origin-bound double-submit token, and the exemption is itself
      // DEMO_MODE-gated, so this branch is never taken in production.
      if (!isDemoAcceptSubmission(method, url.pathname) && !passesCsrf(req, runtime)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const match = router.match(method, url.pathname);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        query[key] = value;
      }

      await match.handler({ req, res, params: match.params, query });
    })().catch((error: unknown) => {
      // eslint-disable-next-line no-console -- minimal scaffold logging; replaced by structured logging in a later phase.
      console.error('Unhandled request error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal server error');
    });
  };
}

/**
 * Builds the request listener from the environment-sourced runtime (production entry
 * point). The one place real SMS delivery (src/sms/sns-gateway.ts) is selected -- every
 * real deployment (SDD §6.3's accept-code loop is DEMO_MODE-only, so this is the
 * production/lean-deployment path); MockSmsGateway under DEMO_MODE, so local dev never
 * attempts a real AWS call.
 */
export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  const smsGateway: SmsGateway = isDemoMode() ? new MockSmsGateway() : new SnsSmsGateway();
  return createAppForRuntime(getAuthRuntime(), smsGateway);
}

/**
 * Optionally accepts a runtime override so tests can exercise the real HTTP path against
 * PGlite. Serves over HTTPS when `TLS_CERT_FILE`/`TLS_KEY_FILE` are both set, otherwise plain
 * HTTP -- unchanged, which is what tests (neither var set) and production (TLS terminated at
 * the reverse proxy, per SDD §13) use. `src/index.ts` requires these locally: cookies are
 * unconditionally `Secure` (SDD §12), which a browser without a "localhost is a secure
 * context" exception silently drops over plain HTTP (SDD changelog #014).
 *
 * `smsGateway` is forwarded to `createAppForRuntime` only when a `runtime` override is also
 * given (test path); the environment-sourced production path (`createApp()`) always makes
 * its own real-vs-mock choice and ignores this parameter, so a test can never accidentally
 * flip it.
 */
export function createHttpServer(
  runtime?: AuthRuntime,
  smsGateway?: SmsGateway,
): Server | HttpsServer {
  const handler = runtime ? createAppForRuntime(runtime, smsGateway) : createApp();
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (certFile && keyFile) {
    return createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler);
  }
  return createServer(handler);
}
