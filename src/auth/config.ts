/**
 * Runtime assembly of authentication dependencies from the environment.
 *
 * Built once and shared by the auth routes and the CSRF guard. Everything is
 * sourced from env / Secrets Manager references; when a piece is absent the
 * corresponding capability fails closed (auth routes return 503) rather than
 * running in a partially-configured, insecure state.
 */
import type { JWTVerifyGetKey } from 'jose';
import { getEnv } from '../config/env.js';
import { createPgConnection, type PgConnection } from '../db/client.js';
import { loadCognitoConfig, remoteJwks, type CognitoConfig } from './cognito.js';

export interface AuthRuntime {
  cognito: CognitoConfig | null;
  sessionSecret: string | null;
  connection: PgConnection | null;
  /** JWKS resolver factory; overridable in tests. Defaults to the pool's remote JWKS. */
  jwksFor: (config: CognitoConfig) => JWTVerifyGetKey;
}

let cached: AuthRuntime | undefined;

/** Lazily builds (and caches) the auth runtime from the current environment. */
export function getAuthRuntime(): AuthRuntime {
  if (cached) {
    return cached;
  }
  const databaseUrl = getEnv('DATABASE_URL');
  cached = {
    cognito: loadCognitoConfig(),
    sessionSecret: getEnv('SESSION_SECRET') ?? null,
    connection: databaseUrl ? createPgConnection(databaseUrl) : null,
    jwksFor: remoteJwks,
  };
  return cached;
}
