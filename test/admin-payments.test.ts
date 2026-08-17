/**
 * Company-Admin outstanding-holds console: capture/cancel (SDD §9.1 step 3,
 * §9.3, §11.6). Drives the real HTTP path so CSRF, the platform-only gate,
 * and the site-resolved-from-the-target (not a client claim) behavior are all
 * exercised as production traffic hits them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { createHttpServer } from '../src/server/app.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { PgConnection } from '../src/db/client.js';
import { csrfTokenForSession } from '../src/auth/csrf.js';
import { signSession } from '../src/auth/session.js';
import { createSite, addBathroom, issueQrToken } from '../src/admin/service.js';
import { siteRoles, users, paymentAuthorizations } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

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

async function insertUser(db: TestDatabase['db'], sub: string, admin: boolean): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ cognitoSub: sub, platformRole: admin ? 'company_admin' : 'member' })
    .returning();
  assert.ok(row);
  return row.id;
}

function sessionAndCsrf(userId: string): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET);
  return { cookie: token, csrf: csrfTokenForSession(token, SESSION_SECRET) };
}

async function withRunningServer<T>(
  runtime: AuthRuntime,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/** Places one hold end-to-end via the real HTTP authorize route, so it shares the
 * same in-process mocked gateway a subsequent capture/cancel call on the same
 * server will observe (SDD §9.3). */
async function authorizeOneHold(
  baseUrl: string,
  db: TestDatabase['db'],
  siteId: string,
  fixedPriceCents: number,
): Promise<void> {
  const bathroom = await addBathroom(db, siteId, 'Ground floor');
  const issued = await issueQrToken(db, siteId, bathroom.id);
  const managerId = await insertUser(db, `sub-manager-${bathroom.id}`, false);
  await db.insert(siteRoles).values({
    siteId,
    userId: managerId,
    role: 'manager',
    status: 'authorized',
    maxAuthorizationCents: fixedPriceCents,
  });
  const { cookie, csrf } = sessionAndCsrf(managerId);
  const res = await fetch(`${baseUrl}/s/${issued.rawToken}/authorize`, {
    method: 'POST',
    headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
  });
  assert.equal(res.status, 200);
}

test('GET /admin/payments is denied for a non-admin and allowed for a company_admin', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const memberId = await insertUser(db, 'sub-member', false);
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie: memberCookie } = sessionAndCsrf(memberId);
    const { cookie: adminCookie } = sessionAndCsrf(adminId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/admin/payments`, {
        headers: { cookie: `rs_session=${memberCookie}` },
      });
      assert.equal(denied.status, 403);

      const allowed = await fetch(`${baseUrl}/admin/payments`, {
        headers: { cookie: `rs_session=${adminCookie}` },
      });
      assert.equal(allowed.status, 200);
      assert.match(await allowed.text(), /No outstanding holds/);
    });
  } finally {
    await client.close();
  }
});

test('GET /admin/payments lists an outstanding hold placed via the authorize route', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const site = await createSite(db, {
      name: 'Central Plaza',
      address: '1 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    });
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie: adminCookie } = sessionAndCsrf(adminId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      await authorizeOneHold(baseUrl, db, site.id, 4500);

      const res = await fetch(`${baseUrl}/admin/payments`, {
        headers: { cookie: `rs_session=${adminCookie}` },
      });
      const body = await res.text();
      assert.match(body, /\$45\.00/);
      assert.doesNotMatch(body, /No outstanding holds/);
    });
  } finally {
    await client.close();
  }
});

test('POST /admin/payments/:id/capture: denied for a manager, allowed for a company_admin, then transitions the row', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const site = await createSite(db, {
      name: 'Central Plaza',
      address: '1 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    });
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie: adminCookie, csrf: adminCsrf } = sessionAndCsrf(adminId);
    const managerId = await insertUser(db, 'sub-manager-capture', false);
    await db.insert(siteRoles).values({
      siteId: site.id,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    const { cookie: managerCookie, csrf: managerCsrf } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      await authorizeOneHold(baseUrl, db, site.id, 4500);
      const [pending] = await db.select().from(paymentAuthorizations);
      assert.ok(pending);

      // A Site Manager can authorize a hold but can never capture (SDD §9.1, §9.2).
      const deniedRes = await fetch(`${baseUrl}/admin/payments/${pending.id}/capture`, {
        method: 'POST',
        headers: { cookie: `rs_session=${managerCookie}`, 'x-csrf-token': managerCsrf },
      });
      assert.equal(deniedRes.status, 403);

      const captureRes = await fetch(`${baseUrl}/admin/payments/${pending.id}/capture`, {
        method: 'POST',
        headers: { cookie: `rs_session=${adminCookie}`, 'x-csrf-token': adminCsrf },
      });
      assert.equal(captureRes.status, 204);

      // A second capture of the same, now-captured hold is a clean 409, not a 500.
      const repeatRes = await fetch(`${baseUrl}/admin/payments/${pending.id}/capture`, {
        method: 'POST',
        headers: { cookie: `rs_session=${adminCookie}`, 'x-csrf-token': adminCsrf },
      });
      assert.equal(repeatRes.status, 409);
    });

    const [row] = await db
      .select()
      .from(paymentAuthorizations)
      .where(eq(paymentAuthorizations.status, 'captured'));
    assert.ok(row, 'the authorization is captured');
  } finally {
    await client.close();
  }
});

test('POST /admin/payments/:id/cancel releases the hold', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const site = await createSite(db, {
      name: 'Central Plaza',
      address: '1 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    });
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie: adminCookie, csrf: adminCsrf } = sessionAndCsrf(adminId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      await authorizeOneHold(baseUrl, db, site.id, 4500);
      const [pending] = await db.select().from(paymentAuthorizations);
      assert.ok(pending);

      const res = await fetch(`${baseUrl}/admin/payments/${pending.id}/cancel`, {
        method: 'POST',
        headers: { cookie: `rs_session=${adminCookie}`, 'x-csrf-token': adminCsrf },
      });
      assert.equal(res.status, 204);
    });

    const [row] = await db
      .select()
      .from(paymentAuthorizations)
      .where(eq(paymentAuthorizations.status, 'canceled'));
    assert.ok(row, 'the authorization is canceled');
  } finally {
    await client.close();
  }
});

test('POST /admin/payments/:id/capture for an unknown id 404s', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie, csrf } = sessionAndCsrf(adminId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/admin/payments/00000000-0000-0000-0000-000000000000/capture`,
        { method: 'POST', headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf } },
      );
      assert.equal(res.status, 404);
    });
  } finally {
    await client.close();
  }
});
