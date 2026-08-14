/**
 * Amazon Cognito managed login (Hosted UI) wiring: authorize/logout URL
 * construction, authorization-code exchange, and ID-token verification.
 *
 * Cognito owns authentication; this module only (a) sends the user to the
 * Hosted UI, (b) exchanges the returned code for tokens, and (c) verifies the
 * ID token's issuer, audience, and signature via the pool's JWKS before we
 * trust any claim. A verified token proves identity only -- it confers no site
 * authority (see SDD §3, §6). All configuration comes from env / Secrets
 * Manager references; no secret is embedded here.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getEnv } from '../config/env.js';

export interface CognitoConfig {
  /** Hosted UI base, e.g. https://<domain>.auth.<region>.amazoncognito.com */
  domain: string;
  /** Token issuer, e.g. https://cognito-idp.<region>.amazonaws.com/<userPoolId> */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  logoutRedirectUri: string;
}

export interface CognitoIdentity {
  sub: string;
  phoneNumber: string | null;
  /**
   * Whether Cognito reports the phone number as verified. An SMS OTP sign-in
   * proves possession of the number, so the ID token carries
   * `phone_number_verified: true`; passkey-only sign-ins carry no verified
   * phone (see SDD §6).
   */
  phoneNumberVerified: boolean;
}

interface TokenResponse {
  idToken: string;
  accessToken: string;
}

/**
 * Loads Cognito config from the environment, or null when unconfigured so the
 * scaffold still runs locally without secrets (auth routes then fail closed
 * with 503 rather than half-configured behavior).
 */
export function loadCognitoConfig(): CognitoConfig | null {
  const domain = getEnv('COGNITO_DOMAIN');
  const issuer = getEnv('COGNITO_ISSUER');
  const clientId = getEnv('COGNITO_CLIENT_ID');
  const clientSecret = getEnv('COGNITO_CLIENT_SECRET');
  const redirectUri = getEnv('COGNITO_REDIRECT_URI');
  const logoutRedirectUri = getEnv('COGNITO_LOGOUT_REDIRECT_URI');
  if (!domain || !issuer || !clientId || !clientSecret || !redirectUri || !logoutRedirectUri) {
    return null;
  }
  return { domain, issuer, clientId, clientSecret, redirectUri, logoutRedirectUri };
}

/**
 * Builds the Hosted UI authorize URL. Cognito's managed login presents the
 * pool's allowed first-auth factors (SMS OTP + passkeys; see
 * infra/modules/cognito) so this single entry point drives passwordless
 * sign-in without the app choosing a factor. The `phone` scope is requested so
 * an SMS OTP sign-in returns the verified `phone_number` claim we persist as
 * contact identity. `state` and `nonce` are caller-generated, single-use.
 */
export function buildAuthorizeUrl(config: CognitoConfig, state: string, nonce: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid phone',
    state,
    nonce,
  });
  return `${config.domain}/oauth2/authorize?${params.toString()}`;
}

/** Builds the Hosted UI logout URL that clears the Cognito session and returns to the app. */
export function buildLogoutUrl(config: CognitoConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.logoutRedirectUri,
  });
  return `${config.domain}/logout?${params.toString()}`;
}

function isTokenResponse(value: unknown): value is { id_token: string; access_token: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id_token === 'string' && typeof record.access_token === 'string';
}

/**
 * Exchanges an authorization code for tokens at the Cognito token endpoint,
 * authenticating the confidential client with HTTP Basic (client id + secret).
 */
export async function exchangeCodeForTokens(
  config: CognitoConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
  });
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetchImpl(`${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Cognito token exchange failed: ${response.status}`);
  }
  const json: unknown = await response.json();
  if (!isTokenResponse(json)) {
    throw new Error('Cognito token response missing id_token/access_token');
  }
  return { idToken: json.id_token, accessToken: json.access_token };
}

/** Remote JWKS resolver for the pool. Cached per issuer inside jose. */
export function remoteJwks(config: CognitoConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`));
}

/**
 * Verifies a Cognito ID token: signature (via `keyResolver`), issuer, audience
 * (the client id), and `token_use=id`. Returns the identity, or throws on any
 * verification failure. Tests inject a local JWKS via `keyResolver`; production
 * passes `remoteJwks(config)`.
 */
export async function verifyIdToken(
  idToken: string,
  config: CognitoConfig,
  keyResolver: JWTVerifyGetKey,
): Promise<CognitoIdentity> {
  const { payload } = await jwtVerify(idToken, keyResolver, {
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (payload.token_use !== 'id') {
    throw new Error('Cognito token is not an ID token');
  }
  if (typeof payload.sub !== 'string') {
    throw new Error('Cognito ID token missing sub');
  }
  const phoneNumber = typeof payload.phone_number === 'string' ? payload.phone_number : null;
  return {
    sub: payload.sub,
    phoneNumber,
    phoneNumberVerified: isVerifiedClaim(payload.phone_number_verified),
  };
}

/**
 * Cognito emits `phone_number_verified` as a JSON boolean, but some token
 * shapes stringify it. Treat only an explicit true / "true" as verified;
 * anything else fails closed to unverified.
 */
function isVerifiedClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * The identity's phone number, but only when Cognito reports it verified. An
 * SMS OTP sign-in verifies phone possession, so a verified number is safe to
 * persist as contact identity and to match against phone-keyed pending invites
 * (SDD §4). An unverified value is discarded (returns null) so we never trust
 * an unproven phone; passkey-only sign-ins likewise yield null here, keeping
 * that path additive.
 */
export function verifiedPhoneNumber(identity: CognitoIdentity): string | null {
  return identity.phoneNumberVerified ? identity.phoneNumber : null;
}
