import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  type CognitoConfig,
} from '../src/auth/cognito.js';

// Fixture config with obviously-fake placeholders -- no real credentials.
const config: CognitoConfig = {
  domain: 'https://example.auth.us-east-1.amazoncognito.com',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-placeholder',
  redirectUri: 'https://app.example.com/auth/callback',
  logoutRedirectUri: 'https://app.example.com/',
};

const KID = 'test-key-1';

interface KeyMaterial {
  privateKey: KeyLike;
  jwks: JWTVerifyGetKey;
}

async function makeKeys(): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [publicJwk] }) };
}

async function signIdToken(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(overrides.issuer ?? config.issuer)
    .setAudience(overrides.audience ?? config.clientId)
    .setSubject('cognito-sub-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

test('buildAuthorizeUrl includes the client, redirect, and state', () => {
  const url = new URL(buildAuthorizeUrl(config, 'state-xyz', 'nonce-abc'));
  assert.equal(url.origin + url.pathname, `${config.domain}/oauth2/authorize`);
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-xyz');
});

test('buildLogoutUrl targets the Hosted UI logout endpoint', () => {
  const url = new URL(buildLogoutUrl(config));
  assert.equal(url.origin + url.pathname, `${config.domain}/logout`);
  assert.equal(url.searchParams.get('logout_uri'), config.logoutRedirectUri);
});

test('verifyIdToken accepts a valid token and returns the identity', async () => {
  const { privateKey, jwks } = await makeKeys();
  const token = await signIdToken(privateKey, {
    token_use: 'id',
    phone_number: '+15555550100',
  });
  const identity = await verifyIdToken(token, config, jwks);
  assert.equal(identity.sub, 'cognito-sub-123');
  assert.equal(identity.phoneNumber, '+15555550100');
});

test('verifyIdToken rejects a wrong audience', async () => {
  const { privateKey, jwks } = await makeKeys();
  const token = await signIdToken(privateKey, { token_use: 'id' }, { audience: 'someone-else' });
  await assert.rejects(() => verifyIdToken(token, config, jwks));
});

test('verifyIdToken rejects a wrong issuer', async () => {
  const { privateKey, jwks } = await makeKeys();
  const token = await signIdToken(
    privateKey,
    { token_use: 'id' },
    { issuer: 'https://evil.example' },
  );
  await assert.rejects(() => verifyIdToken(token, config, jwks));
});

test('verifyIdToken rejects a non-id token_use', async () => {
  const { privateKey, jwks } = await makeKeys();
  const token = await signIdToken(privateKey, { token_use: 'access' });
  await assert.rejects(() => verifyIdToken(token, config, jwks));
});

test('verifyIdToken rejects a token signed by an unknown key', async () => {
  const signer = await makeKeys();
  const verifier = await makeKeys();
  const token = await signIdToken(signer.privateKey, { token_use: 'id' });
  await assert.rejects(() => verifyIdToken(token, config, verifier.jwks));
});

test('exchangeCodeForTokens posts the code and returns tokens', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const fakeFetch: typeof fetch = (input, init) => {
    capturedUrl = typeof input === 'string' ? input : '';
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve(
      new Response(JSON.stringify({ id_token: 'id.jwt', access_token: 'access.jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  const tokens = await exchangeCodeForTokens(config, 'auth-code-1', fakeFetch);
  assert.equal(tokens.idToken, 'id.jwt');
  assert.equal(tokens.accessToken, 'access.jwt');
  assert.equal(capturedUrl, `${config.domain}/oauth2/token`);
  assert.match(capturedBody, /grant_type=authorization_code/);
  assert.match(capturedBody, /code=auth-code-1/);
});

test('exchangeCodeForTokens throws on a non-ok response', async () => {
  const fakeFetch: typeof fetch = () => Promise.resolve(new Response('nope', { status: 400 }));
  await assert.rejects(() => exchangeCodeForTokens(config, 'bad-code', fakeFetch));
});
