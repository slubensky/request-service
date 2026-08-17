import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeAction } from '../src/auth/enforce.js';
import {
  addBathroom,
  createSite,
  inviteInitialManager,
  issueQrToken,
  listSitesWithBathrooms,
  SiteNotFoundError,
  BathroomNotFoundError,
} from '../src/admin/service.js';
import { hashToken, resolveActiveQrToken } from '../src/qr/tokens.js';
import { qrTokens, siteRoles, users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

async function insertUser(db: TestDatabase['db'], sub: string, admin: boolean): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ cognitoSub: sub, platformRole: admin ? 'company_admin' : 'member' })
    .returning();
  assert.ok(row);
  return row.id;
}

async function seedSite(db: TestDatabase['db']): Promise<string> {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  return site.id;
}

test('onboarding is denied for a plain member and allowed for a company_admin', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const member = await insertUser(db, 'sub-member', false);
    const admin = await insertUser(db, 'sub-admin', true);

    // Deny by default: a member (no company_admin, no SiteRole) cannot onboard.
    assert.equal((await authorizeAction(db, member, { type: 'create_site' })).allowed, false);
    assert.equal(
      (await authorizeAction(db, member, { type: 'create_bathroom', siteId })).allowed,
      false,
    );

    // Platform authority: the company_admin clears both, cross-site, no SiteRole.
    assert.equal((await authorizeAction(db, admin, { type: 'create_site' })).allowed, true);
    assert.equal(
      (await authorizeAction(db, admin, { type: 'create_bathroom', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('createSite stores the fixed price in cents; listing returns it with its bathrooms', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const bathroom = await addBathroom(db, siteId, 'Ground floor');
    assert.equal(bathroom.siteId, siteId);

    const listed = await listSitesWithBathrooms(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.site.fixedPriceCents, 4500);
    assert.equal(listed[0]?.bathrooms.length, 1);
    assert.equal(listed[0]?.bathrooms[0]?.label, 'Ground floor');
  } finally {
    await client.close();
  }
});

test('addBathroom rejects an unknown site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    await assert.rejects(
      () => addBathroom(db, '00000000-0000-0000-0000-000000000000', 'Nowhere'),
      SiteNotFoundError,
    );
  } finally {
    await client.close();
  }
});

test('issueQrToken persists only the hash; the raw token resolves correctly', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const bathroom = await addBathroom(db, siteId, 'Ground floor');

    const issued = await issueQrToken(db, siteId, bathroom.id);
    assert.ok(issued.rawToken.length > 0);

    const stored = await db.select().from(qrTokens);
    assert.equal(stored.length, 1);
    // The raw token is never persisted -- only its one-way hash.
    const storedRow = stored[0];
    assert.ok(storedRow);
    assert.equal(storedRow.tokenHash, hashToken(issued.rawToken));
    assert.notEqual(storedRow.tokenHash, issued.rawToken);
    assert.equal(Object.keys(storedRow).includes('token'), false);
    assert.equal(JSON.stringify(storedRow).includes(issued.rawToken), false);

    // The raw token resolves to its bathroom/site by hash lookup.
    const resolved = await resolveActiveQrToken(db, issued.rawToken);
    assert.deepEqual(resolved, { bathroomId: bathroom.id, siteId });
  } finally {
    await client.close();
  }
});

test('re-issuing a QR token revokes the prior tag (revocable/replaceable)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const bathroom = await addBathroom(db, siteId, 'Ground floor');

    const first = await issueQrToken(db, siteId, bathroom.id);
    const second = await issueQrToken(db, siteId, bathroom.id);
    assert.notEqual(first.rawToken, second.rawToken);

    // The replaced tag stops resolving; only the current one is active.
    assert.equal(await resolveActiveQrToken(db, first.rawToken), null);
    assert.deepEqual(await resolveActiveQrToken(db, second.rawToken), {
      bathroomId: bathroom.id,
      siteId,
    });

    const active = await db.select().from(qrTokens).where(eq(qrTokens.status, 'active'));
    assert.equal(active.length, 1);
  } finally {
    await client.close();
  }
});

test('issueQrToken refuses a bathroom that does not belong to the named site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteA = await seedSite(db);
    const siteB = (
      await createSite(db, {
        name: 'Other',
        address: '2 Other St',
        timezone: 'America/New_York',
        currency: 'usd',
        fixedPriceCents: 3000,
      })
    ).id;
    const bathroom = await addBathroom(db, siteA, 'Ground floor');

    // Mismatched ids must not issue a cross-site token.
    await assert.rejects(() => issueQrToken(db, siteB, bathroom.id), BathroomNotFoundError);
  } finally {
    await client.close();
  }
});

test('inviteInitialManager creates a pending manager role bound to a phone, no user linked', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const invite = await inviteInitialManager(db, siteId, '+15555550100');
    assert.equal(invite.role, 'manager');
    assert.equal(invite.status, 'pending');
    assert.equal(invite.invitedPhone, '+15555550100');
    assert.equal(invite.userId, null);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 1);
  } finally {
    await client.close();
  }
});

test('inviteInitialManager is idempotent for a repeat invite of the same not-yet-linked phone at the same site (SDD §11.1)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const first = await inviteInitialManager(db, siteId, '+15555550100');
    const second = await inviteInitialManager(db, siteId, '+15555550100');
    assert.equal(first.id, second.id);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 1, 'no duplicate pending row is inserted');

    // A different phone, or the same phone at a different site, is a genuinely
    // new invite and gets its own row.
    const otherPhone = await inviteInitialManager(db, siteId, '+15555550101');
    assert.notEqual(otherPhone.id, first.id);

    const otherSiteId = await seedSite(db);
    const otherSite = await inviteInitialManager(db, otherSiteId, '+15555550100');
    assert.notEqual(otherSite.id, first.id);
  } finally {
    await client.close();
  }
});
