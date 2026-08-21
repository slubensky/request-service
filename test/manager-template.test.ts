/**
 * Site Manager console template rendering (SDD §11.4, §10): members with limits +
 * set-limit/delete controls, pending over-limit approvals with an Approve control,
 * and demo accept codes. Pure render test -- no DB -- exercising every branch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderManagerConsole } from '../src/render/templates/manager.js';
import type { ManagedSite } from '../src/manager/service.js';
import type { PendingApprovalView } from '../src/payments/approvals.js';
import type { RequestApprovalRow, SiteRoleRow, SiteRow } from '../src/db/schema.js';

const now = new Date();

const site: SiteRow = {
  id: 's1',
  name: 'Central Plaza',
  address: '1 Market St',
  timezone: 'America/New_York',
  currency: 'usd',
  fixedPriceCents: 4500,
  terms: null,
  createdAt: now,
};

function siteRole(overrides: Partial<SiteRoleRow>): SiteRoleRow {
  return {
    id: 'r0',
    siteId: 's1',
    userId: null,
    invitedPhone: '+15550000000',
    role: 'manager',
    status: 'authorized',
    maxAuthorizationCents: null,
    bathroomScope: null,
    createdAt: now,
    ...overrides,
  };
}

function approvalRow(overrides: Partial<RequestApprovalRow>): RequestApprovalRow {
  return {
    id: 'a1',
    siteId: 's1',
    bathroomId: 'b1',
    requesterUserId: 'u9',
    priceVersion: 1,
    amountCents: 4500,
    status: 'pending',
    approvedByUserId: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: now,
    ...overrides,
  };
}

test('renderManagerConsole shows members, limits, approvals, and demo codes', () => {
  const managed: ManagedSite[] = [
    {
      site,
      members: [
        siteRole({ id: 'm1', role: 'manager', status: 'authorized', invitedPhone: '+15550000001' }),
        siteRole({
          id: 'u1',
          role: 'authorized_user',
          status: 'authorized',
          maxAuthorizationCents: 3000,
          invitedPhone: '+15550000002',
        }),
        siteRole({
          id: 'u2',
          role: 'authorized_user',
          status: 'pending',
          maxAuthorizationCents: null, // -> "Limit: none"
          invitedPhone: '+15550000003',
        }),
      ],
    },
  ];
  const approvals: PendingApprovalView[] = [
    {
      approval: approvalRow({ id: 'a1' }),
      bathroomLabel: 'Ground floor',
      requesterPhone: '+15550000002',
    },
    { approval: approvalRow({ id: 'a2' }), bathroomLabel: 'Upstairs', requesterPhone: null },
  ];
  const demoCodes = new Map([['u2', 'EEEE-FFFF']]);

  const html = renderManagerConsole(managed, 'csrf-token', approvals, demoCodes);

  assert.match(html, /class="members"/);
  assert.match(html, /Authorized user/);
  assert.match(html, /Limit: \$30\.00/);
  assert.match(html, /Limit: none/);
  assert.match(html, /Update limit/);
  assert.match(html, /Delete/);
  assert.match(html, /Approve hold for \$45\.00/);
  assert.match(html, /Ground floor/);
  assert.match(html, /a requester/); // null requesterPhone fallback
  assert.match(html, /EEEE-FFFF/); // demo code branch

  // Empty state renders the "no members / no approvals" branches.
  const emptyHtml = renderManagerConsole([{ site, members: [] }], 'csrf-token', [], new Map());
  assert.match(emptyHtml, /No members yet/);
  assert.match(emptyHtml, /No requests awaiting approval/);
});
