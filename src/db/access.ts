/**
 * Data access for identity and authority resolution.
 *
 * These are the only functions that bridge stored rows to the pure
 * authorization core (authorize.ts): the server resolves the authenticated
 * user's SiteRole for a target site, then passes it to `authorize`. All queries
 * are parameterized through Drizzle and scoped by the authenticated user id and
 * the target site id -- never by a client-supplied role claim.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PlatformRole, Principal, ResolvedSiteRole } from '../auth/authorize.js';
import type { AppDatabase } from './client.js';
import { siteRoles, users, type SiteRoleRow, type UserRow } from './schema.js';

// The exact transaction-bound handle `db.transaction()` hands its callback --
// derived structurally so it always matches the installed drizzle-orm version
// rather than being hand-maintained against `PgTransaction`'s generics.
type SiteRoleTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

// Postgres SQLSTATE for a unique-constraint violation. `site_roles_site_user_key`
// (site_id, user_id) is the constraint the bridge must never surface as a 500 (§3.3).
const UNIQUE_VIOLATION = '23505';

/** Postgres unique-violation detector, shared by every "conditional write + defensive
 * catch" idiom in this codebase (the §3.3 invite bridge below, and the duplicate-active-
 * request guard in src/payments/service.ts, SDD §9.4). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

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

/**
 * The invite bridge (SDD §3.3): links pending SiteRoles to a freshly
 * authenticated identity by the token's **verified** phone number. Called from
 * the Cognito callback after the User is resolved.
 *
 * Only not-yet-linked pending invites for `verifiedPhone` are touched
 * (`invited_phone` equal, `user_id IS NULL`, `status=pending`) -- so the write
 * is idempotent: a repeat authentication re-matches nothing already linked.
 * Outcome is role-specific, mirroring the resolution table (§3.2):
 *   - `manager` is activated (`status → authorized`) so the Site becomes
 *     operable per §11.1 -- the invitee is now an active Manager.
 *   - `assistant` is only linked (`status` stays `pending`); it confers no
 *     authority until a manager promotes it (§9/§10). Auto-authorizing here
 *     would be self-elevation.
 *
 * Grants no authority itself: every request still re-derives authority from the
 * SiteRole matrix (authorize.ts), which denies any non-`authorized` role. A
 * null/absent verified phone, or one matching no pending invite, links nothing.
 *
 * Resilient to duplicate pending invites (SDD §3.3, "Resilient bridge
 * contract"): matches are grouped by site, and at most one is activated/linked
 * per site -- the unique `(site_id, user_id)` index allows nothing else. When
 * more than one pending invite matches the same phone at a site, the
 * earliest-created is the winner and the rest are superseded (`status=
 * revoked`), never left dangling `pending` or written with a colliding
 * `user_id`. If `userId` already holds a role at a matching site, that site's
 * matches are all superseded and nothing is written to the existing role
 * (graceful no-op). A residual unique-violation race during activation is
 * caught rather than left to surface as an unhandled 500.
 */
export async function bridgePendingSiteRoles(
  db: AppDatabase,
  userId: string,
  verifiedPhone: string | null,
): Promise<SiteRoleRow[]> {
  if (!verifiedPhone) {
    return [];
  }

  // All not-yet-linked pending invites for this phone, across both roles --
  // ordered so the grouping below picks a stable winner per site regardless of
  // how many duplicates exist or which role each one is.
  const pending = await db
    .select()
    .from(siteRoles)
    .where(
      and(
        eq(siteRoles.invitedPhone, verifiedPhone),
        isNull(siteRoles.userId),
        eq(siteRoles.status, 'pending'),
      ),
    )
    .orderBy(asc(siteRoles.createdAt), asc(siteRoles.id));

  if (pending.length === 0) {
    return [];
  }

  // The unique (site_id, user_id) index allows at most one role per user per
  // site, so every matching invite must collapse to a single winner per site --
  // grouping by role alone would miss a manager+assistant duplicate pair at the
  // same site (SDD §3.3, "Resilient bridge contract").
  const bySite = new Map<string, SiteRoleRow[]>();
  for (const row of pending) {
    const group = bySite.get(row.siteId);
    if (group) {
      group.push(row);
    } else {
      bySite.set(row.siteId, [row]);
    }
  }

  const bridged: SiteRoleRow[] = [];
  for (const group of bySite.values()) {
    const result = await bridgeSiteGroup(db, userId, group);
    if (result) {
      bridged.push(result);
    }
  }
  return bridged;
}

/**
 * Resolves one site's worth of matching pending invites for a single bridge
 * call: at most one is activated/linked for `userId`, and every other row in
 * the group is superseded (`status=revoked`) so it can never be redeemed
 * again. Runs in a transaction so the existing-role guard and the activating
 * write are atomic against a concurrent bridge call for the same site.
 */
async function bridgeSiteGroup(
  db: AppDatabase,
  userId: string,
  group: SiteRoleRow[],
): Promise<SiteRoleRow | null> {
  const siteId = group[0]?.siteId;
  if (!siteId) {
    return null;
  }

  return db.transaction(async (tx) => {
    // Guard: the user may already hold a role at this site (granted directly,
    // or linked by an earlier bridge call). Superseding leftover pending
    // duplicates is always safe; writing a second role for the same user at
    // the site is not -- no-op gracefully instead of colliding.
    const [existingRole] = await tx
      .select({ id: siteRoles.id })
      .from(siteRoles)
      .where(and(eq(siteRoles.siteId, siteId), eq(siteRoles.userId, userId)))
      .limit(1);
    if (existingRole) {
      await supersedeDuplicates(
        tx,
        group.map((row) => row.id),
      );
      return null;
    }

    // `group` is ordered created_at/id ascending, so the head is the
    // deterministic winner (earliest invite) and the rest are duplicates.
    const [winner, ...duplicates] = group;
    if (!winner) {
      return null;
    }
    const activated = await activateWinner(tx, userId, winner);
    await supersedeDuplicates(
      tx,
      duplicates.map((row) => row.id),
    );
    return activated;
  });
}

/**
 * Activates (`manager`) or links (`assistant`) the single winning pending
 * invite for `userId`, mirroring the role-specific outcome in SDD §3.3. The
 * conditional `WHERE` makes the write a no-op -- not a conflict -- if another
 * call already claimed this exact row; a unique-violation from any residual
 * race is caught defensively rather than left to surface as a 500.
 */
async function activateWinner(
  tx: SiteRoleTx,
  userId: string,
  winner: SiteRoleRow,
): Promise<SiteRoleRow | null> {
  const nextStatus = winner.role === 'manager' ? ('authorized' as const) : ('pending' as const);
  try {
    const [row] = await tx
      .update(siteRoles)
      .set({ userId, status: nextStatus })
      .where(
        and(eq(siteRoles.id, winner.id), isNull(siteRoles.userId), eq(siteRoles.status, 'pending')),
      )
      .returning();
    return row ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another concurrent bridge call already holds this site for this user;
      // treat this call as a no-op rather than an unhandled error.
      return null;
    }
    throw error;
  }
}

/**
 * Marks duplicate pending invites `revoked` (superseded) so they are left
 * neither dangling `pending` nor pointed at a colliding `user_id`. Scoped to
 * still-pending, still-unlinked rows so it is idempotent and never re-revokes
 * or overwrites a row another path has since touched.
 */
async function supersedeDuplicates(tx: SiteRoleTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await tx
    .update(siteRoles)
    .set({ status: 'revoked' })
    .where(
      and(
        inArray(siteRoles.id, [...ids]),
        isNull(siteRoles.userId),
        eq(siteRoles.status, 'pending'),
      ),
    );
}
