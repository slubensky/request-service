import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { serveStaticFile } from './static.js';
import { renderHomePage } from '../render/templates/home.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../../public');

function buildRouter(): Router {
  const router = new Router();

  router.get('/healthz', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  router.get('/', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHomePage());
  });

  return router;
}

function parseUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost';
  return new URL(req.url ?? '/', `http://${host}`);
}

/**
 * Builds the request listener: static assets first, then routed handlers,
 * falling back to a plain 404. This is the single trust boundary for the
 * app -- every response is produced here, nowhere else.
 */
export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  const router = buildRouter();

  return (req, res) => {
    const method = req.method ?? 'GET';
    const url = parseUrl(req);

    void (async () => {
      if (method === 'GET' && (await serveStaticFile(publicDir, url.pathname, res))) {
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

export function createHttpServer(): Server {
  return createServer(createApp());
}
