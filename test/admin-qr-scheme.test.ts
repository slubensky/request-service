/**
 * `POST /admin/sites/:siteId/bathrooms/:bathroomId/qr`'s printed scan URL must match the
 * scheme the request actually arrived over (SDD §5, changelog #015) -- previously hardcoded
 * to `http://` whenever `PUBLIC_BASE_URL` was unset, which was wrong as soon as local dev
 * started requiring real HTTPS (changelog #014). Driven over real HTTP and real HTTPS
 * (against a throwaway fixture cert, matching `test/tls-server.test.ts`) so this exercises
 * the actual `req.socket.encrypted` check, not a mock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHttpServer } from '../src/server/app.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { PgConnection } from '../src/db/client.js';
import { csrfTokenForSession } from '../src/auth/csrf.js';
import { signSession } from '../src/auth/session.js';
import { addBathroom, createSite } from '../src/admin/service.js';
import { users } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const certFile = path.join(currentDir, 'fixtures/tls/test-cert.pem');
const keyFile = path.join(currentDir, 'fixtures/tls/test-key.pem');
const caCert = readFileSync(certFile, 'utf8');

const SESSION_SECRET = 'test-session-secret-placeholder';

function runtimeFor(db: TestDatabase['db']): AuthRuntime {
  return {
    cognito: null,
    sessionSecret: SESSION_SECRET,
    connection: { db, pool: undefined } as unknown as PgConnection,
    jwksFor: () => {
      throw new Error('jwks must not be resolved by these routes');
    },
  };
}

function sessionAndCsrf(userId: string): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET);
  return { cookie: token, csrf: csrfTokenForSession(token, SESSION_SECRET) };
}

async function seed(db: TestDatabase['db']) {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  const bathroom = await addBathroom(db, site.id, 'Ground floor');
  const [admin] = await db
    .insert(users)
    .values({ cognitoSub: 'sub-admin', platformRole: 'company_admin' })
    .returning();
  assert.ok(admin);
  return { siteId: site.id, bathroomId: bathroom.id, adminId: admin.id };
}

async function issueQrOverHttp(
  runtime: AuthRuntime,
  siteId: string,
  bathroomId: string,
  admin: { cookie: string; csrf: string },
): Promise<string> {
  const previousCert = process.env.TLS_CERT_FILE;
  const previousKey = process.env.TLS_KEY_FILE;
  delete process.env.TLS_CERT_FILE;
  delete process.env.TLS_KEY_FILE;
  try {
    const server = createHttpServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${port}/admin/sites/${siteId}/bathrooms/${bathroomId}/qr`,
        {
          method: 'POST',
          headers: { cookie: `rs_session=${admin.cookie}`, 'x-csrf-token': admin.csrf },
        },
      );
      assert.equal(res.status, 200);
      return await res.text();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    if (previousCert === undefined) delete process.env.TLS_CERT_FILE;
    else process.env.TLS_CERT_FILE = previousCert;
    if (previousKey === undefined) delete process.env.TLS_KEY_FILE;
    else process.env.TLS_KEY_FILE = previousKey;
  }
}

async function issueQrOverHttps(
  runtime: AuthRuntime,
  siteId: string,
  bathroomId: string,
  admin: { cookie: string; csrf: string },
): Promise<string> {
  const previousCert = process.env.TLS_CERT_FILE;
  const previousKey = process.env.TLS_KEY_FILE;
  process.env.TLS_CERT_FILE = certFile;
  process.env.TLS_KEY_FILE = keyFile;
  try {
    const server = createHttpServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise<string>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: 'localhost',
            port,
            path: `/admin/sites/${siteId}/bathrooms/${bathroomId}/qr`,
            method: 'POST',
            ca: caCert,
            headers: { cookie: `rs_session=${admin.cookie}`, 'x-csrf-token': admin.csrf },
          },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => (body += chunk.toString()));
            response.on('end', () => {
              assert.equal(response.statusCode, 200);
              resolve(body);
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    if (previousCert === undefined) delete process.env.TLS_CERT_FILE;
    else process.env.TLS_CERT_FILE = previousCert;
    if (previousKey === undefined) delete process.env.TLS_KEY_FILE;
    else process.env.TLS_KEY_FILE = previousKey;
  }
}

test('issuing a QR over plain HTTP prints an http:// scan URL', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, adminId } = await seed(db);
    const admin = sessionAndCsrf(adminId);
    const body = await issueQrOverHttp(runtimeFor(db), siteId, bathroomId, admin);
    assert.match(body, /Scan target:/);
    assert.match(body, /href="http:\/\/127\.0\.0\.1:\d+\/s\//);
    assert.doesNotMatch(body, /href="https:\/\//);
  } finally {
    await client.close();
  }
});

test('issuing a QR over real HTTPS prints an https:// scan URL', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, adminId } = await seed(db);
    const admin = sessionAndCsrf(adminId);
    const body = await issueQrOverHttps(runtimeFor(db), siteId, bathroomId, admin);
    assert.match(body, /Scan target:/);
    assert.match(body, /href="https:\/\/localhost:\d+\/s\//);
  } finally {
    await client.close();
  }
});

test('issuing a QR for a bathroom that does not belong to the site 404s', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId } = await seed(db);
    const admin = sessionAndCsrf(adminId);
    const otherSite = await createSite(db, {
      name: 'Other Plaza',
      address: '2 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    });
    const otherBathroom = await addBathroom(db, otherSite.id, 'Mezzanine');
    delete process.env.TLS_CERT_FILE;
    delete process.env.TLS_KEY_FILE;
    const server = createHttpServer(runtimeFor(db));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${port}/admin/sites/${siteId}/bathrooms/${otherBathroom.id}/qr`,
        {
          method: 'POST',
          headers: { cookie: `rs_session=${admin.cookie}`, 'x-csrf-token': admin.csrf },
        },
      );
      assert.equal(res.status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    await client.close();
  }
});
