/**
 * HTTP-level coverage for two Company Admin console routes that had none: adding a
 * bathroom and inviting the initial manager (SDD §11.1, §11.3). Driven over real HTTP
 * (createHttpServer against PGlite), same pattern as test/admin-authorized-users.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSite } from '../src/admin/service.js';
import { bathrooms, siteRoles, users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';
import { runtimeFor, sessionAndCsrf, withRunningServer } from './helpers/http.js';
import { MockSmsGateway, type SmsGateway } from '../src/sms/gateway.js';

async function seedAdmin(db: TestDatabase['db']) {
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
  assert.ok(admin);
  return { siteId: site.id, adminId: admin.id };
}

test('POST .../bathrooms adds a bathroom; rejects an unknown site with 404', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId } = await seedAdmin(db);
    const admin = sessionAndCsrf(adminId);
    await withRunningServer(runtimeFor(db), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sites/${siteId}/bathrooms`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${admin.cookie}`,
          'x-csrf-token': admin.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ label: 'Ground floor' }).toString(),
      });
      assert.equal(res.status, 204);
      const rows = await db.select().from(bathrooms).where(eq(bathrooms.siteId, siteId));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.label, 'Ground floor');

      const missingSiteId = '00000000-0000-0000-0000-000000000000';
      const badRes = await fetch(`${baseUrl}/admin/sites/${missingSiteId}/bathrooms`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${admin.cookie}`,
          'x-csrf-token': admin.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ label: 'Nowhere' }).toString(),
      });
      assert.equal(badRes.status, 404);

      const emptyLabelRes = await fetch(`${baseUrl}/admin/sites/${siteId}/bathrooms`, {
        method: 'POST',
        headers: {
          cookie: `rs_session=${admin.cookie}`,
          'x-csrf-token': admin.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ label: '' }).toString(),
      });
      assert.equal(emptyLabelRes.status, 400);
    });
  } finally {
    await client.close();
  }
});

test('POST .../managers sends an invite (and a real SMS), then no-ops idempotently on the same phone', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId } = await seedAdmin(db);
    const admin = sessionAndCsrf(adminId);
    const smsGateway = new MockSmsGateway();
    await withRunningServer(
      runtimeFor(db),
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/admin/sites/${siteId}/managers`, {
          method: 'POST',
          headers: {
            cookie: `rs_session=${admin.cookie}`,
            'x-csrf-token': admin.csrf,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ phone: '+15550001234' }).toString(),
        });
        assert.equal(first.status, 200);
        assert.match(await first.text(), /Invitation sent/);
        const roles = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        assert.equal(roles.length, 1);
        assert.equal(roles[0]?.role, 'manager');

        // The invite SMS actually went through the gateway, to the invited phone, naming
        // the site and Restroom Hero (SDD: real invite delivery, not the old mocked-only
        // DB write).
        assert.equal(smsGateway.sent.length, 1);
        assert.equal(smsGateway.sent[0]?.phone, '+15550001234');
        assert.match(
          smsGateway.sent[0]?.message ?? '',
          /Central Plaza invited you to Restroom Hero/,
        );
        assert.match(smsGateway.sent[0]?.message ?? '', /\/auth\/login/);

        // Same phone again: idempotent no-op (SDD §11.1), no second SiteRole created,
        // and no second SMS sent -- nothing new happened to report.
        const second = await fetch(`${baseUrl}/admin/sites/${siteId}/managers`, {
          method: 'POST',
          headers: {
            cookie: `rs_session=${admin.cookie}`,
            'x-csrf-token': admin.csrf,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ phone: '+15550001234' }).toString(),
        });
        assert.equal(second.status, 200);
        assert.match(await second.text(), /already a member/);
        const rolesAfter = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        assert.equal(rolesAfter.length, 1);
        assert.equal(smsGateway.sent.length, 1);

        // Malformed phone: rejected by parsePhone's format check before any invite is created.
        const badFormat = await fetch(`${baseUrl}/admin/sites/${siteId}/managers`, {
          method: 'POST',
          headers: {
            cookie: `rs_session=${admin.cookie}`,
            'x-csrf-token': admin.csrf,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ phone: 'not-a-phone-number!!' }).toString(),
        });
        assert.equal(badFormat.status, 400);
      },
      smsGateway,
    );
  } finally {
    await client.close();
  }
});

test('POST .../managers surfaces an SMS send failure without blocking the already-created invite', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId } = await seedAdmin(db);
    const admin = sessionAndCsrf(adminId);
    const failingGateway: SmsGateway = {
      send: () => Promise.resolve({ sent: false, error: 'simulated carrier rejection' }),
    };
    await withRunningServer(
      runtimeFor(db),
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/sites/${siteId}/managers`, {
          method: 'POST',
          headers: {
            cookie: `rs_session=${admin.cookie}`,
            'x-csrf-token': admin.csrf,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ phone: '+15550001234' }).toString(),
        });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /text message failed to send/);
        // The invite itself is still persisted -- a delivery failure never rolls it back.
        const roles = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
        assert.equal(roles.length, 1);
      },
      failingGateway,
    );
  } finally {
    await client.close();
  }
});

test('POST .../managers does not attempt SMS delivery under DEMO_MODE', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const { siteId, adminId } = await seedAdmin(db);
    const admin = sessionAndCsrf(adminId);
    const smsGateway = new MockSmsGateway();
    process.env.DEMO_MODE = '1';
    try {
      await withRunningServer(
        runtimeFor(db),
        async (baseUrl) => {
          const res = await fetch(`${baseUrl}/admin/sites/${siteId}/managers`, {
            method: 'POST',
            headers: {
              cookie: `rs_session=${admin.cookie}`,
              'x-csrf-token': admin.csrf,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ phone: '+15550001234' }).toString(),
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
