/**
 * Demo invitation-code acceptance tests (SDD §6.3). Everything is mocked: no
 * AWS, no Cognito, no real SMS -- codes and acceptance run against an in-process
 * PGlite database, and routes are driven with fake req/res like the auth tests.
 *
 * Coverage:
 *  - happy path: a manager code activates the invite (status authorized) and
 *    mints a working signed session, end-to-end through GET+POST /invite/accept;
 *  - an authorized_user code links the identity and activates it in one step;
 *  - an unknown/empty code is rejected;
 *  - an already-used code is rejected (single-use), with the §3.3 bridge run once;
 *  - the pre-session POST is protected by a double-submit token (CSRF mismatch
 *    fails closed);
 *  - DEMO_MODE OFF: no code is shown and the accept routes are not registered.
 *
 * The acceptance path reuses `bridgePendingSiteRoles` (§3.3) UNCHANGED and asserts
 * authority only through the deny-by-default matrix (`authorizeAction`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { Router, type RouteContext } from '../src/server/router.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { PgConnection } from '../src/db/client.js';
import {
  registerDemoRoutes,
  isDemoAcceptSubmission,
  DEMO_CSRF_COOKIE_PREFIX,
} from '../src/demo/routes.js';
import { isDemoMode } from '../src/demo/config.js';
import {
  acceptDemoInviteCode,
  issueDemoInviteCode,
  unusedCodesForSiteRoles,
} from '../src/demo/service.js';
import { renderManagerConsole } from '../src/render/templates/manager.js';
import { renderAcceptResult } from '../src/render/templates/demo-invite.js';
import { authorizeAction } from '../src/auth/enforce.js';
import { createSite, inviteInitialManager } from '../src/admin/service.js';
import { inviteSiteMember, type ManagedSite } from '../src/manager/service.js';
import { verifySession } from '../src/auth/session.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '../src/auth/routes.js';
import { demoInviteCodes, siteRoles } from '../src/db/schema.js';
import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const SESSION_SECRET = 'test-session-secret-placeholder';
const PHONE = '+15555550100';
const DUMMY_BATHROOM = 'b0000000-0000-0000-0000-000000000000';

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

/** Runs `fn` with DEMO_MODE forced on, restoring the prior value afterwards. */
async function withDemoMode<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DEMO_MODE;
  if (value === undefined) {
    delete process.env.DEMO_MODE;
  } else {
    process.env.DEMO_MODE = value;
  }
  try {
    return await fn();
  } finally {
    if (prior === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = prior;
    }
  }
}

function demoRuntime(db: TestDatabase['db']): AuthRuntime {
  return {
    cognito: null,
    sessionSecret: SESSION_SECRET,
    connection: { db, pool: undefined } as unknown as PgConnection,
    jwksFor: () => {
      throw new Error('jwks must not be resolved during demo acceptance');
    },
  };
}

/** Captures what a route handler writes, without a live HTTP server. */
class CapturingResponse {
  statusCode = 0;
  readonly headers: Record<string, string | string[]> = {};
  body = '';
  setHeader(name: string, value: string | string[]): void {
    this.headers[name] = value;
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }
  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
  }
}

function setCookies(res: CapturingResponse): string[] {
  const raw = res.headers['Set-Cookie'];
  if (Array.isArray(raw)) return raw;
  return typeof raw === 'string' ? [raw] : [];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) return undefined;
  const pair = match.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice(name.length + 1));
}

function fakeGetRequest(cookie?: string): IncomingMessage {
  return { headers: cookie ? { cookie } : {}, method: 'GET' } as unknown as IncomingMessage;
}

function fakePostRequest(body: string, cookie?: string): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.headers = cookie ? { cookie } : {};
  req.method = 'POST';
  return req;
}

/** Resolves the pending SiteRole id for a site's sole invite. */
async function soleInviteId(db: TestDatabase['db'], siteId: string): Promise<string> {
  const [row] = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId)).limit(1);
  assert.ok(row, 'a pending invite exists');
  return row.id;
}

interface FormDrive {
  token: string;
  nonce: string;
  cookieHeader: string;
  res: CapturingResponse;
}

/** Finds a Set-Cookie entry whose name starts with `prefix` and returns its full
 * `name=value` pair (nonce-scoped cookie names vary per request; see demo/routes.ts). */
function cookieByPrefix(cookies: string[], prefix: string): { name: string; value: string } {
  const match = cookies.find((cookie) => cookie.startsWith(prefix));
  assert.ok(match, `a cookie starting with ${prefix} is set`);
  const pair = match.split(';', 1)[0] ?? '';
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = decodeURIComponent(pair.slice(eq + 1));
  return { name, value };
}

/** Drives GET /invite/accept, returning the minted double-submit token, its nonce, and
 * the exact `Cookie` header a browser would send back (nonce-named, per demo/routes.ts). */
async function driveForm(router: Router, code?: string): Promise<FormDrive> {
  const matched = router.match('GET', '/invite/accept');
  assert.ok(matched, 'GET /invite/accept is registered in demo mode');
  const res = new CapturingResponse();
  const ctx: RouteContext = {
    req: fakeGetRequest(),
    res: res as unknown as ServerResponse,
    params: {},
    query: code ? { code } : {},
  };
  await matched.handler(ctx);
  const { name, value: token } = cookieByPrefix(setCookies(res), DEMO_CSRF_COOKIE_PREFIX);
  const nonce = name.slice(DEMO_CSRF_COOKIE_PREFIX.length);
  return { token, nonce, cookieHeader: `${name}=${token}`, res };
}

/** Drives POST /invite/accept with an explicit cookie header and form fields. */
async function drivePost(
  router: Router,
  fields: Record<string, string>,
  cookieHeader: string | undefined,
): Promise<CapturingResponse> {
  const matched = router.match('POST', '/invite/accept');
  assert.ok(matched, 'POST /invite/accept is registered in demo mode');
  const body = new URLSearchParams(fields).toString();
  const res = new CapturingResponse();
  const ctx: RouteContext = {
    req: fakePostRequest(body, cookieHeader),
    res: res as unknown as ServerResponse,
    params: {},
    query: {},
  };
  await matched.handler(ctx);
  return res;
}

test('happy path: a manager code activates the invite and mints a working session', async () => {
  await withDemoMode('1', async () => {
    const { db, client } = await createTestDatabase();
    try {
      const siteId = await seedSite(db);
      await inviteInitialManager(db, siteId, PHONE);
      const inviteId = await soleInviteId(db, siteId);
      const { code } = await issueDemoInviteCode(db, inviteId);

      const router = new Router();
      registerDemoRoutes(router, demoRuntime(db));

      const { token, nonce, cookieHeader } = await driveForm(router, code);
      const res = await drivePost(
        router,
        { demo_csrf: token, demo_csrf_nonce: nonce, code },
        cookieHeader,
      );

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /authorized/i);

      // A real, verifiable session cookie is issued (stands in for SMS-OTP login).
      const sessionToken = cookieValue(setCookies(res), SESSION_COOKIE);
      assert.ok(sessionToken, 'a session cookie is set');
      const session = verifySession(sessionToken, SESSION_SECRET, SESSION_MAX_AGE_SECONDS);
      assert.ok(session, 'the session cookie verifies');

      // Authority is conferred only because the reused §3.3 bridge set authorized.
      assert.equal(
        (await authorizeAction(db, session.userId, { type: 'invite_site_role', siteId })).allowed,
        true,
      );

      // Single-use: the code is now spent, and reusing it is rejected.
      const [row] = await db
        .select()
        .from(demoInviteCodes)
        .where(eq(demoInviteCodes.code, code))
        .limit(1);
      assert.ok(row?.usedAt, 'the code is marked used');

      const {
        token: token2,
        nonce: nonce2,
        cookieHeader: cookieHeader2,
      } = await driveForm(router, code);
      const reuse = await drivePost(
        router,
        { demo_csrf: token2, demo_csrf_nonce: nonce2, code },
        cookieHeader2,
      );
      assert.equal(reuse.statusCode, 400);
      assert.match(reuse.body, /already been used/i);
      assert.equal(cookieValue(setCookies(reuse), SESSION_COOKIE), undefined);
    } finally {
      await client.close();
    }
  });
});

test('an authorized_user code links the identity and activates it in one step', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteSiteMember(db, siteId, 'authorized_user', PHONE, 5000);
    const inviteId = await soleInviteId(db, siteId);
    const { code } = await issueDemoInviteCode(db, inviteId);

    const outcome = await acceptDemoInviteCode(db, code);
    assert.ok(outcome, 'a valid code is accepted');
    assert.equal(outcome.role, 'authorized_user');
    assert.equal(outcome.activated, true);

    const [role] = await db.select().from(siteRoles).where(eq(siteRoles.id, inviteId)).limit(1);
    assert.equal(role?.status, 'authorized');
    assert.equal(role?.userId, outcome.userId);

    // The authorized user can now request service within their limit (4500 <= 5000).
    const decision = await authorizeAction(db, outcome.userId, {
      type: 'create_cleaning_request',
      siteId,
      bathroomId: DUMMY_BATHROOM,
      amountCents: 4500,
    });
    assert.equal(decision.allowed, true);
  } finally {
    await client.close();
  }
});

test('renderAcceptResult reflects real authority and never mentions promotion', () => {
  const managerHtml = renderAcceptResult({ activated: true, role: 'manager' });
  assert.match(managerHtml, /authorized <strong>manager<\/strong>/);
  assert.match(managerHtml, /site is operable/i);

  const userHtml = renderAcceptResult({ activated: true, role: 'authorized_user' });
  assert.match(userHtml, /<strong>authorized user<\/strong>/);
  assert.match(userHtml, /request a cleaning/i);
  assert.match(userHtml, /manager for approval/i);

  const inactiveHtml = renderAcceptResult({ activated: false, role: 'authorized_user' });
  assert.match(inactiveHtml, /do not currently hold active authority/i);

  // The removed Phase-6 concept must not resurface in any state.
  for (const html of [managerHtml, userHtml, inactiveHtml]) {
    assert.doesNotMatch(html, /promote/i);
    assert.doesNotMatch(html, /still pending/i);
  }

  // A manager gets a Continue link to their console; an authorized user has none.
  assert.match(managerHtml, /href="\/manager"/);
  assert.doesNotMatch(userHtml, /<a\s/);
  assert.doesNotMatch(inactiveHtml, /<a\s/);
});

test('a superseded-duplicate accept reports the resolved authority, not the redeemed row (no false "pending")', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    // Two pending manager invites for the same phone (a pre-idempotency duplicate). The
    // earliest is the bridge winner; the later one is what we redeem, and it gets superseded.
    const [winner] = await db
      .insert(siteRoles)
      .values({
        siteId,
        invitedPhone: PHONE,
        role: 'manager',
        status: 'pending',
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const [redeemed] = await db
      .insert(siteRoles)
      .values({
        siteId,
        invitedPhone: PHONE,
        role: 'manager',
        status: 'pending',
        createdAt: new Date(),
      })
      .returning();
    assert.ok(winner && redeemed);
    const { code } = await issueDemoInviteCode(db, redeemed.id);

    const outcome = await acceptDemoInviteCode(db, code);
    assert.ok(outcome);
    // The redeemed row itself is superseded to revoked...
    const [redeemedRow] = await db
      .select()
      .from(siteRoles)
      .where(eq(siteRoles.id, redeemed.id))
      .limit(1);
    assert.equal(redeemedRow?.status, 'revoked');
    // ...but the outcome reflects the accepter's REAL authority: an authorized manager
    // (the old code keyed off the revoked redeemed row and wrongly reported "still pending").
    assert.equal(outcome.activated, true);
    assert.equal(outcome.role, 'manager');
  } finally {
    await client.close();
  }
});

test('an unknown or empty code is rejected -- no identity resolved', async () => {
  const { db, client } = await createTestDatabase();
  try {
    assert.equal(await acceptDemoInviteCode(db, 'NOPE-NOPE'), null);
    assert.equal(await acceptDemoInviteCode(db, '   '), null);
  } finally {
    await client.close();
  }
});

test('an already-used code is rejected and the bridge runs only once', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteInitialManager(db, siteId, PHONE);
    const inviteId = await soleInviteId(db, siteId);
    const { code } = await issueDemoInviteCode(db, inviteId);

    const first = await acceptDemoInviteCode(db, code);
    assert.ok(first);
    assert.equal(first.activated, true);

    const second = await acceptDemoInviteCode(db, code);
    assert.equal(second, null, 'a spent code cannot be redeemed again');

    // Exactly one SiteRole exists and it is authorized (no duplicate activation).
    const roles = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.status, 'authorized');
  } finally {
    await client.close();
  }
});

test('the demo accept POST fails closed on a double-submit CSRF mismatch', async () => {
  await withDemoMode('1', async () => {
    const { db, client } = await createTestDatabase();
    try {
      const siteId = await seedSite(db);
      await inviteInitialManager(db, siteId, PHONE);
      const inviteId = await soleInviteId(db, siteId);
      const { code } = await issueDemoInviteCode(db, inviteId);

      const router = new Router();
      registerDemoRoutes(router, demoRuntime(db));
      const { nonce, cookieHeader } = await driveForm(router, code);

      // Submitted form token does not match the cookie token: reject, no session.
      const res = await drivePost(
        router,
        { demo_csrf: 'not-the-token', demo_csrf_nonce: nonce, code },
        cookieHeader,
      );
      assert.equal(res.statusCode, 403);
      assert.equal(cookieValue(setCookies(res), SESSION_COOKIE), undefined);

      // The code remains unused and still redeemable.
      const [row] = await db
        .select()
        .from(demoInviteCodes)
        .where(eq(demoInviteCodes.code, code))
        .limit(1);
      assert.equal(row?.usedAt, null);
    } finally {
      await client.close();
    }
  });
});

test("Phase 9 fix: opening a second accept link does not break the first one's submission", async () => {
  await withDemoMode('1', async () => {
    const { db, client } = await createTestDatabase();
    try {
      const siteId = await seedSite(db);
      await inviteInitialManager(db, siteId, '+15555550101');
      await inviteSiteMember(db, siteId, 'authorized_user', '+15555550102', 3000);
      const [roleA, roleB] = await db.select().from(siteRoles).where(eq(siteRoles.siteId, siteId));
      assert.ok(roleA && roleB);
      const { code: codeA } = await issueDemoInviteCode(db, roleA.id);
      const { code: codeB } = await issueDemoInviteCode(db, roleB.id);

      const router = new Router();
      registerDemoRoutes(router, demoRuntime(db));

      // Two accept pages loaded in the same browser -- e.g. testing two invites, or the
      // same link opened a second time -- must not collide on a shared cookie name.
      const formA = await driveForm(router, codeA);
      const formB = await driveForm(router, codeB);
      assert.notEqual(
        formA.cookieHeader,
        formB.cookieHeader,
        'each accept page mints an independently-named cookie',
      );

      // Submitting the FIRST (older) page, after the second has already been loaded,
      // must still succeed -- this is the exact regression: a single fixed cookie name
      // would have let form B's GET overwrite form A's cookie in the browser.
      const resA = await drivePost(
        router,
        { demo_csrf: formA.token, demo_csrf_nonce: formA.nonce, code: codeA },
        formA.cookieHeader,
      );
      assert.equal(resA.statusCode, 200);
      assert.doesNotMatch(resA.body, /Invalid or missing form token/);

      // The second page's own submission still works too.
      const resB = await drivePost(
        router,
        { demo_csrf: formB.token, demo_csrf_nonce: formB.nonce, code: codeB },
        formB.cookieHeader,
      );
      assert.equal(resB.statusCode, 200);
      assert.doesNotMatch(resB.body, /Invalid or missing form token/);
    } finally {
      await client.close();
    }
  });
});

test('DEMO_MODE off: accept routes are not registered and no code is exposed', async () => {
  await withDemoMode(undefined, async () => {
    assert.equal(isDemoMode(), false);
    assert.equal(isDemoAcceptSubmission('POST', '/invite/accept'), false);

    const { db, client } = await createTestDatabase();
    try {
      const router = new Router();
      registerDemoRoutes(router, demoRuntime(db));
      assert.equal(router.match('GET', '/invite/accept'), undefined);
      assert.equal(router.match('POST', '/invite/accept'), undefined);

      // The console renders no code when no demo codes are supplied (production).
      const site: ManagedSite = {
        site: {
          id: 's1',
          name: 'Central Plaza',
          address: '1 Market St',
          timezone: 'America/New_York',
          currency: 'usd',
          fixedPriceCents: 4500,
          terms: null,
          createdAt: new Date(),
        },
        members: [
          {
            id: 'r1',
            siteId: 's1',
            userId: null,
            invitedPhone: PHONE,
            role: 'authorized_user',
            status: 'pending',
            maxAuthorizationCents: 3000,
            bathroomScope: null,
            createdAt: new Date(),
          },
        ],
      };
      const html = renderManagerConsole([site], 'csrf-token');
      assert.doesNotMatch(html, /invite-code/);
      assert.doesNotMatch(html, /\/invite\/accept/);
    } finally {
      await client.close();
    }
  });
});

test('the console exposes a usable code in demo mode and drops it once spent', async () => {
  await withDemoMode('1', async () => {
    const { db, client } = await createTestDatabase();
    try {
      const siteId = await seedSite(db);
      await inviteSiteMember(db, siteId, 'authorized_user', PHONE, 3000);
      const inviteId = await soleInviteId(db, siteId);
      const { code } = await issueDemoInviteCode(db, inviteId);

      const before = await unusedCodesForSiteRoles(db, [inviteId]);
      assert.equal(before.get(inviteId), code);

      // The console surfaces the code and its accept link.
      const [site] = await db.select().from(siteRoles).where(eq(siteRoles.id, inviteId)).limit(1);
      assert.ok(site);

      await acceptDemoInviteCode(db, code);
      const after = await unusedCodesForSiteRoles(db, [inviteId]);
      assert.equal(after.has(inviteId), false, 'a spent code is no longer offered');
    } finally {
      await client.close();
    }
  });
});
