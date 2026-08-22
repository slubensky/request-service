/**
 * `createHttpServer` (src/server/app.ts) branches on `TLS_CERT_FILE`/`TLS_KEY_FILE`:
 * both set -> HTTPS, otherwise plain HTTP (SDD §12/§13, changelog #014). `test-cert.pem`/
 * `test-key.pem` are throwaway, ten-year self-signed fixtures for `localhost` generated
 * once for this suite -- not a real credential, never used outside a loopback test server.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer, request as httpsRequest } from 'node:https';
import { createHttpServer } from '../src/server/app.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const certFile = path.join(currentDir, 'fixtures/tls/test-cert.pem');
const keyFile = path.join(currentDir, 'fixtures/tls/test-key.pem');
const caCert = readFileSync(certFile, 'utf8');

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test('createHttpServer serves plain HTTP when TLS_CERT_FILE/TLS_KEY_FILE are unset', async () => {
  await withEnv({ TLS_CERT_FILE: undefined, TLS_KEY_FILE: undefined }, () => {
    const server = createHttpServer();
    assert.ok(server instanceof HttpServer);
    assert.ok(!(server instanceof HttpsServer));
    return Promise.resolve();
  });
});

test('createHttpServer serves HTTPS when TLS_CERT_FILE/TLS_KEY_FILE are both set', async () => {
  await withEnv({ TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile }, async () => {
    const server = createHttpServer();
    assert.ok(server instanceof HttpsServer);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // Node's global `fetch` (undici) has no simple per-request custom-CA option, so this
      // drives a real TLS handshake via `node:https` directly -- trusting only this
      // throwaway fixture's own CA, not the system trust store.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpsRequest(
          { host: 'localhost', port, path: '/healthz', ca: caCert },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
