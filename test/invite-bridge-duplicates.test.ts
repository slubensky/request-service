/**
 * Invite bridge duplicate-handling tests (SDD §3.3, "Resilient bridge
 * contract"). Regression coverage for the bug where redeeming an invite 500s
 * when more than one pending invite exists for the same phone on the same
 * site: `bridgePendingSiteRoles` (`src/db/access.ts`) previously ran a single
 * blanket UPDATE that tried to set the same `user_id` on every matching row,
 * violating the `site_roles_site_user_key` unique index (`site_id, user_id`).
 *
 * Coverage:
 *  (a) two pending invites for the same phone+site (including a mixed
 *      manager/authorized_user duplicate pair) -- redemption activates exactly one
 *      and supersedes the rest, with no thrown error (the production analog
 *      of the reported HTTP 500);
 *  (b) a user who already holds a role at a site gracefully no-ops a stray
 *      pending duplicate at that site, leaving the existing role untouched;
 *  (c) invite creation is idempotent at the source for both the manager and
 *      admin invite paths, so the bridge does not need to defend against
 *      duplicates freshly created through this codebase's own invite flows;
 *  (d) regression: the ordinary single-invite accept + login-bridge path is
 *      byte-for-byte unchanged (one row bridged, same shape as before);
 *  (e)/(f) Phase 8 fix: a revoked role must NOT permanently block the same
 *      identity from being re-invited and reactivated at the same site --
 *      the (site_id, user_id) unique index is now partial (excludes revoked
 *      rows) and the bridge's existing-role guard ignores revoked rows.
 *
 * All exercised against a real PGlite Postgres instance, so the unique
 * constraint is genuinely enforced -- these tests fail loudly if the fix
 * regresses to the old blanket-UPDATE shape, or if the revoke-reactivation
 * fix regresses to permanently blocking re-invitation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { authorizeAction } from '../src/auth/enforce.js';
import {
  bridgePendingSiteRoles,
  findOrCreateUserByCognitoSub,
  resolveSiteRole,
} from '../src/db/access.js';
import { createSite, inviteInitialManager } from '../src/admin/service.js';
import { inviteSiteMember } from '../src/manager/service.js';
import { acceptDemoInviteCode, issueDemoInviteCode } from '../src/demo/service.js';
import { siteRoles, type SiteRoleRow } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const PHONE = '+15555550100';

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

/**
 * Inserts a pending SiteRole directly, bypassing the idempotent invite
 * services -- this simulates a duplicate that predates the invite-creation
 * fix (or one produced by any other write path), so the bridge's own
 * resilience is exercised independent of how the duplicate came to exist.
 * `createdAt` is set explicitly so tests can assert a deterministic winner
 * without depending on PGlite's clock resolution.
 */
async function insertPendingInvite(
  db: TestDatabase['db'],
  siteId: string,
  role: 'manager' | 'authorized_user',
  invitedPhone: string,
  createdAt: Date,
): Promise<SiteRoleRow> {
  const [row] = await db
    .insert(siteRoles)
    .values({ siteId, invitedPhone, role, status: 'pending', createdAt })
    .returning();
  assert.ok(row);
  return row;
}

async function reload(db: TestDatabase['db'], id: string): Promise<SiteRoleRow | undefined> {
  const [row] = await db.select().from(siteRoles).where(eq(siteRoles.id, id)).limit(1);
  return row;
}

test('(a) two pending manager invites for the same phone+site: redemption activates exactly one, no thrown error', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const earlier = (await inviteInitialManager(db, siteId, PHONE)).role;
    const duplicate = await insertPendingInvite(
      db,
      siteId,
      'manager',
      PHONE,
      new Date(Date.now() + 60_000),
    );

    // Exercise the literal reported path: handleAcceptSubmit -> acceptDemoInviteCode
    // -> bridgePendingSiteRoles. The old blanket UPDATE would reject this with a
    // Postgres 23505 unique violation that propagated as an unhandled 500.
    const code = await issueDemoInviteCode(db, earlier.id);
    const outcome = await acceptDemoInviteCode(db, code.code);
    assert.ok(outcome, 'redemption succeeds -- no thrown error, no 500');
    assert.equal(outcome.activated, true);
    assert.equal(outcome.role, 'manager');

    const winnerRow = await reload(db, earlier.id);
    assert.equal(winnerRow?.status, 'authorized');
    assert.equal(winnerRow?.userId, outcome.userId);

    const supersededRow = await reload(db, duplicate.id);
    assert.equal(supersededRow?.status, 'revoked', 'the duplicate is superseded, not left pending');
    assert.equal(supersededRow?.userId, null, 'a superseded duplicate is never linked to a user');

    // Exactly one authorized role exists for this user at this site -- the
    // unique (site_id, user_id) index was never violated.
    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.filter((r) => r.userId === outcome.userId).length, 1);

    assert.equal(
      (await authorizeAction(db, outcome.userId, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('(a) a mixed manager+authorized_user duplicate pair for the same phone+site still collapses to one role', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    // Anomalous but possible: two different invite flows target the same phone
    // at the same site with different roles. The (site_id, user_id) unique
    // index does not care about role, so both can never be linked to one user.
    const earlierManager = await insertPendingInvite(
      db,
      siteId,
      'manager',
      PHONE,
      new Date(Date.now() - 60_000),
    );
    await insertPendingInvite(db, siteId, 'authorized_user', PHONE, new Date());

    const user = await findOrCreateUserByCognitoSub(db, 'sub-mixed', PHONE);
    const bridged = await bridgePendingSiteRoles(db, user.id, PHONE);

    assert.equal(bridged.length, 1);
    assert.equal(bridged[0]?.id, earlierManager.id);
    assert.equal(bridged[0]?.status, 'authorized');

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 2);
    const revoked = rows.find((r) => r.id !== earlierManager.id);
    assert.equal(revoked?.status, 'revoked');
    assert.equal(revoked?.userId, null);
  } finally {
    await client.close();
  }
});

test('(b) a user who already holds a role at the site: a stray pending duplicate there is superseded, existing role untouched', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    const user = await findOrCreateUserByCognitoSub(db, 'sub-existing-manager', PHONE);
    const [existingRole] = await db
      .insert(siteRoles)
      .values({ siteId, userId: user.id, role: 'manager', status: 'authorized' })
      .returning();
    assert.ok(existingRole);

    // A stray pending invite for the same phone shows up later at the same
    // site (e.g. a manager re-invites this phone by mistake).
    const stray = (await inviteInitialManager(db, siteId, PHONE)).role;

    const bridged = await bridgePendingSiteRoles(db, user.id, PHONE);
    assert.equal(bridged.length, 0, 'nothing new is bridged -- the user already has a role here');

    const reloadedExisting = await reload(db, existingRole.id);
    assert.deepEqual(
      reloadedExisting,
      existingRole,
      'the existing role is left byte-for-byte untouched',
    );

    const reloadedStray = await reload(db, stray.id);
    assert.equal(reloadedStray?.status, 'revoked');
    assert.equal(reloadedStray?.userId, null);

    // Still exactly one role for this user at this site.
    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.filter((r) => r.userId === user.id).length, 1);
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('(c) invite creation is idempotent for an existing pending phone+site+role -- no duplicate row for the bridge to resolve', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const firstManager = (await inviteInitialManager(db, siteId, PHONE)).role;
    const secondManager = (await inviteInitialManager(db, siteId, PHONE)).role;
    assert.equal(firstManager.id, secondManager.id);

    const firstUser = (await inviteSiteMember(db, siteId, 'authorized_user', '+15555550199', 3000))
      .role;
    const secondUser = (await inviteSiteMember(db, siteId, 'authorized_user', '+15555550199', 9999))
      .role;
    assert.equal(firstUser.id, secondUser.id);

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.length, 2, 'one row per genuinely distinct phone, no duplicates');

    // The bridge sees a single, unambiguous match per phone -- no grouping
    // resolution is even needed for invites created through this codebase's
    // own services.
    const user = await findOrCreateUserByCognitoSub(db, 'sub-idempotent-manager', PHONE);
    const bridged = await bridgePendingSiteRoles(db, user.id, PHONE);
    assert.equal(bridged.length, 1);
    assert.equal(bridged[0]?.id, firstManager.id);
    assert.equal(bridged[0]?.status, 'authorized');
  } finally {
    await client.close();
  }
});

test('(d) regression: the normal single-invite accept + login-bridge path still activates/links correctly', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const managerInvite = (await inviteInitialManager(db, siteId, PHONE)).role;
    const manager = await findOrCreateUserByCognitoSub(db, 'sub-solo-manager', PHONE);
    const managerBridged = await bridgePendingSiteRoles(db, manager.id, PHONE);
    assert.equal(managerBridged.length, 1);
    assert.equal(managerBridged[0]?.id, managerInvite.id);
    assert.equal(managerBridged[0]?.role, 'manager');
    assert.equal(managerBridged[0]?.status, 'authorized');
    assert.equal(managerBridged[0]?.userId, manager.id);
    assert.equal(
      (await authorizeAction(db, manager.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );

    const userPhone = '+15555550188';
    const userInvite = (await inviteSiteMember(db, siteId, 'authorized_user', userPhone, 3000))
      .role;
    const authorizedUser = await findOrCreateUserByCognitoSub(db, 'sub-solo-user', userPhone);
    const userBridged = await bridgePendingSiteRoles(db, authorizedUser.id, userPhone);
    assert.equal(userBridged.length, 1);
    assert.equal(userBridged[0]?.id, userInvite.id);
    assert.equal(userBridged[0]?.role, 'authorized_user');
    // One-step: linked AND activated to authorized on accept (Phase 6).
    assert.equal(userBridged[0]?.status, 'authorized');
    assert.equal(userBridged[0]?.userId, authorizedUser.id);

    // Repeat authentication remains idempotent: nothing left to bridge.
    assert.equal((await bridgePendingSiteRoles(db, manager.id, PHONE)).length, 0);
    assert.equal((await bridgePendingSiteRoles(db, authorizedUser.id, userPhone)).length, 0);
  } finally {
    await client.close();
  }
});

test('concurrent bridge calls for the same duplicate-invite site never throw and converge to one authorized role', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await insertPendingInvite(db, siteId, 'manager', PHONE, new Date(Date.now() - 1_000));
    await insertPendingInvite(db, siteId, 'manager', PHONE, new Date());
    const user = await findOrCreateUserByCognitoSub(db, 'sub-concurrent-manager', PHONE);

    const [first, second] = await Promise.all([
      bridgePendingSiteRoles(db, user.id, PHONE),
      bridgePendingSiteRoles(db, user.id, PHONE),
    ]);

    const totalBridged = first.length + second.length;
    assert.ok(totalBridged <= 1, 'at most one concurrent call bridges a row for this user+site');

    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    const authorizedForUser = rows.filter((r) => r.userId === user.id && r.status === 'authorized');
    assert.equal(authorizedForUser.length, 1, 'exactly one role is authorized for this user+site');
    const revoked = rows.filter((r) => r.status === 'revoked');
    assert.equal(revoked.length, 1);
  } finally {
    await client.close();
  }
});

test('(e) Phase 8 fix: a revoked role does not block re-invitation and reactivation at the same site', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    // First cycle: invite, accept, activate.
    const firstInvite = (await inviteInitialManager(db, siteId, PHONE)).role;
    const user = await findOrCreateUserByCognitoSub(db, 'sub-revoke-reinvite', PHONE);
    const firstBridge = await bridgePendingSiteRoles(db, user.id, PHONE);
    assert.equal(firstBridge.length, 1);
    assert.equal(firstBridge[0]?.status, 'authorized');
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );

    // Revoke it (Company Admin action).
    await db.update(siteRoles).set({ status: 'revoked' }).where(eq(siteRoles.id, firstInvite.id));
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      false,
    );
    const revokedResolved = await resolveSiteRole(db, user.id, siteId);
    assert.equal(
      revokedResolved?.status,
      'revoked',
      'the deny reason stays role_revoked, not no_site_role',
    );

    // Re-invite the same phone at the same site: a genuinely fresh pending row (invite
    // idempotency already treats a revoked phone as available).
    const secondInvite = (await inviteInitialManager(db, siteId, PHONE)).role;
    assert.notEqual(secondInvite.id, firstInvite.id);
    assert.equal(secondInvite.status, 'pending');

    // Accept again: this must now ACTIVATE, not get silently superseded.
    const secondBridge = await bridgePendingSiteRoles(db, user.id, PHONE);
    assert.equal(secondBridge.length, 1, 'the fresh invite is bridged, not silently dropped');
    assert.equal(secondBridge[0]?.id, secondInvite.id);
    assert.equal(secondBridge[0]?.status, 'authorized');

    // Authority is restored.
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
    // resolveSiteRole prefers the reactivated row over the historical revoked one.
    const reactivatedResolved = await resolveSiteRole(db, user.id, siteId);
    assert.equal(reactivatedResolved?.status, 'authorized');

    // Both rows coexist: one revoked (history), one authorized (current).
    const rows = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(rows.filter((r) => r.userId === user.id).length, 2);
    assert.equal(rows.filter((r) => r.userId === user.id && r.status === 'revoked').length, 1);
    assert.equal(rows.filter((r) => r.userId === user.id && r.status === 'authorized').length, 1);
  } finally {
    await client.close();
  }
});

test('(f) Phase 8 fix: re-invite-and-accept after revoke reports real activation, not a false "no authority" outcome', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);

    const firstInvite = (await inviteInitialManager(db, siteId, PHONE)).role;
    const firstCode = await issueDemoInviteCode(db, firstInvite.id);
    const firstOutcome = await acceptDemoInviteCode(db, firstCode.code);
    assert.ok(firstOutcome);
    assert.equal(firstOutcome.activated, true);

    await db.update(siteRoles).set({ status: 'revoked' }).where(eq(siteRoles.id, firstInvite.id));

    const secondInvite = (await inviteInitialManager(db, siteId, PHONE)).role;
    const secondCode = await issueDemoInviteCode(db, secondInvite.id);
    const secondOutcome = await acceptDemoInviteCode(db, secondCode.code);
    assert.ok(secondOutcome, 'the fresh code is redeemed');
    // Before the fix this was falsely `false` (the "ask a manager to re-invite you" bug).
    assert.equal(secondOutcome.activated, true);
    assert.equal(secondOutcome.role, 'manager');
  } finally {
    await client.close();
  }
});
