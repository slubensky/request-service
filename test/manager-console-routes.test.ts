/**
 * HTTP-level coverage for the Site Manager console + membership routes (SDD §11.4,
 * `src/manager/routes.ts`), which previously had none beyond the approve-a-request flow
 * (test/approvals.test.ts): the console page itself, inviting a member, and changing/
 * deleting a member's role. Driven over real HTTP (createHttpServer against PGlite), same
 * pattern as test/admin-authorized-users.test.ts.
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
import { createSite } from '../src/admin/service.js';
import { siteRoles, users } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';
import { MockSmsGateway, type SmsGateway } from '../src/sms/gateway.js';

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

function sessionAndCsrf(userId: string): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET);
  return { cookie: token, csrf: csrfTokenForSession(token, SESSION_SECRET) };
}

async function withRunningServer<T>(
  runtime: AuthRuntime,
  fn: (baseUrl: string) => Promise<T>,
  smsGateway?: SmsGateway,
): Promise<T> {
  delete process.env.TLS_CERT_FILE;
  delete process.env.TLS_KEY_FILE;
  const server = createHttpServer(runtime, smsGateway);
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

async function seedManager(db: TestDatabase['db']) {
  const site = await createSite(db, {
    name: 'Central Plaza',
    address: '1 Market St',
    timezone: 'America/New_York',
    currency: 'usd',
    fixedPriceCents: 4500,
  });
  const [managerUser] = await db.insert(users).values({ cognitoSub: 'sub-manager' }).returning();
  assert.ok(managerUser);
  const [managerRole] = await db
    .insert(siteRoles)
    .values({ siteId: site.id, userId: managerUser.id, role: 'manager', status: 'authorized' })
    .returning();
  assert.ok(managerRole);
  return { siteId: site.id, managerUserId: managerUser.id, managerRoleId: managerRole.id };
}

function formHeaders(admin: { cookie: string; csrf: string }) {
  return {
    cookie: `rs_session=${admin.cookie}`,
    'x-csrf-token': admin.csrf,
    'content-type': 'application/x-www-form-urlencoded',
  };
}

test('GET /manager redirects to login without a session; renders the console for an authorized manager', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const anonRes = await fetch(`${baseUrl}/manager`, { redirect: 'manual' });
      assert.equal(anonRes.status, 302);
      assert.equal(anonRes.headers.get('location'), '/auth/login');

      const res = await fetch(`${baseUrl}/manager`, {
        headers: { cookie: `rs_session=${manager.cookie}` },
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /Central Plaza/);
      assert.equal(siteId.length > 0, true);
    });
  } finally {
    await client.close();
  }
});

test('POST .../invites sends a manager invite and an authorized_user invite with a limit, each with a real SMS', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    const smsGateway = new MockSmsGateway();
    await withRunningServer(
      runtimeFor(db),
      async (baseUrl) => {
        const managerInvite = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ phone: '+15550009001', role: 'manager' }).toString(),
        });
        assert.equal(managerInvite.status, 200);
        assert.match(await managerInvite.text(), /Invitation sent/);

        const userInvite = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({
            phone: '+15550009002',
            role: 'authorized_user',
            max_authorization_cents: '3000',
          }).toString(),
        });
        assert.equal(userInvite.status, 200);
        assert.match(await userInvite.text(), /Invitation sent/);

        const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        // The seeded manager plus these two new invites.
        assert.equal(rows.length, 3);
        const authorizedUserRow = rows.find((r) => r.role === 'authorized_user');
        assert.equal(authorizedUserRow?.maxAuthorizationCents, 3000);

        // Both invites actually sent a real SMS through the gateway, to the right phone.
        assert.equal(smsGateway.sent.length, 2);
        assert.equal(smsGateway.sent[0]?.phone, '+15550009001');
        assert.equal(smsGateway.sent[1]?.phone, '+15550009002');
        assert.match(
          smsGateway.sent[0]?.message ?? '',
          /Central Plaza invited you to Restroom Hero/,
        );

        // Same phone again: idempotent no-op (SDD §11.4), no new row, no new SMS.
        const repeat = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ phone: '+15550009001', role: 'manager' }).toString(),
        });
        assert.equal(repeat.status, 200);
        assert.match(await repeat.text(), /already a member/);
        const rowsAfter = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        assert.equal(rowsAfter.length, 3);
        assert.equal(smsGateway.sent.length, 2);
      },
      smsGateway,
    );
  } finally {
    await client.close();
  }
});

test('POST .../invites surfaces an SMS send failure without blocking the already-created invite', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    const failingGateway: SmsGateway = {
      send: () => Promise.resolve({ sent: false, error: 'simulated carrier rejection' }),
    };
    await withRunningServer(
      runtimeFor(db),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ phone: '+15550009001', role: 'manager' }).toString(),
        });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /text message failed to send/);
        const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        // The seeded manager plus the persisted (if undelivered) invite.
        assert.equal(rows.length, 2);
      },
      failingGateway,
    );
  } finally {
    await client.close();
  }
});

test('POST .../invites does not attempt SMS delivery under DEMO_MODE', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    const smsGateway = new MockSmsGateway();
    process.env.DEMO_MODE = '1';
    try {
      await withRunningServer(
        runtimeFor(db),
        async (baseUrl) => {
          const res = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
            method: 'POST',
            headers: formHeaders(manager),
            body: new URLSearchParams({ phone: '+15550009001', role: 'manager' }).toString(),
          });
          assert.equal(res.status, 200);
          assert.match(await res.text(), /Invitation sent/);
        },
        smsGateway,
      );
      assert.equal(smsGateway.sent.length, 0);
    } finally {
      delete process.env.DEMO_MODE;
    }
  } finally {
    await client.close();
  }
});

test('POST .../invites rejects a bad role, a missing limit, and an unknown site; denies a non-manager', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    const [plainUser] = await db.insert(users).values({ cognitoSub: 'sub-plain' }).returning();
    assert.ok(plainUser);
    const plain = sessionAndCsrf(plainUser.id);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const badRole = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
        method: 'POST',
        headers: formHeaders(manager),
        body: new URLSearchParams({ phone: '+15550009003', role: 'superadmin' }).toString(),
      });
      assert.equal(badRole.status, 400);

      const missingLimit = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
        method: 'POST',
        headers: formHeaders(manager),
        body: new URLSearchParams({
          phone: '+15550009004',
          role: 'authorized_user',
        }).toString(),
      });
      assert.equal(missingLimit.status, 400);

      const missingSiteId = '00000000-0000-0000-0000-000000000000';
      const unknownSite = await fetch(`${baseUrl}/manager/sites/${missingSiteId}/invites`, {
        method: 'POST',
        headers: formHeaders(manager),
        body: new URLSearchParams({ phone: '+15550009005', role: 'manager' }).toString(),
      });
      // A site the caller has no manager SiteRole at is denied before it can 404.
      assert.equal(unknownSite.status, 403);

      const denied = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
        method: 'POST',
        headers: formHeaders(plain),
        body: new URLSearchParams({ phone: '+15550009006', role: 'manager' }).toString(),
      });
      assert.equal(denied.status, 403);
    });
  } finally {
    await client.close();
  }
});

test('POST .../invites is rate-limited past the per-manager budget', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      let lastStatus = 0;
      for (let i = 0; i < 21; i += 1) {
        const res = await fetch(`${baseUrl}/manager/sites/${siteId}/invites`, {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ phone: `+1555000${9100 + i}`, role: 'manager' }).toString(),
        });
        lastStatus = res.status;
      }
      assert.equal(lastStatus, 429);
    });
  } finally {
    await client.close();
  }
});

test('POST .../roles/:roleId/limit and .../delete manage an authorized_user role', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, managerUserId, managerRoleId } = await seedManager(db);
    const manager = sessionAndCsrf(managerUserId);
    const [memberUser] = await db.insert(users).values({ cognitoSub: 'sub-member' }).returning();
    assert.ok(memberUser);
    const [memberRole] = await db
      .insert(siteRoles)
      .values({
        siteId,
        userId: memberUser.id,
        role: 'authorized_user',
        status: 'authorized',
        maxAuthorizationCents: 2000,
      })
      .returning();
    assert.ok(memberRole);

    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const setLimit = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${memberRole.id}/limit`,
        {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ max_authorization_cents: '9000' }).toString(),
        },
      );
      assert.equal(setLimit.status, 204);
      const [afterLimit] = await db.select().from(siteRoles).where(eq(siteRoles.id, memberRole.id));
      assert.equal(afterLimit?.maxAuthorizationCents, 9000);

      // Setting a limit on a manager role is rejected (not manageable that way).
      const limitOnManager = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${managerRoleId}/limit`,
        {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ max_authorization_cents: '9000' }).toString(),
        },
      );
      assert.equal(limitOnManager.status, 409);

      // Unknown role id -> 404.
      const missingRoleId = '00000000-0000-0000-0000-000000000000';
      const unknownRole = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${missingRoleId}/limit`,
        {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ max_authorization_cents: '9000' }).toString(),
        },
      );
      assert.equal(unknownRole.status, 404);

      // Invalid limit value -> 400.
      const badLimit = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${memberRole.id}/limit`,
        {
          method: 'POST',
          headers: formHeaders(manager),
          body: new URLSearchParams({ max_authorization_cents: 'not-a-number' }).toString(),
        },
      );
      assert.equal(badLimit.status, 400);

      const del = await fetch(`${baseUrl}/manager/sites/${siteId}/roles/${memberRole.id}/delete`, {
        method: 'POST',
        headers: formHeaders(manager),
      });
      assert.equal(del.status, 204);
      const remaining = await db.select().from(siteRoles).where(eq(siteRoles.id, memberRole.id));
      assert.equal(remaining.length, 0);

      // Deleting a manager role is rejected (not manageable that way).
      const delManager = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${managerRoleId}/delete`,
        {
          method: 'POST',
          headers: formHeaders(manager),
        },
      );
      assert.equal(delManager.status, 409);

      // Already-deleted role id -> 404.
      const delAgain = await fetch(
        `${baseUrl}/manager/sites/${siteId}/roles/${memberRole.id}/delete`,
        {
          method: 'POST',
          headers: formHeaders(manager),
        },
      );
      assert.equal(delAgain.status, 404);
    });
  } finally {
    await client.close();
  }
});
