/**
 * Company-Admin console template rendering (SDD §11.1, §11.3, Phase 7): the console
 * lists managers and authorized users, shows each authorized user's approval limit
 * with set-limit + revoke controls, and surfaces demo accept codes for pending
 * invites. Pure render test -- no DB -- exercising every membership branch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAdminConsole } from '../src/render/templates/admin.js';
import type { SiteWithBathrooms } from '../src/admin/service.js';
import type { BathroomRow, SiteRoleRow, SiteRow } from '../src/db/schema.js';

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

const bathroom: BathroomRow = {
  id: 'b1',
  siteId: 's1',
  label: 'Ground floor',
  status: 'active',
  createdAt: now,
};

function siteRole(overrides: Partial<SiteRoleRow>): SiteRoleRow {
  return {
    id: 'r0',
    siteId: 's1',
    userId: null,
    invitedPhone: '+15550000000',
    role: 'manager',
    status: 'pending',
    maxAuthorizationCents: null,
    bathroomScope: null,
    createdAt: now,
    ...overrides,
  };
}

test('renderAdminConsole lists managers + authorized users, with limits, controls, and codes', () => {
  const entries: SiteWithBathrooms[] = [
    {
      site,
      bathrooms: [bathroom],
      members: [
        siteRole({ id: 'm1', role: 'manager', status: 'pending', invitedPhone: '+15550000001' }),
        siteRole({
          id: 'u1',
          role: 'authorized_user',
          status: 'authorized',
          maxAuthorizationCents: null, // -> "Limit: none"
          invitedPhone: '+15550000002',
        }),
        siteRole({
          id: 'u2',
          role: 'authorized_user',
          status: 'pending',
          maxAuthorizationCents: 3000, // -> "Limit: $30.00"
          invitedPhone: '+15550000003',
        }),
      ],
    },
    { site: { ...site, id: 's2', name: 'Empty Site' }, bathrooms: [], members: [] },
  ];
  const demoCodes = new Map([
    ['m1', 'AAAA-BBBB'],
    ['u2', 'CCCC-DDDD'],
  ]);

  const html = renderAdminConsole(entries, 'csrf-token', demoCodes);

  assert.match(html, /class="managers"/);
  assert.match(html, /class="authorized-users"/);
  assert.match(html, /Limit: none/); // u1 null limit branch
  assert.match(html, /Limit: \$30\.00/); // u2 numeric limit branch
  assert.match(html, /Update limit/);
  assert.match(html, /button-danger/); // revoke control
  assert.match(html, /AAAA-BBBB/); // manager demo code branch
  assert.match(html, /CCCC-DDDD/); // authorized-user demo code branch
  assert.match(html, /No managers yet/); // empty-site branches
  assert.match(html, /No authorized users yet/);
  assert.match(html, /No bathrooms yet/);
});
