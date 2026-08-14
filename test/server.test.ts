import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../src/server/app.js';

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    // fetch's keep-alive socket would otherwise hold a graceful server.close()
    // open until the client's idle timeout fires; force-close it instead so
    // each test tears down immediately.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('GET /healthz returns a JSON ok status', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('GET / renders the SSR home page', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /Request Service/);
  });
});

test('GET /css/base.css serves the static stylesheet', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/css/base.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    const body = await res.text();
    assert.match(body, /--color-bg/);
  });
});

test('unknown routes return 404', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

// Path-traversal containment for serveStaticFile itself is unit-tested
// directly in test/static.test.ts: WHATWG URL parsing (used here for
// req.url) already collapses literal ".." segments before a pathname ever
// reaches this server, so an HTTP-level traversal request can't be
// constructed to exercise the guard -- it must be tested beneath that layer.
