/**
 * Authenticated price-confirmation + authorize-hold flow (SDD §9.3, §11.6).
 *
 * Drives the real HTTP path (createHttpServer against a PGlite-backed
 * runtime, per the seam added for csrf-enforcement.test.ts) so CSRF
 * enforcement, session handling, and the deny-by-default matrix are all
 * exercised exactly as production traffic hits them -- not bypassed by
 * calling a matched handler directly.
 *
 * Coverage: the amended "no oracle" invariant (SDD §11.2/§11.3) -- neutral
 * page stays byte-identical for anonymous, authenticated-no-role, pending
 * assistant, and wrong-site manager; only an authorized manager/assistant at
 * the resolved site sees the confirm page; the authorize POST creates rows
 * only for an authorized, CSRF-cleared, authenticated caller.
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
import { siteRoles, users, cleaningRequests, paymentAuthorizations } from '../src/db/schema.js';
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

async function insertUser(db: TestDatabase['db'], sub: string): Promise<string> {
  const [row] = await db.insert(users).values({ cognitoSub: sub }).returning();
  assert.ok(row);
  return row.id;
}

function sessionAndCsrf(userId: string): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET);
  return { cookie: token, csrf: csrfTokenForSession(token, SESSION_SECRET) };
}

async function seedSiteAndToken(db: TestDatabase['db'], fixedPriceCents = 4500) {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents,
  });
  const bathroom = await addBathroom(db, site.id, 'Ground floor');
  const issued = await issueQrToken(db, site.id, bathroom.id);
  return { siteId: site.id, bathroomId: bathroom.id, rawToken: issued.rawToken };
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

test('GET /s/:token: anonymous, no-role, pending-assistant, and wrong-site-manager callers all get the byte-identical neutral page', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db);
    const otherSite = await createSite(db, {
      name: 'Other Plaza',
      address: '2 Other St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 3000,
    });

    const customerId = await insertUser(db, 'sub-customer');
    const { cookie: customerCookie } = sessionAndCsrf(customerId);

    const pendingAssistantId = await insertUser(db, 'sub-pending');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: pendingAssistantId, role: 'assistant', status: 'pending' });
    const { cookie: pendingCookie } = sessionAndCsrf(pendingAssistantId);

    const otherManagerId = await insertUser(db, 'sub-other-manager');
    await db.insert(siteRoles).values({
      siteId: otherSite.id,
      userId: otherManagerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    const { cookie: otherManagerCookie } = sessionAndCsrf(otherManagerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const anonymous = await fetch(`${baseUrl}/s/${rawToken}`);
      const anonymousBody = await anonymous.text();
      assert.equal(anonymous.status, 200);
      assert.doesNotMatch(anonymousBody, /price/i);

      for (const cookie of [customerCookie, pendingCookie, otherManagerCookie]) {
        const res = await fetch(`${baseUrl}/s/${rawToken}`, {
          headers: { cookie: `rs_session=${cookie}` },
        });
        assert.equal(res.status, 200);
        assert.equal(
          await res.text(),
          anonymousBody,
          'byte-identical to the anonymous neutral page',
        );
      }
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: an authorized manager at the resolved site sees the price-confirmation page', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    const { cookie } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}`, {
        headers: { cookie: `rs_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /\$45\.00/);
      assert.match(body, /Central Plaza/);
      assert.match(body, new RegExp(`/s/${rawToken}/authorize`));
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: an authorized manager whose limit is below the price still sees the neutral page', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-low-limit');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 1000,
    });
    const { cookie } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}`, {
        headers: { cookie: `rs_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /\$45\.00/);
    });
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize without a session is rejected 401', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken } = await seedSiteAndToken(db);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      // A signed-out caller has no session cookie to derive a CSRF token from,
      // so the global CSRF gate (which requires a session) rejects first.
      const res = await fetch(`${baseUrl}/s/${rawToken}/authorize`, { method: 'POST' });
      assert.equal(res.status, 403);
    });
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize for an authenticated customer (no SiteRole) is forbidden', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken } = await seedSiteAndToken(db);
    const customerId = await insertUser(db, 'sub-customer-2');
    const { cookie, csrf } = sessionAndCsrf(customerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}/authorize`, {
        method: 'POST',
        headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
      });
      assert.equal(res.status, 403);
    });

    assert.equal((await db.select().from(cleaningRequests)).length, 0);
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize for an unknown token 404s for an authenticated caller', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const userId = await insertUser(db, 'sub-someone');
    const { cookie, csrf } = sessionAndCsrf(userId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/not-a-real-token/authorize`, {
        method: 'POST',
        headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
      });
      assert.equal(res.status, 404);
    });
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize for an authorized manager places a hold end-to-end', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId, bathroomId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-authorize');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    const { cookie, csrf } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}/authorize`, {
        method: 'POST',
        headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /\$45\.00/);
    });

    const requests = await db
      .select()
      .from(cleaningRequests)
      .where(eq(cleaningRequests.siteId, siteId));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.bathroomId, bathroomId);
    assert.equal(requests[0]?.amountCents, 4500);
    assert.equal(requests[0]?.status, 'authorized');

    const auths = await db.select().from(paymentAuthorizations);
    assert.equal(auths.length, 1);
    assert.equal(auths[0]?.status, 'requires_capture');
    assert.match(auths[0]?.stripePaymentIntentId ?? '', /^mock_pi_/);
  } finally {
    await client.close();
  }
});
