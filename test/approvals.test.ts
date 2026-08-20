/**
 * Over-limit request approval tests (SDD §10). Service-level against PGlite plus
 * one real-HTTP end-to-end (createHttpServer) covering an authorized user's
 * over-limit request -> pending approval -> a manager grants it -> the hold is
 * placed. Exercises the deny-by-default matrix and CSRF exactly as production.
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
import {
  approveRequest,
  createRequestApproval,
  findPendingApproval,
  listPendingApprovalsForSites,
  loadRequestApproval,
  InvalidApprovalStateError,
  RequestApprovalNotFoundError,
} from '../src/payments/approvals.js';
import { MockPaymentGateway } from '../src/payments/gateway.js';
import { cleaningRequests, requestApprovals, siteRoles, sites, users } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const SESSION_SECRET = 'test-session-secret-placeholder';

async function insertUser(
  db: TestDatabase['db'],
  sub: string,
  phone: string | null = null,
): Promise<string> {
  const [row] = await db.insert(users).values({ cognitoSub: sub, phone }).returning();
  assert.ok(row);
  return row.id;
}

async function seed(db: TestDatabase['db'], fixedPriceCents = 4500) {
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

test('createRequestApproval records a pending approval and supersedes a prior pending one', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seed(db);
    const requester = await insertUser(db, 'sub-user', '+15555550100');

    const first = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });
    const second = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });

    // The prior pending approval is superseded; only the newest is live.
    const live = await findPendingApproval(db, bathroomId, requester);
    assert.equal(live?.id, second.id);
    const [firstReloaded] = await db
      .select()
      .from(requestApprovals)
      .where(eq(requestApprovals.id, first.id));
    assert.equal(firstReloaded?.status, 'expired');
  } finally {
    await client.close();
  }
});

test('listPendingApprovalsForSites returns live approvals with bathroom label + requester phone', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seed(db);
    const requester = await insertUser(db, 'sub-user', '+15555550100');
    await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });

    const listed = await listPendingApprovalsForSites(db, [siteId]);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.bathroomLabel, 'Ground floor');
    assert.equal(listed[0]?.requesterPhone, '+15555550100');
    // An empty site list short-circuits to no rows.
    assert.deepEqual(await listPendingApprovalsForSites(db, []), []);
  } finally {
    await client.close();
  }
});

test('approveRequest places the hold and marks the approval used', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seed(db);
    const requester = await insertUser(db, 'sub-user', '+15555550100');
    const manager = await insertUser(db, 'sub-manager');
    const approval = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });

    const { request } = await approveRequest(db, new MockPaymentGateway(), approval.id, manager);
    assert.equal(request.status, 'authorized');
    assert.equal(request.amountCents, 4500);
    assert.equal(request.requestedByUserId, requester);

    const [used] = await db
      .select()
      .from(requestApprovals)
      .where(eq(requestApprovals.id, approval.id));
    assert.equal(used?.status, 'used');
    assert.equal(used?.approvedByUserId, manager);

    // Re-approving a used approval is rejected.
    await assert.rejects(
      () => approveRequest(db, new MockPaymentGateway(), approval.id, manager),
      InvalidApprovalStateError,
    );
  } finally {
    await client.close();
  }
});

test('approveRequest invalidates an expired approval and a price-changed one', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seed(db);
    const requester = await insertUser(db, 'sub-user', '+15555550100');
    const manager = await insertUser(db, 'sub-manager');

    // Expired: force the expiry into the past.
    const expired = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });
    await db
      .update(requestApprovals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(requestApprovals.id, expired.id));
    await assert.rejects(
      () => approveRequest(db, new MockPaymentGateway(), expired.id, manager),
      InvalidApprovalStateError,
    );

    // Price changed since the request: the bound amount no longer matches the site price.
    const stale = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requester,
      priceVersion: 1,
      amountCents: 4500,
    });
    await db.update(sites).set({ fixedPriceCents: 5000 }).where(eq(sites.id, siteId));
    await assert.rejects(
      () => approveRequest(db, new MockPaymentGateway(), stale.id, manager),
      InvalidApprovalStateError,
    );
  } finally {
    await client.close();
  }
});

test('loadRequestApproval throws for an unknown id', async () => {
  const { db, client } = await createTestDatabase();
  try {
    await assert.rejects(
      () => loadRequestApproval(db, '00000000-0000-0000-0000-000000000000'),
      RequestApprovalNotFoundError,
    );
  } finally {
    await client.close();
  }
});

// --- Real-HTTP end-to-end: over-limit request -> approval -> manager grant -> hold ---

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

test('HTTP: an over-limit authorized user request is held for approval, then a manager grants it and the hold is placed', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, rawToken } = await seed(db, 4500);

    const managerId = await insertUser(db, 'sub-manager');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: managerId, role: 'manager', status: 'authorized' });
    const manager = sessionAndCsrf(managerId);

    const userId = await insertUser(db, 'sub-user', '+15555550100');
    await db.insert(siteRoles).values({
      siteId,
      userId,
      role: 'authorized_user',
      status: 'authorized',
      maxAuthorizationCents: 1000,
    });
    const user = sessionAndCsrf(userId);

    // The site has a saved (mock) payment method so the hold can eventually be placed.
    await saveSitePaymentMethod(db, siteId, managerId);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      // 1. The over-limit user authorizes -> a pending approval is recorded, no hold yet.
      const reqRes = await fetch(`${baseUrl}/s/${rawToken}/authorize`, {
        method: 'POST',
        headers: { cookie: `rs_session=${user.cookie}`, 'x-csrf-token': user.csrf },
      });
      assert.equal(reqRes.status, 200);
      assert.match(await reqRes.text(), /Awaiting manager approval/i);

      const [pending] = await db
        .select()
        .from(requestApprovals)
        .where(eq(requestApprovals.siteId, siteId));
      assert.ok(pending);
      assert.equal(pending.status, 'pending');
      // No hold placed yet.
      assert.equal((await db.select().from(cleaningRequests)).length, 0);

      // 2. The manager grants it -> the hold is placed.
      const approveRes = await fetch(`${baseUrl}/manager/approvals/${pending.id}/approve`, {
        method: 'POST',
        headers: { cookie: `rs_session=${manager.cookie}`, 'x-csrf-token': manager.csrf },
      });
      assert.equal(approveRes.status, 204);

      const requests = await db.select().from(cleaningRequests);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.status, 'authorized');
      assert.equal(requests[0]?.amountCents, 4500);
      assert.equal(requests[0]?.bathroomId, bathroomId);
    });
  } finally {
    await client.close();
  }
});

test('HTTP: a non-manager cannot approve a request (403)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seed(db, 4500);
    const requesterId = await insertUser(db, 'sub-user', '+15555550100');
    await db.insert(siteRoles).values({
      siteId,
      userId: requesterId,
      role: 'authorized_user',
      status: 'authorized',
      maxAuthorizationCents: 1000,
    });
    const requester = sessionAndCsrf(requesterId);
    const approval = await createRequestApproval(db, {
      siteId,
      bathroomId,
      requesterUserId: requesterId,
      priceVersion: 1,
      amountCents: 4500,
    });

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/manager/approvals/${approval.id}/approve`, {
        method: 'POST',
        headers: { cookie: `rs_session=${requester.cookie}`, 'x-csrf-token': requester.csrf },
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await client.close();
  }
});
