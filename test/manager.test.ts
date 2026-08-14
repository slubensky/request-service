import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeAction } from '../src/auth/enforce.js';
import { createSite, SiteNotFoundError } from '../src/admin/service.js';
import { inviteSiteMember, listManagedSites } from '../src/manager/service.js';
import { siteRoles, users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

async function insertUser(db: TestDatabase['db'], sub: string): Promise<string> {
  const [row] = await db.insert(users).values({ cognitoSub: sub }).returning();
  assert.ok(row);
  return row.id;
}

async function seedSite(db: TestDatabase['db'], name = 'Central Plaza'): Promise<string> {
  const site = await createSite(db, {
    name,
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  return site.id;
}

async function seedAuthorizedManager(
  db: TestDatabase['db'],
  siteId: string,
  userId: string,
): Promise<void> {
  await db.insert(siteRoles).values({ siteId, userId, role: 'manager', status: 'authorized' });
}

test('invite_site_role is denied for a plain member, an assistant, and a manager at another site; allowed for an authorized manager at their own site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const otherSiteId = await seedSite(db, 'Other Plaza');

    const member = await insertUser(db, 'sub-member');
    assert.equal(
      (await authorizeAction(db, member, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const assistantUser = await insertUser(db, 'sub-assistant');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: assistantUser, role: 'assistant', status: 'authorized' });
    assert.equal(
      (await authorizeAction(db, assistantUser, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const pendingManager = await insertUser(db, 'sub-pending-manager');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: pendingManager, role: 'manager', status: 'pending' });
    assert.equal(
      (await authorizeAction(db, pendingManager, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const otherSiteManager = await insertUser(db, 'sub-other-site-manager');
    await seedAuthorizedManager(db, otherSiteId, otherSiteManager);
    assert.equal(
      (await authorizeAction(db, otherSiteManager, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const manager = await insertUser(db, 'sub-manager');
    await seedAuthorizedManager(db, siteId, manager);
    assert.equal(
      (await authorizeAction(db, manager, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('inviteSiteMember creates a pending SiteRole with no user linked, for both manager and assistant', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const managerInvite = await inviteSiteMember(db, siteId, 'manager', '+15555550100');
    assert.equal(managerInvite.role, 'manager');
    assert.equal(managerInvite.status, 'pending');
    assert.equal(managerInvite.invitedPhone, '+15555550100');
    assert.equal(managerInvite.userId, null);

    const assistantInvite = await inviteSiteMember(db, siteId, 'assistant', '+15555550101');
    assert.equal(assistantInvite.role, 'assistant');
    assert.equal(assistantInvite.status, 'pending');

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 2);
  } finally {
    await client.close();
  }
});

test('inviteSiteMember is idempotent for a repeat invite of the same phone/role at the same site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const first = await inviteSiteMember(db, siteId, 'assistant', '+15555550100');
    const second = await inviteSiteMember(db, siteId, 'assistant', '+15555550100');
    assert.equal(first.id, second.id);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 1);
  } finally {
    await client.close();
  }
});

test('inviteSiteMember rejects an unknown site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    await assert.rejects(
      () => inviteSiteMember(db, '00000000-0000-0000-0000-000000000000', 'manager', '+15555550100'),
      SiteNotFoundError,
    );
  } finally {
    await client.close();
  }
});

test("listManagedSites returns only the caller's own authorized-manager sites, with pending invites", async () => {
  const { db, client } = await createTestDatabase();
  try {
    const mySite = await seedSite(db, 'My Site');
    const otherSite = await seedSite(db, "Someone Else's Site");

    const manager = await insertUser(db, 'sub-manager');
    await seedAuthorizedManager(db, mySite, manager);

    const otherManager = await insertUser(db, 'sub-other-manager');
    await seedAuthorizedManager(db, otherSite, otherManager);

    await inviteSiteMember(db, mySite, 'assistant', '+15555550100');

    const managed = await listManagedSites(db, manager);
    assert.equal(managed.length, 1);
    assert.equal(managed[0]?.site.id, mySite);
    assert.equal(managed[0]?.pendingInvites.length, 1);
    assert.equal(managed[0]?.pendingInvites[0]?.invitedPhone, '+15555550100');
  } finally {
    await client.close();
  }
});

test('listManagedSites returns nothing for a user with no authorized manager SiteRole', async () => {
  const { db, client } = await createTestDatabase();
  try {
    await seedSite(db);
    const member = await insertUser(db, 'sub-member');
    assert.deepEqual(await listManagedSites(db, member), []);
  } finally {
    await client.close();
  }
});
