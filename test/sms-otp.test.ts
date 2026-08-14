/**
 * Integration test for the SMS OTP activation path through the Cognito Hosted
 * UI callback. Cognito is fully mocked: the token endpoint is stubbed and the
 * ID token is signed with a local JWKS injected via the auth runtime (as PR
 * #6/#7 do), so the suite runs in CI with no external credentials and sends no
 * real SMS. It proves the shared callback -- reused unchanged from the Hosted
 * UI login path -- establishes a signed session and persists only a verified
 * phone number.
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
import { eq } from 'drizzle-orm';
import { Router, type RouteContext } from '../src/server/router.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, registerAuthRoutes } from '../src/auth/routes.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { CognitoConfig } from '../src/auth/cognito.js';
import type { PgConnection } from '../src/db/client.js';
import { verifySession } from '../src/auth/session.js';
import { users } from '../src/db/schema.js';
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
const SUB = 'cognito-sub-sms-otp';
const SESSION_SECRET = 'test-session-secret-placeholder';

async function makeKeys(): Promise<{ privateKey: KeyLike; jwks: JWTVerifyGetKey }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [publicJwk] }) };
}

async function signSmsOtpIdToken(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT({ token_use: 'id', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(config.issuer)
    .setAudience(config.clientId)
    .setSubject(SUB)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
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
  if (Array.isArray(raw)) {
    return raw;
  }
  return typeof raw === 'string' ? [raw] : [];
}

function cookieValue(setCookieHeaders: string[], name: string): string | undefined {
  const match = setCookieHeaders.find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) {
    return undefined;
  }
  const pair = match.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice(name.length + 1));
}

interface CallbackResult {
  res: CapturingResponse;
  phone: string | null;
  userId: string | undefined;
}

/**
 * Drives GET /auth/callback with a mocked token exchange and a JWKS that
 * matches the signing key, then reads back the persisted user row. Cognito's
 * token endpoint is stubbed via a temporary global fetch override, restored in
 * a finally block so it never leaks across tests.
 */
async function driveCallback(claims: Record<string, unknown>): Promise<CallbackResult> {
  const { privateKey, jwks } = await makeKeys();
  const idToken = await signSmsOtpIdToken(privateKey, claims);
  const { db, client } = await createTestDatabase();
  const runtime: AuthRuntime = {
    cognito: config,
    sessionSecret: SESSION_SECRET,
    // The callback only reads connection.db; the pool is never touched here.
    connection: { db, pool: undefined } as unknown as PgConnection,
    jwksFor: () => jwks,
  };

  const router = new Router();
  registerAuthRoutes(router, runtime);
  const matched = router.match('GET', '/auth/callback');
  assert.ok(matched, 'callback route is registered');

  const req = { headers: { cookie: `rs_oauth_state=${STATE}` } } as unknown as IncomingMessage;
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
  }

  try {
    const rows = await db.select().from(users).where(eq(users.cognitoSub, SUB));
    return { res, phone: rows[0]?.phone ?? null, userId: rows[0]?.id };
  } finally {
    await client.close();
  }
}

test('SMS OTP callback establishes a signed session and persists the verified phone', async () => {
  const { res, phone, userId } = await driveCallback({
    phone_number: '+15555550100',
    phone_number_verified: true,
  });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/');

  const sessionToken = cookieValue(setCookies(res), SESSION_COOKIE);
  assert.ok(sessionToken, 'a session cookie is set');
  const session = verifySession(sessionToken, SESSION_SECRET, SESSION_MAX_AGE_SECONDS);
  assert.ok(session, 'the session cookie verifies');
  assert.equal(session.sub, SUB);
  assert.equal(session.userId, userId);

  assert.equal(phone, '+15555550100');
});

test('SMS OTP callback does not persist an unverified phone number', async () => {
  const { res, phone } = await driveCallback({
    phone_number: '+15555550199',
    phone_number_verified: false,
  });

  assert.equal(res.statusCode, 302);
  assert.equal(phone, null);
});
