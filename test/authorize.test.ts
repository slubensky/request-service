import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize, type Action, type ResolvedSiteRole } from '../src/auth/authorize.js';

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

const createRequest: Action = {
  type: 'create_cleaning_request',
  siteId: SITE,
  bathroomId: BATHROOM,
  amountCents: 5000,
};

test('a customer with no SiteRole is denied', () => {
  const decision = authorize(null, createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'no_site_role' });
});

test('a role for a different site cannot act across sites', () => {
  const decision = authorize(role({ siteId: 'other-site' }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'wrong_site' });
});

test('a pending assistant cannot self-authorize a paid request', () => {
  const decision = authorize(role({ status: 'pending' }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'requires_authorized_status' });
});

test('a revoked role is denied every action', () => {
  const decision = authorize(role({ status: 'revoked' }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'role_revoked' });
});

test('an authorized assistant within max is allowed', () => {
  const decision = authorize(role({}), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an authorized manager within max is allowed', () => {
  const decision = authorize(role({ role: 'manager' }), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an amount above max_authorization_cents is denied', () => {
  const decision = authorize(role({ maxAuthorizationCents: 4999 }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'exceeds_max_authorization' });
});

test('a role with no authorization limit cannot start a paid request', () => {
  const decision = authorize(role({ maxAuthorizationCents: null }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'no_authorization_limit' });
});

test('a bathroom outside an assistant scope is denied', () => {
  const decision = authorize(role({ bathroomScope: ['other-bath'] }), createRequest);
  assert.deepEqual(decision, { allowed: false, reason: 'bathroom_out_of_scope' });
});

test('a bathroom inside an explicit scope is allowed', () => {
  const decision = authorize(role({ bathroomScope: [BATHROOM] }), createRequest);
  assert.deepEqual(decision, { allowed: true });
});

test('an authorized manager may perform manager-only actions', () => {
  const decision = authorize(role({ role: 'manager' }), { type: 'invite_site_role', siteId: SITE });
  assert.deepEqual(decision, { allowed: true });
});

test('an assistant lacks the capability for manager-only actions', () => {
  const decision = authorize(role({ role: 'assistant' }), {
    type: 'approve_assistant_request',
    siteId: SITE,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});

test('a pending manager cannot yet act (status gate precedes capability)', () => {
  const decision = authorize(role({ role: 'manager', status: 'pending' }), {
    type: 'invite_site_role',
    siteId: SITE,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'requires_authorized_status' });
});

// Capabilities reserved for the forthcoming cross-site company_admin role must
// be denied to a site manager -- they are held by no current role.
test('an authorized manager cannot capture a payment (reserved for company_admin)', () => {
  const decision = authorize(role({ role: 'manager' }), { type: 'capture_payment', siteId: SITE });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});

test('an authorized manager cannot cancel a payment (reserved for company_admin)', () => {
  const decision = authorize(role({ role: 'manager' }), { type: 'cancel_payment', siteId: SITE });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});

test('an authorized manager cannot replace a QR token (reserved for company_admin)', () => {
  const decision = authorize(role({ role: 'manager' }), {
    type: 'replace_qr_token',
    siteId: SITE,
    bathroomId: BATHROOM,
  });
  assert.deepEqual(decision, { allowed: false, reason: 'capability_not_granted' });
});
