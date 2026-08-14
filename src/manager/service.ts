/**
 * Site Manager invitation data operations (see SDD.md §11.4).
 *
 * Generalizes Company Admin's `inviteInitialManager` (src/admin/service.ts) so an
 * authorized Site Manager can invite additional members -- another manager or an
 * assistant -- to their own site. These functions perform the writes/reads only;
 * they make no authorization decision themselves. Every caller (manager routes)
 * must first clear `authorizeAction` (the deny-by-default matrix, §7) so that
 * remains the single gate. No SMS is sent here -- an invite is a DB record only
 * (mocked delivery); OTP/SMS delivery is a separate task.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { siteRoles, sites, type SiteRoleRow, type SiteRow } from '../db/schema.js';
import { SiteNotFoundError } from '../admin/service.js';

/** The two roles a Site Manager may invite a new member as. */
export type InvitableRole = Extract<SiteRoleRow['role'], 'manager' | 'assistant'>;

export interface ManagedSite {
  site: SiteRow;
  /** SiteRoles at this site not yet linked to an identity, newest first. */
  pendingInvites: SiteRoleRow[];
}

/**
 * Lists every Site where `userId` holds an authorized `role=manager` SiteRole,
 * each with its pending invites. Scoped to the caller's own id throughout --
 * never a client-supplied site list -- so a non-manager session simply sees no
 * sites rather than another manager's data.
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
    const pendingInvites = await db
      .select()
      .from(siteRoles)
      .where(and(eq(siteRoles.siteId, siteId), eq(siteRoles.status, 'pending')))
      .orderBy(siteRoles.createdAt);
    result.push({ site, pendingInvites });
  }
  return result;
}

/**
 * Invites a user by phone to `siteId` as `role`, creating a pending SiteRole
 * (`user_id=null`; the invite bridge, SDD §3.3, links it to an identity when the
 * invitee first authenticates). Confers no authority until then.
 *
 * Idempotent: a repeat invite for the same not-yet-linked phone at this site
 * returns the existing pending/authorized record instead of inserting a
 * duplicate row -- the `site_id`/`user_id` unique index cannot catch this on
 * its own because `user_id` is null for every pending invite. Throws when the
 * Site does not exist.
 */
export async function inviteSiteMember(
  db: AppDatabase,
  siteId: string,
  role: InvitableRole,
  invitedPhone: string,
): Promise<SiteRoleRow> {
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
        eq(siteRoles.role, role),
        isNull(siteRoles.userId),
        ne(siteRoles.status, 'revoked'),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(siteRoles)
    .values({ siteId, invitedPhone, role, status: 'pending' })
    .returning();
  if (!row) {
    throw new Error('Failed to create site member invite');
  }
  return row;
}
