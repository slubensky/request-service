/**
 * Company-Admin onboarding data operations (see SDD.md §11.1).
 *
 * These functions perform the onboarding writes only -- creating a Site,
 * Bathrooms, QRTokens, and the initial pending Manager SiteRole. They do NOT
 * make authorization decisions: every caller (admin routes) must first clear
 * `authorizeAction` so the deny-by-default matrix (§7) is the single gate.
 * All queries are parameterized through Drizzle; nothing is built from raw SQL.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import {
  bathrooms,
  qrTokens,
  siteRoles,
  sites,
  type BathroomRow,
  type SiteRow,
  type SiteRoleRow,
} from '../db/schema.js';
import { generateOpaqueToken, hashToken } from '../qr/tokens.js';

export interface CreateSiteInput {
  name: string;
  address: string;
  timezone: string;
  currency: string;
  fixedPriceCents: number;
  terms?: string;
}

/** Creates a Site with its fixed price (in cents). */
export async function createSite(db: AppDatabase, input: CreateSiteInput): Promise<SiteRow> {
  const [row] = await db
    .insert(sites)
    .values({
      name: input.name,
      address: input.address,
      timezone: input.timezone,
      currency: input.currency,
      fixedPriceCents: input.fixedPriceCents,
      terms: input.terms ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create site');
  }
  return row;
}

/** Adds a Bathroom to an existing Site, or throws when the Site does not exist. */
export async function addBathroom(
  db: AppDatabase,
  siteId: string,
  label: string,
): Promise<BathroomRow> {
  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) {
    throw new SiteNotFoundError();
  }
  const [row] = await db.insert(bathrooms).values({ siteId, label }).returning();
  if (!row) {
    throw new Error('Failed to create bathroom');
  }
  return row;
}

export interface IssuedQrToken {
  /** The raw token, available only at issuance time; never persisted. */
  rawToken: string;
  tokenId: string;
}

/**
 * Issues a fresh opaque QRToken for a Bathroom, revoking any prior active token
 * so tags are revocable/replaceable (§5). The Bathroom must belong to `siteId`,
 * guarding against a mismatched-id cross-site issuance. Only the token hash is
 * stored; the raw token is returned once so the caller can render the QR image.
 */
export async function issueQrToken(
  db: AppDatabase,
  siteId: string,
  bathroomId: string,
): Promise<IssuedQrToken> {
  const [bathroom] = await db
    .select({ id: bathrooms.id })
    .from(bathrooms)
    .where(and(eq(bathrooms.id, bathroomId), eq(bathrooms.siteId, siteId)))
    .limit(1);
  if (!bathroom) {
    throw new BathroomNotFoundError();
  }

  await db
    .update(qrTokens)
    .set({ status: 'revoked' })
    .where(and(eq(qrTokens.bathroomId, bathroomId), eq(qrTokens.status, 'active')));

  const rawToken = generateOpaqueToken();
  const [row] = await db
    .insert(qrTokens)
    .values({ bathroomId, tokenHash: hashToken(rawToken) })
    .returning({ id: qrTokens.id });
  if (!row) {
    throw new Error('Failed to issue QR token');
  }
  return { rawToken, tokenId: row.id };
}

/** Outcome of an invite: `created` distinguishes a fresh invite from an idempotent
 * "already a member" no-op, so the console can show a distinct message (SDD §11.1, §11.4).
 * Defined here (the base service module) so `manager/service.ts` can share it without a
 * circular import. */
export interface InviteOutcome {
  created: boolean;
  role: SiteRoleRow;
}

/**
 * Invites the initial Site Manager by phone, creating a pending `role=manager`
 * SiteRole with a null `user_id` (and `null` limit -- a manager is unlimited,
 * SDD §7); the invite bridge (§3.3) links + activates it when the invitee first
 * authenticates. Confers no authority until then. Throws when the Site does not
 * exist.
 *
 * Idempotent and reported as such (SDD §11.1, §11.4): if any **non-revoked**
 * SiteRole (pending *or* accepted) already exists for this phone at the site, no
 * row is inserted and the existing role is returned with `created: false`.
 */
export async function inviteInitialManager(
  db: AppDatabase,
  siteId: string,
  invitedPhone: string,
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
      role: 'manager',
      status: 'pending',
      maxAuthorizationCents: null,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create manager invite');
  }
  return { created: true, role: row };
}

export interface SiteWithBathrooms {
  site: SiteRow;
  bathrooms: BathroomRow[];
  /** Every non-revoked SiteRole at this site (managers + authorized users, pending or
   * accepted), oldest first -- the Company-Admin console's per-site membership list, with
   * revoke (both roles) and set-limit (authorized users) controls (SDD §11.1, §11.3). */
  members: SiteRoleRow[];
}

/** Lists every Site with its Bathrooms and members for the Company-Admin console. */
export async function listSitesWithBathrooms(db: AppDatabase): Promise<SiteWithBathrooms[]> {
  const siteRows = await db.select().from(sites).orderBy(sites.createdAt);
  const result: SiteWithBathrooms[] = [];
  for (const site of siteRows) {
    const bathroomRows = await db
      .select()
      .from(bathrooms)
      .where(eq(bathrooms.siteId, site.id))
      .orderBy(bathrooms.createdAt);
    const members = await db
      .select()
      .from(siteRoles)
      .where(and(eq(siteRoles.siteId, site.id), ne(siteRoles.status, 'revoked')))
      .orderBy(siteRoles.createdAt);
    result.push({ site, bathrooms: bathroomRows, members });
  }
  return result;
}

/**
 * Revokes a SiteRole at `siteId`, setting `status=revoked` (SDD §11.1, §7). Used by the
 * Company Admin to revoke a Manager. The target's `site_id` is verified against `siteId`
 * (the caller re-derives it here rather than trusting the client). A revoked role confers
 * no authority and cannot be redeemed by the bridge again (§3.3). Throws when the role does
 * not exist at the site.
 */
export async function revokeSiteRole(
  db: AppDatabase,
  siteId: string,
  roleId: string,
): Promise<SiteRoleRow> {
  const [role] = await db.select().from(siteRoles).where(eq(siteRoles.id, roleId)).limit(1);
  if (!role || role.siteId !== siteId) {
    throw new SiteRoleNotFoundError();
  }
  const [row] = await db
    .update(siteRoles)
    .set({ status: 'revoked' })
    .where(eq(siteRoles.id, roleId))
    .returning();
  if (!row) {
    throw new SiteRoleNotFoundError();
  }
  return row;
}

/** Raised when an onboarding action names a Site that does not exist. */
export class SiteNotFoundError extends Error {
  constructor() {
    super('Site not found');
    this.name = 'SiteNotFoundError';
  }
}

/** Raised when a role-management action names a SiteRole not found at the target site.
 * Defined here (base module) so manager/service.ts can share it without a circular import. */
export class SiteRoleNotFoundError extends Error {
  constructor() {
    super('Site role not found');
    this.name = 'SiteRoleNotFoundError';
  }
}

/** Raised when a QR issuance names a Bathroom not found within the target Site. */
export class BathroomNotFoundError extends Error {
  constructor() {
    super('Bathroom not found for site');
    this.name = 'BathroomNotFoundError';
  }
}
