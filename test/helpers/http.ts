/**
 * Shared HTTP-test-server helpers, extracted from 8 near-identical copies
 * across the integration test suite (admin-authorized-users,
 * admin-console-routes, admin-payments, admin-qr-scheme, approvals,
 * csrf-enforcement, manager-console-routes, public-authorize). All drive
 * real requests against createHttpServer (src/server/app.ts) over PGlite
 * (./pglite.ts).
 */
import type { AddressInfo } from 'node:net';
import type { AuthRuntime } from '../../src/auth/config.js';
import type { PgConnection } from '../../src/db/client.js';
import { createHttpServer } from '../../src/server/app.js';
import { csrfTokenForSession } from '../../src/auth/csrf.js';
import { signSession } from '../../src/auth/session.js';
import type { SmsGateway } from '../../src/sms/gateway.js';
import type { TestDatabase } from './pglite.js';

export const SESSION_SECRET = 'test-session-secret-placeholder';

export function runtimeFor(db: TestDatabase['db']): AuthRuntime {
  return {
    cognito: null,
    sessionSecret: SESSION_SECRET,
    connection: { db, pool: undefined } as unknown as PgConnection,
    jwksFor: () => {
      throw new Error('jwks must not be resolved by these routes');
    },
  };
}

/** `nowSeconds` lets a test mint a session that is already stale for the step-up
 * recency check (SDD §6.4) while still being a validly-signed, unexpired session. */
export function sessionAndCsrf(
  userId: string,
  nowSeconds?: number,
): { cookie: string; csrf: string } {
  const token = signSession({ userId, sub: `sub-${userId}` }, SESSION_SECRET, nowSeconds);
  return { cookie: token, csrf: csrfTokenForSession(token, SESSION_SECRET) };
}

export async function withRunningServer<T>(
  runtime: AuthRuntime,
  fn: (baseUrl: string) => Promise<T>,
  smsGateway?: SmsGateway,
): Promise<T> {
  delete process.env.TLS_CERT_FILE;
  delete process.env.TLS_KEY_FILE;
  const server = createHttpServer(runtime, smsGateway);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
