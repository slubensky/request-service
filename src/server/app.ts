import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../../public');

function buildRouter(runtime: AuthRuntime): Router {
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
  registerAdminRoutes(router, runtime);
  registerManagerRoutes(router, runtime);
  registerPublicRoutes(router, runtime);
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
 */
export function createAppForRuntime(
  runtime: AuthRuntime,
): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter(runtime);

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

/** Builds the request listener from the environment-sourced runtime (production entry point). */
export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  return createAppForRuntime(getAuthRuntime());
}

/** Optionally accepts a runtime override so tests can exercise the real HTTP path against PGlite. */
export function createHttpServer(runtime?: AuthRuntime): Server {
  return createServer(runtime ? createAppForRuntime(runtime) : createApp());
}
