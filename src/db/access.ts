/**
 * Data access for identity and authority resolution.
 *
 * These are the only functions that bridge stored rows to the pure
 * authorization core (authorize.ts): the server resolves the authenticated
 * user's SiteRole for a target site, then passes it to `authorize`. All queries
 * are parameterized through Drizzle and scoped by the authenticated user id and
 * the target site id -- never by a client-supplied role claim.
 */
import { and, eq } from 'drizzle-orm';
import type { PlatformRole, Principal, ResolvedSiteRole } from '../auth/authorize.js';
import type { AppDatabase } from './client.js';
import { siteRoles, users, type UserRow } from './schema.js';

/**
 * Resolves the authenticated user's authority at a site, or null when they
 * hold no role there (a customer -- deny by default). The query is scoped to
 * both the user id (from the verified session) and the site id.
 */
export async function resolveSiteRole(
  db: AppDatabase,
  userId: string,
  siteId: string,
): Promise<ResolvedSiteRole | null> {
  const rows = await db
    .select({
      siteId: siteRoles.siteId,
      role: siteRoles.role,
      status: siteRoles.status,
      maxAuthorizationCents: siteRoles.maxAuthorizationCents,
      bathroomScope: siteRoles.bathroomScope,
    })
    .from(siteRoles)
    .where(and(eq(siteRoles.userId, userId), eq(siteRoles.siteId, siteId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    siteId: row.siteId,
    role: row.role,
    status: row.status,
    maxAuthorizationCents: row.maxAuthorizationCents,
    bathroomScope: row.bathroomScope ?? null,
  };
}

/**
 * Reads the user's platform_role. Defaults to `member` (least authority) when
 * the row is absent, so a missing user can never resolve as a company_admin.
 */
export async function getPlatformRole(db: AppDatabase, userId: string): Promise<PlatformRole> {
  const rows = await db
    .select({ platformRole: users.platformRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.platformRole ?? 'member';
}

/**
 * Resolves the full authorization principal for a request: the platform_role
 * (cross-site company_admin authority) and the SiteRole for the target site.
 * Both are read from stored rows scoped to the authenticated user id -- never
 * from a client claim -- then passed to the pure `authorize` core.
 */
export async function resolvePrincipal(
  db: AppDatabase,
  userId: string,
  siteId: string,
): Promise<Principal> {
  const [platformRole, siteRole] = await Promise.all([
    getPlatformRole(db, userId),
    resolveSiteRole(db, userId, siteId),
  ]);
  return { platformRole, siteRole };
}

/**
 * Maps a verified Cognito subject to a User row, creating one on first login.
 * Identity only -- creating the row grants no authority (see SDD §3). `phone`
 * is stored when Cognito supplies a verified value, so a manager's pending
 * invite (keyed by phone) can later be linked to this identity.
 */
export async function findOrCreateUserByCognitoSub(
  db: AppDatabase,
  cognitoSub: string,
  phone: string | null,
): Promise<UserRow> {
  const existing = await db.select().from(users).where(eq(users.cognitoSub, cognitoSub)).limit(1);
  const found = existing[0];
  if (found) {
    return found;
  }

  const inserted = await db
    .insert(users)
    .values({ cognitoSub, phone })
    .onConflictDoUpdate({ target: users.cognitoSub, set: { cognitoSub } })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new Error('Failed to upsert user for Cognito subject');
  }
  return row;
}
