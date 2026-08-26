/**
 * Company-Admin management of authorized users (SDD §7, §11.1, §11.3, Phase 7):
 * the admin console lists managers AND authorized users with limits, and the admin
 * can change an authorized user's limit and revoke either role. Driven over real
 * HTTP (createHttpServer against PGlite) so the deny-by-default matrix and CSRF run
 * exactly as production.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createSite } from '../src/admin/service.js';
import { siteRoles, users } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';
import { runtimeFor, sessionAndCsrf, withRunningServer } from './helpers/http.js';

async function seed(db: TestDatabase['db']) {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  const [admin] = await db
    .insert(users)
    .values({ cognitoSub: 'sub-admin', platformRole: 'company_admin' })
    .returning();
  const [managerUser] = await db.insert(users).values({ cognitoSub: 'sub-manager' }).returning();
  const [authUser] = await db.insert(users).values({ cognitoSub: 'sub-user' }).returning();
  assert.ok(admin && managerUser && authUser);
  const [manager] = await db
    .insert(siteRoles)
    .values({
      siteId: site.id,
      userId: managerUser.id,
      invitedPhone: '+15550000001',
      role: 'manager',
      status: 'authorized',
    })
    .returning();
  const [authorizedUser] = await db
    .insert(siteRoles)
    .values({
      siteId: site.id,
      userId: authUser.id,
      invitedPhone: '+15550000002',
      role: 'authorized_user',
      status: 'authorized',
      maxAuthorizationCents: 3000,
    })
    .returning();
  assert.ok(manager && authorizedUser);
  return {
    siteId: site.id,
    adminId: admin.id,
    managerRoleId: manager.id,
    userRoleId: authorizedUser.id,
  };
}

test('the admin console lists managers and authorized users with limits', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { adminId } = await seed(db);
    const admin = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin`, {
        headers: { cookie: `rs_session=${admin.cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /class="managers"/);
      assert.match(body, /class="authorized-users"/);
      assert.match(body, /\+15550000002/); // the authorized user's phone
      assert.match(body, /Limit: \$30\.00/); // their approval limit
    });
  } finally {
    await client.close();
  }
});

test('the admin can change an authorized user limit and revoke them; rejects set-limit on a manager', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId, managerRoleId, userRoleId } = await seed(db);
    const admin = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      // Change the authorized user's limit.
      const setRes = await fetch(`${baseUrl}/admin/sites/${siteId}/roles/${userRoleId}/limit`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${admin.cookie}`,
          'x-csrf-token': admin.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ max_authorization_cents: '8000' }).toString(),
      });
      assert.equal(setRes.status, 204);
      const [afterLimit] = await db.select().from(siteRoles).where(eq(siteRoles.id, userRoleId));
      assert.equal(afterLimit?.maxAuthorizationCents, 8000);

      // Setting a limit on a manager is rejected (not an authorized user).
      const badRes = await fetch(`${baseUrl}/admin/sites/${siteId}/roles/${managerRoleId}/limit`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${admin.cookie}`,
          'x-csrf-token': admin.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ max_authorization_cents: '5000' }).toString(),
      });
      assert.equal(badRes.status, 409);

      // Revoke the authorized user.
      const revokeRes = await fetch(`${baseUrl}/admin/sites/${siteId}/roles/${userRoleId}/revoke`, {
        method: 'POST',
        headers: { cookie: `rs_session=${admin.cookie}`, 'x-csrf-token': admin.csrf },
      });
      assert.equal(revokeRes.status, 204);
      const [afterRevoke] = await db.select().from(siteRoles).where(eq(siteRoles.id, userRoleId));
      assert.equal(afterRevoke?.status, 'revoked');
    });
  } finally {
    await client.close();
  }
});

test('a caller without the set-limit capability cannot change a limit (403)', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, userRoleId } = await seed(db);
    // The authorized user themself holds neither site_role:set_limit nor the platform role;
    // the gate is capability-based, so they are denied even hitting the admin route directly.
    const [userRole] = await db.select().from(siteRoles).where(eq(siteRoles.id, userRoleId));
    assert.ok(userRole?.userId);
    const authUser = sessionAndCsrf(userRole.userId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites/${siteId}/roles/${userRoleId}/limit`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${authUser.cookie}`,
          'x-csrf-token': authUser.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ max_authorization_cents: '9000' }).toString(),
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await client.close();
  }
});
