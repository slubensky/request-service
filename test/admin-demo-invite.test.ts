/**
 * Company-Admin console demo invite-code display tests (SDD §6.3).
 *
 * Mirrors test/demo-invite.test.ts's console-rendering coverage but for the
 * Company Admin console: the first manager invite for a new Site is always
 * created by a Company Admin (§11.1), not a Site Manager, so it previously had
 * no in-browser code to redeem under DEMO_MODE. Everything is mocked: no AWS,
 * no Cognito, no real SMS -- codes are exercised against an in-process PGlite
 * database exactly like the existing demo-invite suite.
 *
 * Coverage:
 *  - DEMO_MODE on: after a Company Admin invites the initial manager, the
 *    admin console (`listSitesWithBathrooms` + `renderAdminConsole`) surfaces
 *    the single-use code and its copyable accept link next to that invite;
 *  - DEMO_MODE off: no code is minted, and the admin console renders no
 *    pending-invites section at all -- byte-for-byte the same markup as
 *    before this feature existed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSite, inviteInitialManager, listSitesWithBathrooms } from '../src/admin/service.js';
import { issueDemoInviteCode, unusedCodesForSiteRoles } from '../src/demo/service.js';
import { renderAdminConsole } from '../src/render/templates/admin.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const PHONE = '+15555550100';

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

/**
 * Reproduces what `handleInviteManager` (src/admin/routes.ts) does after a
 * successful invite: mints a demo code only when `demoMode` is on, exactly as
 * the route does, then re-reads the console listing the route would render.
 */
async function inviteAndListAsAdminConsoleWould(
  db: TestDatabase['db'],
  siteId: string,
  demoMode: boolean,
) {
  const invited = (await inviteInitialManager(db, siteId, PHONE)).role;
  if (demoMode) {
    await issueDemoInviteCode(db, invited.id);
  }
  const siteList = await listSitesWithBathrooms(db);
  const pendingIds = siteList.flatMap((entry) =>
    entry.managers.filter((m) => m.status === 'pending').map((m) => m.id),
  );
  const demoCodes = demoMode
    ? await unusedCodesForSiteRoles(db, pendingIds)
    : new Map<string, string>();
  return { invited, siteList, demoCodes };
}

test('DEMO_MODE on: the admin console shows the code + accept link right after inviting a manager', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const { invited, siteList, demoCodes } = await inviteAndListAsAdminConsoleWould(
      db,
      siteId,
      true,
    );

    assert.equal(demoCodes.size, 1);
    const code = demoCodes.get(invited.id);
    assert.ok(code, 'a code was minted for the newly-created pending invite');

    const html = renderAdminConsole(siteList, 'csrf-token', demoCodes);
    // The manager (phone + status) is shown alongside its code and accept link.
    assert.match(html, new RegExp(PHONE.replace('+', '\\+')));
    assert.match(html, /class="managers"/);
    assert.match(html, new RegExp(`Code: <code>${code}</code>`));
    assert.match(html, new RegExp(`/invite/accept\\?code=${code}`));
  } finally {
    await client.close();
  }
});

test('DEMO_MODE off: no code is minted and admin console markup is unchanged', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const { siteList, demoCodes } = await inviteAndListAsAdminConsoleWould(db, siteId, false);

    // No code exists at all -- the route never called issueDemoInviteCode.
    assert.equal(demoCodes.size, 0);
    const pendingIds = siteList.flatMap((entry) =>
      entry.managers.filter((m) => m.status === 'pending').map((m) => m.id),
    );
    assert.equal((await unusedCodesForSiteRoles(db, pendingIds)).size, 0);

    const demoOffHtml = renderAdminConsole(siteList, 'csrf-token', demoCodes);
    // No demo code or accept link renders when DEMO_MODE is off.
    assert.doesNotMatch(demoOffHtml, /invite-code/);
    assert.doesNotMatch(demoOffHtml, /\/invite\/accept/);
    // The managers list itself DOES render (visibility) -- phone + a Revoke control.
    assert.match(demoOffHtml, /class="managers"/);
    assert.match(demoOffHtml, new RegExp(PHONE.replace('+', '\\+')));
    assert.match(demoOffHtml, /Revoke/);

    // Byte-for-byte identical to calling the no-demoCodes overload (empty map default).
    const legacyHtml = renderAdminConsole(siteList, 'csrf-token');
    assert.equal(demoOffHtml, legacyHtml);
  } finally {
    await client.close();
  }
});
