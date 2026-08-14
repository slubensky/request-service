/**
 * Integration test for the passkey (WebAuthn) enrollment entry point
 * (GET /auth/passkey/register, SDD §6.2 / §11.5). Cognito is fully mocked: no
 * token endpoint or JWKS is touched here because enrollment only mints state and
 * redirects to managed login. The suite proves the route (a) fails closed for an
 * anonymous caller, (b) fails closed when Cognito is unconfigured, and (c) for an
 * already-authenticated session redirects to the Hosted UI authorize endpoint
 * with the `openid` scope and a single-use `state` bound to the `rs_oauth_state`
 * cookie the factor-shared callback validates. It runs in CI with no external
 * credentials and no live WebAuthn ceremony.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router, type RouteContext } from '../src/server/router.js';
import { registerAuthRoutes } from '../src/auth/routes.js';
import type { AuthRuntime } from '../src/auth/config.js';
import type { CognitoConfig } from '../src/auth/cognito.js';
import { signSession } from '../src/auth/session.js';

const config: CognitoConfig = {
  domain: 'https://example.auth.us-east-1.amazoncognito.com',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-placeholder',
  redirectUri: 'https://app.example.com/auth/callback',
  logoutRedirectUri: 'https://app.example.com/',
};

const SESSION_SECRET = 'test-session-secret-placeholder';
const SESSION_COOKIE = 'rs_session';
const STATE_COOKIE = 'rs_oauth_state';

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

/** Drives GET /auth/passkey/register with the given runtime and cookie header. */
async function driveRegister(
  runtime: AuthRuntime,
  cookie: string | undefined,
): Promise<CapturingResponse> {
  const router = new Router();
  registerAuthRoutes(router, runtime);
  const matched = router.match('GET', '/auth/passkey/register');
  assert.ok(matched, 'passkey register route is registered');

  const req = { headers: cookie ? { cookie } : {} } as unknown as IncomingMessage;
  const res = new CapturingResponse();
  const ctx: RouteContext = {
    req,
    res: res as unknown as ServerResponse,
    params: {},
    query: {},
  };
  await matched.handler(ctx);
  return res;
}

function authenticatedRuntime(): AuthRuntime {
  return {
    cognito: config,
    sessionSecret: SESSION_SECRET,
    connection: null,
    jwksFor: () => {
      throw new Error('jwks must not be resolved during enrollment initiation');
    },
  };
}

function sessionCookie(): string {
  const token = signSession({ userId: 'user-1', sub: 'cognito-sub-1' }, SESSION_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

test('passkey enrollment redirects an authenticated session to Cognito with a bound state', async () => {
  const res = await driveRegister(authenticatedRuntime(), sessionCookie());

  assert.equal(res.statusCode, 302);
  const location = res.headers.Location;
  assert.ok(typeof location === 'string', 'a redirect Location is set');

  const url = new URL(location);
  assert.equal(url.origin + url.pathname, `${config.domain}/oauth2/authorize`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  // Passkeys bind to identity, not a phone: the phone scope is not requested.
  assert.equal(url.searchParams.get('scope'), 'openid');

  const cookies = setCookies(res);
  const stateCookie = cookieValue(cookies, STATE_COOKIE);
  assert.ok(stateCookie, 'a single-use oauth state cookie is set');
  // The redirect state must match the cookie the shared callback validates.
  assert.equal(url.searchParams.get('state'), stateCookie);

  const attributes = cookieAttributes(cookies, STATE_COOKIE) ?? '';
  assert.match(attributes, /HttpOnly/i, 'state cookie is HttpOnly');
  assert.match(attributes, /SameSite=Lax/i, 'state cookie is SameSite=Lax');
});

test('passkey enrollment fails closed (401) without an authenticated session', async () => {
  const res = await driveRegister(authenticatedRuntime(), undefined);

  assert.equal(res.statusCode, 401);
  assert.equal(res.headers.Location, undefined, 'no redirect is issued');
  assert.equal(setCookies(res).length, 0, 'no state cookie is minted for an anonymous caller');
});

test('passkey enrollment rejects a tampered session cookie', async () => {
  const res = await driveRegister(authenticatedRuntime(), `${SESSION_COOKIE}=not-a-valid-token`);

  assert.equal(res.statusCode, 401);
  assert.equal(setCookies(res).length, 0, 'no state cookie is minted for an invalid session');
});

test('passkey enrollment fails closed (503) when Cognito is unconfigured', async () => {
  const runtime: AuthRuntime = {
    cognito: null,
    sessionSecret: SESSION_SECRET,
    connection: null,
    jwksFor: () => {
      throw new Error('unused');
    },
  };
  const res = await driveRegister(runtime, sessionCookie());

  assert.equal(res.statusCode, 503);
  assert.equal(res.headers.Location, undefined, 'no redirect is issued when unconfigured');
});
