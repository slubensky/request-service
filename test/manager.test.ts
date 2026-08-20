import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeAction } from '../src/auth/enforce.js';
import { createSite, SiteNotFoundError } from '../src/admin/service.js';
import {
  deleteAuthorizedUser,
  inviteSiteMember,
  listManagedSites,
  setAuthorizedUserLimit,
  RoleNotManageableError,
  SiteRoleNotFoundError,
} from '../src/manager/service.js';
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

test('invite_site_role is denied for a plain member, an authorized_user, and a manager at another site; allowed for an authorized manager at their own site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const otherSiteId = await seedSite(db, 'Other Plaza');

    const member = await insertUser(db, 'sub-member');
    assert.equal(
      (await authorizeAction(db, member, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const authorizedUser = await insertUser(db, 'sub-authorized-user');
    await db
      .insert(siteRoles)
      .values({ siteId, userId: authorizedUser, role: 'authorized_user', status: 'authorized' });
    assert.equal(
      (await authorizeAction(db, authorizedUser, { type: 'invite_site_role', siteId })).allowed,
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

test('inviteSiteMember creates a pending SiteRole with no user linked; manager has null limit, authorized_user stores the given limit', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const managerInvite = await inviteSiteMember(db, siteId, 'manager', '+15555550100', null);
    assert.equal(managerInvite.created, true);
    assert.equal(managerInvite.role.role, 'manager');
    assert.equal(managerInvite.role.status, 'pending');
    assert.equal(managerInvite.role.invitedPhone, '+15555550100');
    assert.equal(managerInvite.role.userId, null);
    assert.equal(managerInvite.role.maxAuthorizationCents, null);

    const userInvite = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550101', 3000);
    assert.equal(userInvite.created, true);
    assert.equal(userInvite.role.role, 'authorized_user');
    assert.equal(userInvite.role.status, 'pending');
    assert.equal(userInvite.role.maxAuthorizationCents, 3000);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 2);
  } finally {
    await client.close();
  }
});

test('inviteSiteMember is idempotent (created:false) for a repeat invite of the same phone at the same site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const first = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550100', 3000);
    const second = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550100', 9999);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.role.id, second.role.id);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 1);
  } finally {
    await client.close();
  }
});

test('inviteSiteMember reports created:false for a phone that is already an accepted member', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const userId = await insertUser(db, 'sub-accepted');
    // An accepted authorized user keeps its invited_phone.
    await db.insert(siteRoles).values({
      siteId,
      userId,
      invitedPhone: '+15555550100',
      role: 'authorized_user',
      status: 'authorized',
      maxAuthorizationCents: 3000,
    });

    const again = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550100', 5000);
    assert.equal(again.created, false);

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
      () =>
        inviteSiteMember(
          db,
          '00000000-0000-0000-0000-000000000000',
          'manager',
          '+15555550100',
          null,
        ),
      SiteNotFoundError,
    );
  } finally {
    await client.close();
  }
});

test('setAuthorizedUserLimit updates the limit; rejects a manager target and an unknown role', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const invite = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550100', 3000);
    const managerInvite = await inviteSiteMember(db, siteId, 'manager', '+15555550111', null);

    const updated = await setAuthorizedUserLimit(db, siteId, invite.role.id, 7500);
    assert.equal(updated.maxAuthorizationCents, 7500);

    await assert.rejects(
      () => setAuthorizedUserLimit(db, siteId, managerInvite.role.id, 100),
      RoleNotManageableError,
    );
    await assert.rejects(
      () => setAuthorizedUserLimit(db, siteId, '00000000-0000-0000-0000-000000000000', 100),
      SiteRoleNotFoundError,
    );
  } finally {
    await client.close();
  }
});

test('deleteAuthorizedUser removes the row; rejects a manager target', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const invite = await inviteSiteMember(db, siteId, 'authorized_user', '+15555550100', 3000);
    const managerInvite = await inviteSiteMember(db, siteId, 'manager', '+15555550111', null);

    await deleteAuthorizedUser(db, siteId, invite.role.id);
    const remaining = await db.select().from(siteRoles).where(eq(siteRoles.id, invite.role.id));
    assert.equal(remaining.length, 0);

    await assert.rejects(
      () => deleteAuthorizedUser(db, siteId, managerInvite.role.id),
      RoleNotManageableError,
    );
  } finally {
    await client.close();
  }
});

test("listManagedSites returns only the caller's own authorized-manager sites, with members", async () => {
  const { db, client } = await createTestDatabase();
  try {
    const mySite = await seedSite(db, 'My Site');
    const otherSite = await seedSite(db, "Someone Else's Site");

    const manager = await insertUser(db, 'sub-manager');
    await seedAuthorizedManager(db, mySite, manager);

    const otherManager = await insertUser(db, 'sub-other-manager');
    await seedAuthorizedManager(db, otherSite, otherManager);

    await inviteSiteMember(db, mySite, 'authorized_user', '+15555550100', 3000);

    const managed = await listManagedSites(db, manager);
    assert.equal(managed.length, 1);
    assert.equal(managed[0]?.site.id, mySite);
    // members includes the manager themself + the invited authorized user.
    assert.equal(managed[0]?.members.length, 2);
    const invited = managed[0]?.members.find((m) => m.role === 'authorized_user');
    assert.equal(invited?.invitedPhone, '+15555550100');
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
