/**
 * HTTP-level CSRF and body-size enforcement tests.
 *
 * Every prior route test (admin.test.ts, manager.test.ts, sms-otp.test.ts,
 * passkey.test.ts, demo-invite.test.ts) either calls the service layer
 * directly or invokes a matched route handler in isolation -- none of them go
 * through `createApp()`'s actual request listener, which is where the global
 * session-bound CSRF gate (`passesCsrf`, src/auth/guard.ts) and the request
 * body size cap (src/server/body.ts) actually live. That gate had zero
 * coverage above the pure-function level: nothing proved a real POST to
 * `/admin/sites` or `/manager/sites/:id/invites` without a valid CSRF token
 * is actually rejected, or that a valid token minted for the console is
 * actually accepted end-to-end.
 *
 * `createAppForRuntime` (src/server/app.ts) exists so this suite can drive the
 * real HTTP path -- CSRF gate, router dispatch, auth gate, body parsing, all
 * of it -- against a PGlite-backed runtime instead of the environment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../src/server/app.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { PgConnection } from '../src/db/client.js';
import { csrfTokenForSession } from '../src/auth/csrf.js';
import { signSession } from '../src/auth/session.js';
import { sites, users } from '../src/db/schema.js';
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

/** A signed session cookie value plus the CSRF token derived from it. */
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

const SITE_FORM = new URLSearchParams({
  name: 'Central Plaza',
  address: '1 Market St',
  timezone: 'America/New_York',
  currency: 'usd',
  fixed_price_cents: '4500',
}).toString();

test('POST /admin/sites with no session at all is rejected by the CSRF gate before any auth check', async () => {
  const { db, client } = await createTestDatabase();
  try {
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: SITE_FORM,
      });
      assert.equal(res.status, 403);
      assert.equal(await res.text(), 'Forbidden');
    });
  } finally {
    await client.close();
  }
});

test('POST /admin/sites with a valid session but no x-csrf-token header is rejected', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie } = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `rs_session=${cookie}`,
        },
        body: SITE_FORM,
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await client.close();
  }
});

test('POST /admin/sites with a mismatched x-csrf-token header is rejected', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie } = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `rs_session=${cookie}`,
          'x-csrf-token': 'not-the-real-token',
        },
        body: SITE_FORM,
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await client.close();
  }
});

test('POST /admin/sites with a valid session + CSRF token but a non-admin identity is forbidden by the authorization gate, not the CSRF gate', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const memberId = await insertUser(db, 'sub-member', false);
    const { cookie, csrf } = sessionAndCsrf(memberId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `rs_session=${cookie}`,
          'x-csrf-token': csrf,
        },
        body: SITE_FORM,
      });
      // CSRF cleared, so this reaches authorizeOrReject -- and is denied there.
      assert.equal(res.status, 403);
      assert.equal(await res.text(), 'Forbidden');
    });
  } finally {
    await client.close();
  }
});

test('POST /admin/sites with a valid session + matching CSRF token from a company_admin succeeds end-to-end', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie, csrf } = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `rs_session=${cookie}`,
          'x-csrf-token': csrf,
        },
        body: SITE_FORM,
      });
      assert.equal(res.status, 204);
    });

    const rows = await db.select().from(sites);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, 'Central Plaza');
  } finally {
    await client.close();
  }
});

test('a request body over the size cap is rejected with 413, even from an authorized, CSRF-cleared caller', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const adminId = await insertUser(db, 'sub-admin', true);
    const { cookie, csrf } = sessionAndCsrf(adminId);
    const oversized = `name=${'a'.repeat(20 * 1024)}`;
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `rs_session=${cookie}`,
          'x-csrf-token': csrf,
        },
        body: oversized,
      });
      assert.equal(res.status, 413);
      assert.equal(await res.text(), 'Payload too large');
    });

    const rows = await db.select().from(sites);
    assert.equal(rows.length, 0, 'the oversized request created nothing');
  } finally {
    await client.close();
  }
});
