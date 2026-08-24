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
 * (not-yet-accepted) member, and wrong-site manager; only an authorized
 * manager/authorized user at the resolved site sees the confirm page; the
 * authorize POST creates rows only for an authorized, CSRF-cleared, authenticated
 * caller.
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
import { saveSitePaymentMethod } from '../src/payments/service.js';
import { siteRoles, users, cleaningRequests, paymentAuthorizations } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const SESSION_SECRET = 'test-session-secret-placeholder';
// Step-up re-authentication window (SDD §6.4, §9.4): must match src/public/routes.ts.
const RECENT_AUTH_WINDOW_SECONDS = 300;

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

/** `nowSeconds` lets a test mint a session that is already stale for the step-up recency
 * check (SDD §6.4) while still being a validly-signed, unexpired session. */
function sessionAndCsrf(userId: string, nowSeconds?: number): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET, nowSeconds);
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

test('GET /s/:token: anonymous, no-role, pending-member, and wrong-site-manager callers all get the byte-identical neutral page', async () => {
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

    const pendingMemberId = await insertUser(db, 'sub-pending');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: pendingMemberId, role: 'authorized_user', status: 'pending' });
    const { cookie: pendingCookie } = sessionAndCsrf(pendingMemberId);

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

test('GET /s/:token: an authorized manager at a site with no saved payment method sees the add-method page (SDD §9.4)', async () => {
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
      assert.match(body, /Add a payment method \(mock\)/);
      assert.match(body, new RegExp(`/s/${rawToken}/payment-method`));
      assert.doesNotMatch(body, new RegExp(`/s/${rawToken}/authorize`));
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: a saved payment method and a recently-authenticated session shows the authorize form', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-recent');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    await saveSitePaymentMethod(db, siteId, managerId);
    const { cookie } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}`, {
        headers: { cookie: `rs_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /\$45\.00/);
      assert.match(body, /Mock Visa/);
      assert.match(body, new RegExp(`/s/${rawToken}/authorize`));
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: a saved payment method and a stale session shows a re-authenticate prompt, not an authorize form', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-stale');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    await saveSitePaymentMethod(db, siteId, managerId);
    const staleIat = Math.floor(Date.now() / 1000) - RECENT_AUTH_WINDOW_SECONDS - 30;
    const { cookie } = sessionAndCsrf(managerId, staleIat);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}`, {
        headers: { cookie: `rs_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /re-verify your identity/i);
      assert.match(body, new RegExp(`/auth/login\\?next=%2Fs%2F${rawToken}`));
      assert.doesNotMatch(body, new RegExp(`/s/${rawToken}/authorize`));
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: a manager is unlimited -- a tiny limit still shows the price-confirmation flow', async () => {
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
      // The manager clears the gate at any amount -> the confirm flow (here the add-method
      // state, which shows the price), never the neutral page.
      assert.match(await res.text(), /\$45\.00/);
    });
  } finally {
    await client.close();
  }
});

test('GET /s/:token: an authorized user over their limit sees the "request approval" affordance (SDD §10)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const userId = await insertUser(db, 'sub-over-limit-user');
    await db.insert(siteRoles).values({
      siteId,
      userId,
      role: 'authorized_user',
      status: 'authorized',
      maxAuthorizationCents: 1000,
    });
    const { cookie } = sessionAndCsrf(userId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}`, {
        headers: { cookie: `rs_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /\$45\.00/);
      assert.match(body, /above your authorization limit/i);
      assert.match(body, /Request manager approval/i);
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
    await saveSitePaymentMethod(db, siteId, managerId);
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

test('POST /s/:token/authorize is rejected 409 when the site has no saved payment method yet (SDD §9.4)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-no-method');
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
      assert.equal(res.status, 409);
    });

    assert.equal((await db.select().from(cleaningRequests)).length, 0);
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize is rejected 401 (step-up required) when the session predates the recency window (SDD §6.4)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-stale-authorize');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    await saveSitePaymentMethod(db, siteId, managerId);
    const staleIat = Math.floor(Date.now() / 1000) - RECENT_AUTH_WINDOW_SECONDS - 30;
    const { cookie, csrf } = sessionAndCsrf(managerId, staleIat);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/s/${rawToken}/authorize`, {
        method: 'POST',
        headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
      });
      assert.equal(res.status, 401);
    });

    assert.equal((await db.select().from(cleaningRequests)).length, 0);
  } finally {
    await client.close();
  }
});

test('POST /s/:token/authorize allows a concurrent double-tap: both attempts succeed as independent requests (SDD §9.4)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const managerId = await insertUser(db, 'sub-manager-double-tap');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    await saveSitePaymentMethod(db, siteId, managerId);
    const { cookie, csrf } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const authorize = () =>
        fetch(`${baseUrl}/s/${rawToken}/authorize`, {
          method: 'POST',
          headers: { cookie: `rs_session=${cookie}`, 'x-csrf-token': csrf },
        });
      const [first, second] = await Promise.all([authorize(), authorize()]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    });

    // Both attempts persisted as independent CleaningRequest rows -- no
    // per-bathroom cap (removed by explicit product decision, SDD §9.4).
    assert.equal((await db.select().from(cleaningRequests)).length, 2);
  } finally {
    await client.close();
  }
});

test('POST /s/:token/payment-method: denied for an authenticated customer, allowed for an authorized manager, then rejected 409 on repeat', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { rawToken, siteId } = await seedSiteAndToken(db, 4500);
    const customerId = await insertUser(db, 'sub-customer-payment-method');
    const { cookie: customerCookie, csrf: customerCsrf } = sessionAndCsrf(customerId);
    const managerId = await insertUser(db, 'sub-manager-payment-method');
    await db.insert(siteRoles).values({
      siteId,
      userId: managerId,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });
    const { cookie: managerCookie, csrf: managerCsrf } = sessionAndCsrf(managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/s/${rawToken}/payment-method`, {
        method: 'POST',
        headers: { cookie: `rs_session=${customerCookie}`, 'x-csrf-token': customerCsrf },
      });
      assert.equal(denied.status, 403);

      const allowed = await fetch(`${baseUrl}/s/${rawToken}/payment-method`, {
        method: 'POST',
        headers: { cookie: `rs_session=${managerCookie}`, 'x-csrf-token': managerCsrf },
      });
      assert.equal(allowed.status, 200);
      const body = await allowed.text();
      assert.match(body, /Mock Visa/);
      // Adding it also transitions straight into the authorize state, in the same response.
      assert.match(body, new RegExp(`/s/${rawToken}/authorize`));

      const repeat = await fetch(`${baseUrl}/s/${rawToken}/payment-method`, {
        method: 'POST',
        headers: { cookie: `rs_session=${managerCookie}`, 'x-csrf-token': managerCsrf },
      });
      assert.equal(repeat.status, 409);
    });
  } finally {
    await client.close();
  }
});
