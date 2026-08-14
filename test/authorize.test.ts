import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorize,
  type Action,
  type PlatformRole,
  type Principal,
  type ResolvedSiteRole,
} from '../src/auth/authorize.js';

const SITE = 'site-1';
const BATHROOM = 'bath-1';

function role(overrides: Partial<ResolvedSiteRole>): ResolvedSiteRole {
  return {
    siteId: SITE,
    role: 'assistant',
    status: 'authorized',
    maxAuthorizationCents: 5000,
    bathroomScope: null,
    ...overrides,
  };
}

/** Build a principal from a SiteRole (default) and/or a platform role. */
function principal(
  siteRole: ResolvedSiteRole | null,
  platformRole: PlatformRole = 'member',
): Principal {
  return { platformRole, siteRole };
}

const createRequest: Action = {
  type: 'create_cleaning_request',
  siteId: SITE,
  bathroomId: BATHROOM,
  amountCents: 5000,
};

// --- Site-scoped authority (manager / assistant) ---

test('a customer with no SiteRole is denied', () => {
  const decision = authorize(principal(null), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'no_site_role' });
});

test('a role for a different site cannot act across sites', () => {
  const decision = authorize(principal(role({ siteId: 'other-site' })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'wrong_site' });
});

test('a pending assistant cannot self-authorize a paid request', () => {
  const decision = authorize(principal(role({ status: 'pending' })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'requires_authorized_status' });
});

test('a revoked role is denied every action', () => {
  const decision = authorize(principal(role({ status: 'revoked' })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'role_revoked' });
});

test('an authorized assistant within max is allowed', () => {
  const decision = authorize(principal(role({})), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an authorized manager within max is allowed', () => {
  const decision = authorize(principal(role({ role: 'manager' })), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an amount above max_authorization_cents is denied', () => {
  const decision = authorize(principal(role({ maxAuthorizationCents: 4999 })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'exceeds_max_authorization' });
});

test('a role with no authorization limit cannot start a paid request', () => {
  const decision = authorize(principal(role({ maxAuthorizationCents: null })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'no_authorization_limit' });
});

test('a bathroom outside an assistant scope is denied', () => {
  const decision = authorize(principal(role({ bathroomScope: ['other-bath'] })), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'bathroom_out_of_scope' });
});

test('a bathroom inside an explicit scope is allowed', () => {
  const decision = authorize(principal(role({ bathroomScope: [BATHROOM] })), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an authorized manager may invite, promote, and revoke assistants', () => {
  const manager = principal(role({ role: 'manager' }));
  for (const type of ['invite_site_role', 'promote_site_role', 'revoke_site_role'] as const) {
    assert.deepEqual(authorize(manager, { type, siteId: SITE }), { allowed: true });
  }
});

test('an authorized manager may approve an assistant request and view payments', () => {
  const manager = principal(role({ role: 'manager' }));
  assert.deepEqual(authorize(manager, { type: 'approve_assistant_request', siteId: SITE }), {
    allowed: true,
  });
  assert.deepEqual(authorize(manager, { type: 'view_payment', siteId: SITE }), { allowed: true });
});

test('an authorized manager may replace a QR token at their own site', () => {
  const decision = authorize(principal(role({ role: 'manager' })), {
    type: 'replace_qr_token',
    siteId: SITE,
    bathroomId: BATHROOM,
  });
  assert.deepEqual(decision, { allowed: true });
});

test('an assistant lacks the capability for manager-only actions', () => {
  const decision = authorize(principal(role({ role: 'assistant' })), {
    type: 'approve_assistant_request',
    siteId: SITE,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});

test('a pending manager cannot yet act (status gate precedes capability)', () => {
  const decision = authorize(principal(role({ role: 'manager', status: 'pending' })), {
    type: 'invite_site_role',
    siteId: SITE,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'requires_authorized_status' });
});

// A site manager must NOT capture/cancel payments or onboard sites/bathrooms/QR
// issuance/price -- those are platform (company_admin) capabilities.
test('an authorized manager cannot capture or cancel a payment', () => {
  const manager = principal(role({ role: 'manager' }));
  assert.deepEqual(authorize(manager, { type: 'capture_payment', siteId: SITE }), {
    allowed: false,
    reason: 'capability_not_granted',
  });
  assert.deepEqual(authorize(manager, { type: 'cancel_payment', siteId: SITE }), {
    allowed: false,
    reason: 'capability_not_granted',
  });
});

test('an authorized manager cannot issue a QR token or manage price', () => {
  const manager = principal(role({ role: 'manager' }));
  assert.deepEqual(
    authorize(manager, { type: 'issue_qr_token', siteId: SITE, bathroomId: BATHROOM }),
    { allowed: false, reason: 'capability_not_granted' },
  );
  assert.deepEqual(authorize(manager, { type: 'manage_price', siteId: SITE }), {
    allowed: false,
    reason: 'capability_not_granted',
  });
});

test('a manager cannot create a site (a site-less company_admin power)', () => {
  const decision = authorize(principal(role({ role: 'manager' })), { type: 'create_site' });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});

// --- Platform authority (company_admin), cross-site and SiteRole-independent ---

test('a company_admin may onboard sites, bathrooms, QR, and price with no SiteRole', () => {
  const admin = principal(null, 'company_admin');
  assert.deepEqual(authorize(admin, { type: 'create_site' }), { allowed: true });
  assert.deepEqual(authorize(admin, { type: 'edit_site', siteId: SITE }), { allowed: true });
  assert.deepEqual(authorize(admin, { type: 'create_bathroom', siteId: SITE }), { allowed: true });
  assert.deepEqual(
    authorize(admin, { type: 'issue_qr_token', siteId: SITE, bathroomId: BATHROOM }),
    { allowed: true },
  );
  assert.deepEqual(authorize(admin, { type: 'manage_price', siteId: SITE }), { allowed: true });
  assert.deepEqual(authorize(admin, { type: 'invite_initial_manager', siteId: SITE }), {
    allowed: true,
  });
});

test('a company_admin may capture/cancel payments and mark completed cross-site', () => {
  const admin = principal(null, 'company_admin');
  for (const type of ['capture_payment', 'cancel_payment', 'mark_completed'] as const) {
    assert.deepEqual(authorize(admin, { type, siteId: 'any-site' }), { allowed: true });
  }
});

test('a company_admin does NOT request cleanings (needs a SiteRole, has none)', () => {
  const decision = authorize(principal(null, 'company_admin'), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'no_site_role' });
});

test('a plain member with no SiteRole cannot onboard a site', () => {
  const decision = authorize(principal(null, 'member'), { type: 'create_site' });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});
