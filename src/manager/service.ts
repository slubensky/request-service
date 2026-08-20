/**
 * Site Manager membership data operations (see SDD.md §11.4).
 *
 * Generalizes Company Admin's `inviteInitialManager` (src/admin/service.ts) so an
 * authorized Site Manager can invite additional members -- another manager or an
 * authorized user -- to their own site, and (Phase 6) manage their authorized
 * users (change limit, delete). These functions perform the writes/reads only;
 * they make no authorization decision themselves. Every caller (manager routes)
 * must first clear `authorizeAction` (the deny-by-default matrix, §7) so that
 * remains the single gate. No SMS is sent here -- an invite is a DB record only
 * (mocked delivery); OTP/SMS delivery is a separate task.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { siteRoles, sites, type SiteRoleRow, type SiteRow } from '../db/schema.js';
import { SiteNotFoundError, SiteRoleNotFoundError, type InviteOutcome } from '../admin/service.js';

export { SiteRoleNotFoundError, type InviteOutcome };

/** The two roles a Site Manager may invite a new member as. */
export type InvitableRole = Extract<SiteRoleRow['role'], 'manager' | 'authorized_user'>;

export interface ManagedSite {
  site: SiteRow;
  /** Every non-revoked SiteRole at this site (managers + authorized users, pending or
   * accepted), oldest first -- the console's membership list (SDD §11.4). */
  members: SiteRoleRow[];
}

/** Raised when a manager-only membership action targets a role that is not an authorized
 * user at the site (e.g. trying to delete a co-manager -- that is a Company Admin revoke). */
export class RoleNotManageableError extends Error {
  constructor() {
    super('Only an authorized user at this site can be managed here');
    this.name = 'RoleNotManageableError';
  }
}

/**
 * Lists every Site where `userId` holds an authorized `role=manager` SiteRole,
 * each with its members. Scoped to the caller's own id throughout -- never a
 * client-supplied site list -- so a non-manager session simply sees no sites
 * rather than another manager's data.
 */
export async function listManagedSites(db: AppDatabase, userId: string): Promise<ManagedSite[]> {
  const managedRoles = await db
    .select({ siteId: siteRoles.siteId })
    .from(siteRoles)
    .where(
      and(
        eq(siteRoles.userId, userId),
        eq(siteRoles.role, 'manager'),
        eq(siteRoles.status, 'authorized'),
      ),
    );

  const result: ManagedSite[] = [];
  for (const { siteId } of managedRoles) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) {
      continue;
    }
    const members = await db
      .select()
      .from(siteRoles)
      .where(and(eq(siteRoles.siteId, siteId), ne(siteRoles.status, 'revoked')))
      .orderBy(siteRoles.createdAt);
    result.push({ site, members });
  }
  return result;
}

/**
 * Invites a user by phone to `siteId` as `role`, creating a pending SiteRole
 * (`user_id=null`; the invite bridge, SDD §3.3, links + activates it when the
 * invitee first authenticates). Confers no authority until then.
 *
 * `maxAuthorizationCents` is stored on the pending row (SDD §7): a positive
 * amount for an `authorized_user` (their self-authorization limit), `null` for a
 * `manager` (unlimited). The caller validates the amount.
 *
 * Idempotent and reported as such (SDD §11.4): if any **non-revoked** SiteRole
 * (pending *or* accepted -- an accepted row keeps its `invited_phone`) already
 * exists for this phone at the site, no row is inserted and the existing role is
 * returned with `created: false`. Throws when the Site does not exist.
 */
export async function inviteSiteMember(
  db: AppDatabase,
  siteId: string,
  role: InvitableRole,
  invitedPhone: string,
  maxAuthorizationCents: number | null,
): Promise<InviteOutcome> {
  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) {
    throw new SiteNotFoundError();
  }

  const [existing] = await db
    .select()
    .from(siteRoles)
    .where(
      and(
        eq(siteRoles.siteId, siteId),
        eq(siteRoles.invitedPhone, invitedPhone),
        ne(siteRoles.status, 'revoked'),
      ),
    )
    .limit(1);
  if (existing) {
    return { created: false, role: existing };
  }

  const [row] = await db
    .insert(siteRoles)
    .values({
      siteId,
      invitedPhone,
      role,
      status: 'pending',
      maxAuthorizationCents: role === 'manager' ? null : maxAuthorizationCents,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create site member invite');
  }
  return { created: true, role: row };
}

/** Loads a SiteRole scoped to its site and requires it to be an authorized user -- the shared
 * guard for the two manager-only membership mutations below. */
async function loadManageableAuthorizedUser(
  db: AppDatabase,
  siteId: string,
  roleId: string,
): Promise<SiteRoleRow> {
  const [role] = await db.select().from(siteRoles).where(eq(siteRoles.id, roleId)).limit(1);
  if (!role || role.siteId !== siteId) {
    throw new SiteRoleNotFoundError();
  }
  if (role.role !== 'authorized_user') {
    throw new RoleNotManageableError();
  }
  return role;
}

/** Changes an authorized user's authorization limit (SDD §11.4). Amount validated `> 0` by
 * the caller. Rejects a target that is not an authorized user at `siteId`. */
export async function setAuthorizedUserLimit(
  db: AppDatabase,
  siteId: string,
  roleId: string,
  maxAuthorizationCents: number,
): Promise<SiteRoleRow> {
  await loadManageableAuthorizedUser(db, siteId, roleId);
  const [row] = await db
    .update(siteRoles)
    .set({ maxAuthorizationCents })
    .where(eq(siteRoles.id, roleId))
    .returning();
  if (!row) {
    throw new SiteRoleNotFoundError();
  }
  return row;
}

/** Deletes an authorized user, removing their SiteRole row (SDD §11.4). FK-safe: cleaning
 * requests / approvals reference `users`, not `site_roles`; demo invite codes cascade.
 * Works whether the invite is still pending or already accepted; rejects a non-authorized-user
 * target (a manager is revoked by a Company Admin, §11.1). */
export async function deleteAuthorizedUser(
  db: AppDatabase,
  siteId: string,
  roleId: string,
): Promise<void> {
  await loadManageableAuthorizedUser(db, siteId, roleId);
  await db.delete(siteRoles).where(eq(siteRoles.id, roleId));
}
