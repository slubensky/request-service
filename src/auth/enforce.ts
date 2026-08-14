/**
 * Request-time authorization enforcement (see SDD.md §7).
 *
 * This is the single seam every route uses to reach the pure `authorize` core.
 * It resolves the principal from stored rows scoped to the authenticated user
 * id -- the platform_role always, and the SiteRole only when the action targets
 * a site -- then delegates the decision to `authorize`. Routes never branch on
 * role themselves; adding a capability or role changes only the matrix in
 * authorize.ts, never this function.
 */
import type { AppDatabase } from '../db/client.js';
import { getPlatformRole, resolveSiteRole } from '../db/access.js';
import { authorize, type Action, type AuthorizationDecision } from './authorize.js';

/** The target site of an action, or null for a site-less platform action. */
function actionSiteId(action: Action): string | null {
  return 'siteId' in action ? action.siteId : null;
}

/**
 * Resolves the authenticated user's authority and decides the action. The
 * SiteRole is read only when the action names a site; a platform-only action
 * (e.g. create_site) is decided from platform_role alone. Fails closed via the
 * matrix's deny-by-default behavior when no authority is found.
 */
export async function authorizeAction(
  db: AppDatabase,
  userId: string,
  action: Action,
): Promise<AuthorizationDecision> {
  const siteId = actionSiteId(action);
  const platformRole = await getPlatformRole(db, userId);
  const siteRole = siteId === null ? null : await resolveSiteRole(db, userId, siteId);
  return authorize({ platformRole, siteRole }, action);
}
