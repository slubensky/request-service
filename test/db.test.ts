import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize } from '../src/auth/authorize.js';
import { findOrCreateUserByCognitoSub, resolveSiteRole } from '../src/db/access.js';
import {
  bathrooms,
  cleaningRequests,
  paymentAuthorizations,
  qrTokens,
  siteRoles,
  sites,
  users,
} from '../src/db/schema.js';
import { createTestDatabase } from './helpers/pglite.js';

/** Seeds a site + bathroom and returns their ids. */
async function seedSite(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const [site] = await db
    .insert(sites)
    .values({
      name: 'Central Plaza',
      address: '1 Market St',
      timezone: 'America/New_York',
      currency: 'usd',
      fixedPriceCents: 4500,
    })
    .returning();
  assert.ok(site);
  const [bathroom] = await db
    .insert(bathrooms)
    .values({ siteId: site.id, label: 'Ground floor' })
    .returning();
  assert.ok(bathroom);
  return { siteId: site.id, bathroomId: bathroom.id };
}

test('migrations create every core table and accept a full request chain', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seedSite(db);

    const [user] = await db
      .insert(users)
      .values({ cognitoSub: 'sub-1', phone: '+15555550101' })
      .returning();
    assert.ok(user);

    await db.insert(qrTokens).values({ bathroomId, tokenHash: 'hash-of-opaque-token' });
    const storedTokens = await db.select().from(qrTokens);
    assert.equal(storedTokens.length, 1);
    // The raw token is never stored -- only its hash column exists.
    assert.equal(Object.keys(storedTokens[0] ?? {}).includes('token'), false);

    const [request] = await db
      .insert(cleaningRequests)
      .values({
        siteId,
        bathroomId,
        requestedByUserId: user.id,
        priceVersion: 1,
        amountCents: 4500,
      })
      .returning();
    assert.ok(request);
    await db.insert(paymentAuthorizations).values({
      requestId: request.id,
      stripePaymentIntentId: 'pi_test_123',
      amountCents: 4500,
    });

    const authRows = await db.select().from(paymentAuthorizations);
    assert.equal(authRows.length, 1);
  } finally {
    await client.close();
  }
});

test('the qr token hash column is unique', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { bathroomId } = await seedSite(db);
    await db.insert(qrTokens).values({ bathroomId, tokenHash: 'dup-hash' });
    await assert.rejects(() => db.insert(qrTokens).values({ bathroomId, tokenHash: 'dup-hash' }));
  } finally {
    await client.close();
  }
});

test('resolveSiteRole returns null for a user with no role (a customer)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId } = await seedSite(db);
    const [user] = await db.insert(users).values({ cognitoSub: 'sub-customer' }).returning();
    assert.ok(user);
    const role = await resolveSiteRole(db, user.id, siteId);
    assert.equal(role, null);
    // Deny-by-default: no role means the create action is refused.
    assert.equal(
      authorize(role, {
        type: 'create_cleaning_request',
        siteId,
        bathroomId: 'b',
        amountCents: 100,
      }).allowed,
      false,
    );
  } finally {
    await client.close();
  }
});

test('resolveSiteRole maps an authorized manager row, and authorize allows it', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seedSite(db);
    const [user] = await db.insert(users).values({ cognitoSub: 'sub-manager' }).returning();
    assert.ok(user);
    await db.insert(siteRoles).values({
      siteId,
      userId: user.id,
      role: 'manager',
      status: 'authorized',
      maxAuthorizationCents: 10000,
    });

    const role = await resolveSiteRole(db, user.id, siteId);
    assert.ok(role);
    assert.equal(role.role, 'manager');
    assert.equal(role.status, 'authorized');
    assert.equal(
      authorize(role, { type: 'create_cleaning_request', siteId, bathroomId, amountCents: 4500 })
        .allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('a pending assistant role is resolved and denied self-authorization', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, bathroomId } = await seedSite(db);
    const [user] = await db.insert(users).values({ cognitoSub: 'sub-assistant' }).returning();
    assert.ok(user);
    await db.insert(siteRoles).values({
      siteId,
      userId: user.id,
      role: 'assistant',
      status: 'pending',
      maxAuthorizationCents: 5000,
    });
    const role = await resolveSiteRole(db, user.id, siteId);
    assert.ok(role);
    const decision = authorize(role, {
      type: 'create_cleaning_request',
      siteId,
      bathroomId,
      amountCents: 4500,
    });
    assert.deepEqual(decision, { allowed: false, reason: 'requires_authorized_status' });
  } finally {
    await client.close();
  }
});

test('findOrCreateUserByCognitoSub creates once then returns the same row', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const first = await findOrCreateUserByCognitoSub(db, 'sub-repeat', '+15555550102');
    const second = await findOrCreateUserByCognitoSub(db, 'sub-repeat', '+15555550102');
    assert.equal(first.id, second.id);
    const allUsers = await db.select().from(users);
    assert.equal(allUsers.length, 1);
  } finally {
    await client.close();
  }
});
