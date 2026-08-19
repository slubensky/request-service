/**
 * Integration tests for the `next`-redirect step-up re-authentication addition to
 * `GET /auth/login` / `GET /auth/callback` / `GET /auth/passkey/register` (SDD §6.4).
 * Cognito is fully mocked exactly as test/sms-otp.test.ts and test/passkey.test.ts do: a
 * local JWKS is injected and the token endpoint is stubbed, so this runs in CI with no
 * external credentials and no live Cognito. Proves the allow-list is enforced (only
 * `^/s/[A-Za-z0-9_-]+$` is ever honored), the return-to cookie round-trips through the
 * callback, and passkey enrollment never inherits a stale value.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { Router, type RouteContext } from '../src/server/router.js';
import { registerAuthRoutes } from '../src/auth/routes.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { CognitoConfig } from '../src/auth/cognito.js';
import type { PgConnection } from '../src/db/client.js';
import { signSession } from '../src/auth/session.js';
import { createTestDatabase } from './helpers/pglite.js';

const config: CognitoConfig = {
  domain: 'https://example.auth.us-east-1.amazoncognito.com',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-placeholder',
  redirectUri: 'https://app.example.com/auth/callback',
  logoutRedirectUri: 'https://app.example.com/',
};

const KID = 'test-key-1';
const STATE = 'state-xyz';
const SUB = 'cognito-sub-step-up';
const SESSION_SECRET = 'test-session-secret-placeholder';
const RETURN_TO_COOKIE = 'rs_oauth_return_to';
const STATE_COOKIE = 'rs_oauth_state';
const SESSION_COOKIE = 'rs_session';

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
  if (Array.isArray(raw)) {
    return raw;
  }
  return typeof raw === 'string' ? [raw] : [];
}

function cookieAttributes(setCookieHeaders: string[], name: string): string | undefined {
  return setCookieHeaders.find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValue(setCookieHeaders: string[], name: string): string | undefined {
  const match = cookieAttributes(setCookieHeaders, name);
  if (!match) {
    return undefined;
  }
  const pair = match.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice(name.length + 1));
}

function authenticatedRuntime(): AuthRuntime {
  return {
    cognito: config,
    sessionSecret: SESSION_SECRET,
    connection: null,
    jwksFor: () => {
      throw new Error('jwks must not be resolved during login/register initiation');
    },
  };
}

async function driveLogin(query: Record<string, string>): Promise<CapturingResponse> {
  const router = new Router();
  registerAuthRoutes(router, authenticatedRuntime());
  const matched = router.match('GET', '/auth/login');
  assert.ok(matched, 'login route is registered');
  const req = { headers: {} } as unknown as IncomingMessage;
  const res = new CapturingResponse();
  const ctx: RouteContext = { req, res: res as unknown as ServerResponse, params: {}, query };
  await matched.handler(ctx);
  return res;
}

async function driveRegister(cookie: string): Promise<CapturingResponse> {
  const router = new Router();
  registerAuthRoutes(router, authenticatedRuntime());
  const matched = router.match('GET', '/auth/passkey/register');
  assert.ok(matched, 'passkey register route is registered');
  const req = { headers: { cookie } } as unknown as IncomingMessage;
  const res = new CapturingResponse();
  const ctx: RouteContext = { req, res: res as unknown as ServerResponse, params: {}, query: {} };
  await matched.handler(ctx);
  return res;
}

test('GET /auth/login with a next matching the allow-list stores it in a short-lived HttpOnly cookie', async () => {
  const res = await driveLogin({ next: '/s/abcDEF123_-' });

  assert.equal(res.statusCode, 302);
  const cookies = setCookies(res);
  assert.equal(cookieValue(cookies, RETURN_TO_COOKIE), '/s/abcDEF123_-');
  const attributes = cookieAttributes(cookies, RETURN_TO_COOKIE) ?? '';
  assert.match(attributes, /HttpOnly/i);
  assert.match(attributes, /SameSite=Lax/i);
});

test('GET /auth/login without a next clears any stale return-to cookie', async () => {
  const res = await driveLogin({});

  const attributes = cookieAttributes(setCookies(res), RETURN_TO_COOKIE) ?? '';
  assert.match(attributes, /Max-Age=0/);
});

test('GET /auth/login ignores a next outside the allow-list (open-redirect guard)', async () => {
  for (const unsafe of [
    '//evil.example.com',
    'https://evil.example.com/s/abc',
    '/admin',
    '/s/../../etc/passwd',
    '/s/',
  ]) {
    const res = await driveLogin({ next: unsafe });
    const attributes = cookieAttributes(setCookies(res), RETURN_TO_COOKIE) ?? '';
    assert.match(attributes, /Max-Age=0/, `rejected as unsafe: ${unsafe}`);
  }
});

test('GET /auth/passkey/register always clears any return-to value from an earlier login attempt', async () => {
  const sessionToken = signSession({ userId: 'user-1', sub: SUB }, SESSION_SECRET);
  const cookie = `${SESSION_COOKIE}=${sessionToken}; ${RETURN_TO_COOKIE}=/s/should-not-survive`;
  const res = await driveRegister(cookie);

  assert.equal(res.statusCode, 302);
  const attributes = cookieAttributes(setCookies(res), RETURN_TO_COOKIE) ?? '';
  assert.match(attributes, /Max-Age=0/);
});

async function makeKeys(): Promise<{ privateKey: KeyLike; jwks: JWTVerifyGetKey }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [publicJwk] }) };
}

async function signIdToken(privateKey: KeyLike): Promise<string> {
  return new SignJWT({ token_use: 'id', phone_number_verified: false })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(config.issuer)
    .setAudience(config.clientId)
    .setSubject(SUB)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** Drives GET /auth/callback with a mocked token exchange, mirroring test/sms-otp.test.ts. */
async function driveCallback(cookieHeader: string): Promise<CapturingResponse> {
  const { privateKey, jwks } = await makeKeys();
  const idToken = await signIdToken(privateKey);
  const { db, client } = await createTestDatabase();
  const runtime: AuthRuntime = {
    cognito: config,
    sessionSecret: SESSION_SECRET,
    connection: { db, pool: undefined } as unknown as PgConnection,
    jwksFor: () => jwks,
  };

  const router = new Router();
  registerAuthRoutes(router, runtime);
  const matched = router.match('GET', '/auth/callback');
  assert.ok(matched, 'callback route is registered');

  const req = { headers: { cookie: cookieHeader } } as unknown as IncomingMessage;
  const res = new CapturingResponse();
  const ctx: RouteContext = {
    req,
    res: res as unknown as ServerResponse,
    params: {},
    query: { code: 'auth-code-1', state: STATE },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ id_token: idToken, access_token: 'access.jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  try {
    await matched.handler(ctx);
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
  }
  return res;
}

test('GET /auth/callback redirects to the recorded return-to path and clears the cookie', async () => {
  const cookieHeader = `${STATE_COOKIE}=${STATE}; ${RETURN_TO_COOKIE}=/s/back-to-here`;
  const res = await driveCallback(cookieHeader);

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/s/back-to-here');
  const attributes = cookieAttributes(setCookies(res), RETURN_TO_COOKIE) ?? '';
  assert.match(attributes, /Max-Age=0/, 'the return-to cookie is cleared after use');
});

test('GET /auth/callback falls back to "/" when no return-to cookie is present (unchanged Phase 2 behavior)', async () => {
  const cookieHeader = `${STATE_COOKIE}=${STATE}`;
  const res = await driveCallback(cookieHeader);

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/');
});
