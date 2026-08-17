/**
 * Local-development-only bootstrap: mints a Company Admin session without a
 * real Cognito user pool.
 *
 * Company Admin is never obtained via self-service, a QR scan, or Cognito
 * login (SDD §3) -- it is provisioned internally, e.g. an ops action against
 * the database. This script IS that ops action for a laptop sandbox: it
 * finds-or-creates a `users` row with `platform_role=company_admin` and signs
 * a session cookie for it the same way the real Cognito callback does
 * (src/auth/session.ts), so you can reach GET /admin without deploying
 * Cognito. It is not part of the built server image and is never run in
 * production -- see README "Local development".
 *
 * Usage: npm run dev:login [label]
 */
import { eq } from 'drizzle-orm';
import { requireEnv } from '../src/config/env.js';
import { createPgConnection } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { signSession } from '../src/auth/session.js';

const label = process.argv[2] ?? 'local-admin';
const cognitoSub = `dev:${label}`;

const { db, pool } = createPgConnection(requireEnv('DATABASE_URL'));
const sessionSecret = requireEnv('SESSION_SECRET');

try {
  const existing = await db.select().from(users).where(eq(users.cognitoSub, cognitoSub)).limit(1);
  const user =
    existing[0] ??
    (await db.insert(users).values({ cognitoSub, platformRole: 'company_admin' }).returning())[0];
  if (!user) {
    throw new Error('Failed to find or create the dev Company Admin user');
  }
  if (user.platformRole !== 'company_admin') {
    throw new Error(
      `users.id=${user.id} (cognito_sub=${cognitoSub}) already exists with platform_role=${user.platformRole}; ` +
        'pick a different label or promote it manually.',
    );
  }

  const token = signSession({ userId: user.id, sub: cognitoSub }, sessionSecret);

  /* eslint-disable no-console -- this script's entire output is the deliverable (SDD-external dev tooling). */
  console.log(`Company Admin ready: users.id=${user.id} (cognito_sub=${cognitoSub})\n`);
  console.log('Open http://localhost:3000/admin, open devtools -> Console, and run:\n');
  console.log(`  document.cookie = "rs_session=${token}; path=/";\n`);
  console.log('...then reload the page. Or, from the command line:\n');
  console.log(`  curl -H 'Cookie: rs_session=${token}' http://localhost:3000/admin\n`);
  /* eslint-enable no-console */
} finally {
  await pool.end();
}
