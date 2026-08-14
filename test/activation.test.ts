/**
 * Invite bridge tests (SDD §3.3): pending SiteRole activation on authentication.
 *
 * Cognito is mocked at the boundary -- these exercise `bridgePendingSiteRoles`
 * with a *verified* phone number (the value the ID-token verifier would return)
 * against a real PGlite database, and assert authority through the deny-by-
 * default capability matrix (`authorizeAction`), never a bespoke check. They
 * cover: verified-identifier match activates a manager; a non-matching token
 * leaves the invite pending with no authority; an assistant invite links but
 * stays pending (no self-elevation); and repeat authentication is idempotent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeAction } from '../src/auth/enforce.js';
import { bridgePendingSiteRoles, findOrCreateUserByCognitoSub } from '../src/db/access.js';
import { createSite, inviteInitialManager } from '../src/admin/service.js';
import { inviteSiteMember } from '../src/manager/service.js';
import { siteRoles } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const INVITED_PHONE = '+15555550100';
const OTHER_PHONE = '+15555559999';

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

test('a verified phone matching a pending manager invite activates it and grants authority', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteInitialManager(db, siteId, INVITED_PHONE);

    // The invitee authenticates: identity resolves to a User carrying the phone.
    const user = await findOrCreateUserByCognitoSub(db, 'sub-manager', INVITED_PHONE);

    // Before the bridge runs, the matrix denies -- no linked role yet.
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      false,
    );

    const bridged = await bridgePendingSiteRoles(db, user.id, INVITED_PHONE);
    assert.equal(bridged.length, 1);
    assert.equal(bridged[0]?.role, 'manager');
    assert.equal(bridged[0]?.status, 'authorized');
    assert.equal(bridged[0]?.userId, user.id);

    // Only after activation does the matrix confer manager authority at this site.
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('a non-matching verified phone leaves the invite pending and confers no authority', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteInitialManager(db, siteId, INVITED_PHONE);

    // A different person authenticates with a different verified phone.
    const stranger = await findOrCreateUserByCognitoSub(db, 'sub-stranger', OTHER_PHONE);
    const bridged = await bridgePendingSiteRoles(db, stranger.id, OTHER_PHONE);
    assert.equal(bridged.length, 0);

    // The invite is untouched: still pending, still unlinked.
    const [invite] = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(invite?.status, 'pending');
    assert.equal(invite?.userId, null);

    // The stranger holds no authority anywhere.
    assert.equal(
      (await authorizeAction(db, stranger.id, { type: 'invite_site_role', siteId })).allowed,
      false,
    );
  } finally {
    await client.close();
  }
});

test('a matching assistant invite is linked but stays pending -- no self-elevation to authority', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteSiteMember(db, siteId, 'assistant', INVITED_PHONE);

    const user = await findOrCreateUserByCognitoSub(db, 'sub-assistant', INVITED_PHONE);
    const bridged = await bridgePendingSiteRoles(db, user.id, INVITED_PHONE);
    assert.equal(bridged.length, 1);
    assert.equal(bridged[0]?.role, 'assistant');
    // Linked to the identity, but authority is withheld until a manager promotes.
    assert.equal(bridged[0]?.userId, user.id);
    assert.equal(bridged[0]?.status, 'pending');

    // The matrix still denies a paid request for a pending assistant.
    const decision = await authorizeAction(db, user.id, {
      type: 'create_cleaning_request',
      siteId,
      bathroomId: 'b0000000-0000-0000-0000-000000000000',
      amountCents: 4500,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, 'requires_authorized_status');
  } finally {
    await client.close();
  }
});

test('repeat authentication is idempotent -- no duplicate link, no status regression', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteInitialManager(db, siteId, INVITED_PHONE);
    const user = await findOrCreateUserByCognitoSub(db, 'sub-manager', INVITED_PHONE);

    const first = await bridgePendingSiteRoles(db, user.id, INVITED_PHONE);
    assert.equal(first.length, 1);

    // Authenticating again re-matches nothing already linked.
    const second = await bridgePendingSiteRoles(db, user.id, INVITED_PHONE);
    assert.equal(second.length, 0);

    const roles = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.status, 'authorized');
    assert.equal(roles[0]?.userId, user.id);

    // Authority is stable across the repeat.
    assert.equal(
      (await authorizeAction(db, user.id, { type: 'invite_site_role', siteId })).allowed,
      true,
    );
  } finally {
    await client.close();
  }
});

test('a null verified phone links nothing', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteInitialManager(db, siteId, INVITED_PHONE);
    const user = await findOrCreateUserByCognitoSub(db, 'sub-nophone', null);

    const bridged = await bridgePendingSiteRoles(db, user.id, null);
    assert.equal(bridged.length, 0);

    const [invite] = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(invite?.status, 'pending');
    assert.equal(invite?.userId, null);
  } finally {
    await client.close();
  }
});
