/**
 * Payment gateway + cleaning-request/capture/cancel service tests (SDD §9.1,
 * §9.3). `MockPaymentGateway` is exercised directly (it is explicitly not
 * Stripe -- SDD §9.3); the service-layer tests run against a real PGlite
 * database so the row-level invariants (hold-before-row, status transitions)
 * are genuinely enforced, not assumed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { MockPaymentGateway } from '../src/payments/gateway.js';
import {
  cancelCleaningRequest,
  captureCleaningRequest,
  createCleaningRequest,
  InvalidPaymentStateError,
  listPendingCaptures,
  loadPaymentAuthorization,
  PaymentAuthorizationNotFoundError,
} from '../src/payments/service.js';
import { createSite, addBathroom } from '../src/admin/service.js';
import { cleaningRequests, paymentAuthorizations, users } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

async function seed(db: TestDatabase['db']) {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  const bathroom = await addBathroom(db, site.id, 'Ground floor');
  const [user] = await db.insert(users).values({ cognitoSub: 'sub-manager' }).returning();
  assert.ok(user);
  return { siteId: site.id, bathroomId: bathroom.id, userId: user.id };
}

test('MockPaymentGateway.authorize returns a mock-prefixed id, never a real Stripe id', async () => {
  const gateway = new MockPaymentGateway();
  const result = await gateway.authorize({ amountCents: 4500, idempotencyKey: 'k1' });
  assert.match(result.gatewayId, /^mock_pi_/);
  assert.doesNotMatch(result.gatewayId, /^pi_/);
});

test('MockPaymentGateway.authorize rejects a non-positive amount', async () => {
  const gateway = new MockPaymentGateway();
  await assert.rejects(() => gateway.authorize({ amountCents: 0, idempotencyKey: 'k' }));
  await assert.rejects(() => gateway.authorize({ amountCents: -100, idempotencyKey: 'k' }));
});

test('createCleaningRequest creates a CleaningRequest and a requires_capture PaymentAuthorization only after the hold succeeds', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const gateway = new MockPaymentGateway();

    const { request, authorization } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    assert.equal(request.status, 'authorized');
    assert.equal(request.amountCents, 4500);
    assert.equal(request.priceVersion, 1);
    assert.equal(authorization.status, 'requires_capture');
    assert.equal(authorization.amountCents, 4500);
    assert.match(authorization.stripePaymentIntentId, /^mock_pi_/);

    const requestRows = await db.select().from(cleaningRequests);
    assert.equal(requestRows.length, 1);
    const authRows = await db.select().from(paymentAuthorizations);
    assert.equal(authRows.length, 1);
  } finally {
    await client.close();
  }
});

test('a failed gateway authorization creates neither a CleaningRequest nor a PaymentAuthorization', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const failingGateway = {
      authorize: () => Promise.reject(new Error('card declined')),
      capture: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    };

    await assert.rejects(
      () =>
        createCleaningRequest(db, failingGateway, {
          siteId,
          bathroomId,
          requestedByUserId: userId,
          amountCents: 4500,
        }),
      /card declined/,
    );

    assert.equal((await db.select().from(cleaningRequests)).length, 0);
    assert.equal((await db.select().from(paymentAuthorizations)).length, 0);
  } finally {
    await client.close();
  }
});

test('listPendingCaptures returns only requires_capture authorizations, newest last', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const gateway = new MockPaymentGateway();
    const { authorization: first } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });
    await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    await captureCleaningRequest(db, gateway, first.id);

    const pending = await listPendingCaptures(db);
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0]?.authorization.id, first.id);
  } finally {
    await client.close();
  }
});

test('captureCleaningRequest transitions both rows to captured/completed', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const gateway = new MockPaymentGateway();
    const { request, authorization } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    await captureCleaningRequest(db, gateway, authorization.id);

    const [reloadedAuth] = await db
      .select()
      .from(paymentAuthorizations)
      .where(eq(paymentAuthorizations.id, authorization.id));
    assert.equal(reloadedAuth?.status, 'captured');
    const [reloadedRequest] = await db
      .select()
      .from(cleaningRequests)
      .where(eq(cleaningRequests.id, request.id));
    assert.equal(reloadedRequest?.status, 'completed');
  } finally {
    await client.close();
  }
});

test('cancelCleaningRequest transitions both rows to canceled', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const gateway = new MockPaymentGateway();
    const { request, authorization } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    await cancelCleaningRequest(db, gateway, authorization.id);

    const [reloadedAuth] = await db
      .select()
      .from(paymentAuthorizations)
      .where(eq(paymentAuthorizations.id, authorization.id));
    assert.equal(reloadedAuth?.status, 'canceled');
    const [reloadedRequest] = await db
      .select()
      .from(cleaningRequests)
      .where(eq(cleaningRequests.id, request.id));
    assert.equal(reloadedRequest?.status, 'canceled');
  } finally {
    await client.close();
  }
});

test('capturing an already-captured authorization is rejected before the gateway is called again', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    let captureCalls = 0;
    const countingGateway = new MockPaymentGateway();
    const gateway = {
      authorize: countingGateway.authorize.bind(countingGateway),
      capture: async (id: string) => {
        captureCalls += 1;
        return countingGateway.capture(id);
      },
      cancel: countingGateway.cancel.bind(countingGateway),
    };
    const { authorization } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    await captureCleaningRequest(db, gateway, authorization.id);
    assert.equal(captureCalls, 1);

    await assert.rejects(
      () => captureCleaningRequest(db, gateway, authorization.id),
      InvalidPaymentStateError,
    );
    // The second, rejected attempt never reached the gateway.
    assert.equal(captureCalls, 1);
  } finally {
    await client.close();
  }
});

test('canceling an already-canceled authorization is rejected', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId, userId } = await seed(db);
    const gateway = new MockPaymentGateway();
    const { authorization } = await createCleaningRequest(db, gateway, {
      siteId,
      bathroomId,
      requestedByUserId: userId,
      amountCents: 4500,
    });

    await cancelCleaningRequest(db, gateway, authorization.id);
    await assert.rejects(
      () => cancelCleaningRequest(db, gateway, authorization.id),
      InvalidPaymentStateError,
    );
  } finally {
    await client.close();
  }
});

test('loadPaymentAuthorization / capture / cancel reject an unknown id', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const gateway = new MockPaymentGateway();
    const unknownId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(
      () => loadPaymentAuthorization(db, unknownId),
      PaymentAuthorizationNotFoundError,
    );
    await assert.rejects(
      () => captureCleaningRequest(db, gateway, unknownId),
      PaymentAuthorizationNotFoundError,
    );
    await assert.rejects(
      () => cancelCleaningRequest(db, gateway, unknownId),
      PaymentAuthorizationNotFoundError,
    );
  } finally {
    await client.close();
  }
});
