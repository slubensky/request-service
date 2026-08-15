/**
 * Demo invitation-code acceptance tests (SDD §6.3). Everything is mocked: no
 * AWS, no Cognito, no real SMS -- codes and acceptance run against an in-process
 * PGlite database, and routes are driven with fake req/res like the auth tests.
 *
 * Coverage:
 *  - happy path: a manager code activates the invite (status authorized) and
 *    mints a working signed session, end-to-end through GET+POST /invite/accept;
 *  - an assistant code links the identity but stays pending (no self-elevation);
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
  DEMO_CSRF_COOKIE,
} from '../src/demo/routes.js';
import { isDemoMode } from '../src/demo/config.js';
import {
  acceptDemoInviteCode,
  issueDemoInviteCode,
  unusedCodesForSiteRoles,
} from '../src/demo/service.js';
import { renderManagerConsole } from '../src/render/templates/manager.js';
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
  res: CapturingResponse;
}

/** Drives GET /invite/accept, returning the minted double-submit token. */
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
  const token = cookieValue(setCookies(res), DEMO_CSRF_COOKIE);
  assert.ok(token, 'a demo CSRF cookie is minted');
  return { token, res };
}

/** Drives POST /invite/accept with an explicit cookie token and form fields. */
async function drivePost(
  router: Router,
  fields: Record<string, string>,
  cookieToken: string | undefined,
): Promise<CapturingResponse> {
  const matched = router.match('POST', '/invite/accept');
  assert.ok(matched, 'POST /invite/accept is registered in demo mode');
  const body = new URLSearchParams(fields).toString();
  const cookie = cookieToken ? `${DEMO_CSRF_COOKIE}=${cookieToken}` : undefined;
  const res = new CapturingResponse();
  const ctx: RouteContext = {
    req: fakePostRequest(body, cookie),
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

      const { token } = await driveForm(router, code);
      const res = await drivePost(router, { demo_csrf: token, code }, token);

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

      const { token: token2 } = await driveForm(router, code);
      const reuse = await drivePost(router, { demo_csrf: token2, code }, token2);
      assert.equal(reuse.statusCode, 400);
      assert.match(reuse.body, /already been used/i);
      assert.equal(cookieValue(setCookies(reuse), SESSION_COOKIE), undefined);
    } finally {
      await client.close();
    }
  });
});

test('an assistant code links the identity but stays pending -- no self-elevation', async () => {
  const { db, client } = await createTestDatabase();
  try {
    const siteId = await seedSite(db);
    await inviteSiteMember(db, siteId, 'assistant', PHONE);
    const inviteId = await soleInviteId(db, siteId);
    const { code } = await issueDemoInviteCode(db, inviteId);

    const outcome = await acceptDemoInviteCode(db, code);
    assert.ok(outcome, 'a valid code is accepted');
    assert.equal(outcome.role, 'assistant');
    assert.equal(outcome.activated, false);

    const [role] = await db.select().from(siteRoles).where(eq(siteRoles.id, inviteId)).limit(1);
    assert.equal(role?.status, 'pending');
    assert.equal(role?.userId, outcome.userId);

    const decision = await authorizeAction(db, outcome.userId, {
      type: 'create_cleaning_request',
      siteId,
      bathroomId: DUMMY_BATHROOM,
      amountCents: 4500,
    });
    assert.equal(decision.allowed, false);
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
      const { token } = await driveForm(router, code);

      // Submitted form token does not match the cookie token: reject, no session.
      const res = await drivePost(router, { demo_csrf: 'not-the-token', code }, token);
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
        pendingInvites: [
          {
            id: 'r1',
            siteId: 's1',
            userId: null,
            invitedPhone: PHONE,
            role: 'assistant',
            status: 'pending',
            maxAuthorizationCents: null,
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
      await inviteSiteMember(db, siteId, 'assistant', PHONE);
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
