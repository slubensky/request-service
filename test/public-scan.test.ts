import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHttpServer } from '../src/server/app.js';
import { Router } from '../src/server/router.js';
import { registerPublicRoutes } from '../src/public/routes.js';
import { renderPublicScanPage } from '../src/render/templates/public-scan.js';
import { FixedWindowRateLimiter } from '../src/server/rate-limit.js';
import type { AuthRuntime } from '../src/auth/config.js';
import { createTestDatabase } from './helpers/pglite.js';
import { addBathroom, createSite, issueQrToken } from '../src/admin/service.js';

// Fields that would leak billing/identity/operational state. The neutral page
// must contain none of them, in any casing.
const FORBIDDEN = [
  'price',
  'billing',
  'amount',
  'manager',
  'queue',
  'history',
  'paymentintent',
  '$',
];

function assertNeutral(body: string): void {
  const lower = body.toLowerCase();
  for (const term of FORBIDDEN) {
    assert.equal(lower.includes(term), false, `neutral page leaked "${term}"`);
  }
}

test('the public scan page is neutral and ships zero client JS', () => {
  const html = renderPublicScanPage();
  assertNeutral(html);
  // Zero-JS budget for the public page: no module scripts at all.
  assert.equal(/<script/.test(html), false);
  assert.match(html, /notify on-site staff/i);
});

test('GET /s/:token returns the neutral page and sets no session cookie', async () => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/s/any-token-value`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('set-cookie'), null);
    assertNeutral(await res.text());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

/** Minimal ServerResponse capture for driving a handler without a socket. */
interface CapturedResponse {
  res: ServerResponse;
  read: () => { status: number; body: string };
}

function captureResponse(): CapturedResponse {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

function fakeRequest(remoteAddress: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: {} } as unknown as IncomingMessage;
}

test('an active token and an unknown token yield byte-identical pages (no oracle)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const site = await createSite(db, {
      name: 'Central Plaza',
      address: '1 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    });
    const bathroom = await addBathroom(db, site.id, 'Ground floor');
    const issued = await issueQrToken(db, site.id, bathroom.id);

    const runtime = { connection: { db } } as unknown as AuthRuntime;
    const router = new Router();
    registerPublicRoutes(router, runtime);

    async function scan(token: string): Promise<{ status: number; body: string }> {
      const match = router.match('GET', `/s/${token}`);
      assert.ok(match);
      const captured = captureResponse();
      await match.handler({
        req: fakeRequest('203.0.113.10'),
        res: captured.res,
        params: match.params,
        query: {},
      });
      return captured.read();
    }

    const active = await scan(issued.rawToken);
    const unknown = await scan('definitely-not-a-real-token');
    assert.equal(active.status, 200);
    assert.equal(unknown.status, 200);
    // Resolving a valid token must not change the response in any way.
    assert.equal(active.body, unknown.body);
    assertNeutral(active.body);
  } finally {
    await client.close();
  }
});

test('the scan rate limiter permits a burst then denies, and recovers next window', () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 1_000, now: () => now });

  assert.equal(limiter.check('ip-a'), true);
  assert.equal(limiter.check('ip-a'), true);
  assert.equal(limiter.check('ip-a'), true);
  // Fourth request in the same window is denied.
  assert.equal(limiter.check('ip-a'), false);
  // A different key has its own budget.
  assert.equal(limiter.check('ip-b'), true);

  // The window advances; the key recovers.
  now += 1_000;
  assert.equal(limiter.check('ip-a'), true);
});
