/**
 * Shared HTTP-layer authorization gate (see SDD.md §7).
 *
 * Every state-changing console route (Company Admin, Site Manager) funnels
 * through this single seam to reach `authorizeAction`: resolve the session,
 * ensure the DB is configured, then authorize via the deny-by-default matrix
 * -- all BEFORE any handler runs or any request body is parsed. No route
 * module defines its own copy of this gate or branches on role directly.
 */
import type { AuthRuntime } from './config.js';
import type { AppDatabase } from '../db/client.js';
import type { RouteContext } from '../server/router.js';
import type { Action } from './authorize.js';
import { readSession } from './guard.js';
import { authorizeAction } from './enforce.js';
import { sendText } from '../server/respond.js';

/**
 * Resolves the authenticated user id + db on success, or writes the
 * appropriate 401/403/503 and returns null.
 */
export async function authorizeOrReject(
  runtime: AuthRuntime,
  { req, res }: RouteContext,
  action: Action,
): Promise<{ db: AppDatabase; userId: string } | null> {
  const session = readSession(req, runtime);
  if (!session) {
    sendText(res, 401, 'Authentication required');
    return null;
  }
  const db = runtime.connection?.db;
  if (!db) {
    sendText(res, 503, 'This action is not configured');
    return null;
  }
  const decision = await authorizeAction(db, session.userId, action);
  if (!decision.allowed) {
    sendText(res, 403, 'Forbidden');
    return null;
  }
  return { db, userId: session.userId };
}
