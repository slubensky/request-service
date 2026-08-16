/**
 * Company-Admin onboarding data operations (see SDD.md §11.1).
 *
 * These functions perform the onboarding writes only -- creating a Site,
 * Bathrooms, QRTokens, and the initial pending Manager SiteRole. They do NOT
 * make authorization decisions: every caller (admin routes) must first clear
 * `authorizeAction` so the deny-by-default matrix (§7) is the single gate.
 * All queries are parameterized through Drizzle; nothing is built from raw SQL.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
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

/**
 * Invites the initial Site Manager by phone, creating a pending `role=manager`
 * SiteRole with a null `user_id`; the invite bridge (§3.3) links it to an
 * identity when the invitee first authenticates. Confers no authority until
 * then. Throws when the Site does not exist.
 *
 * Idempotent like `inviteSiteMember` (SDD §11.1, §11.4): a repeat invite for
 * the same not-yet-linked phone at this Site returns the existing pending
 * record instead of inserting a duplicate row, so the §3.3 bridge never faces
 * two pending invites for the same phone+site+role from this path.
 */
export async function inviteInitialManager(
  db: AppDatabase,
  siteId: string,
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
        eq(siteRoles.role, 'manager'),
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
    .values({ siteId, invitedPhone, role: 'manager', status: 'pending' })
    .returning();
  if (!row) {
    throw new Error('Failed to create manager invite');
  }
  return row;
}

export interface SiteWithBathrooms {
  site: SiteRow;
  bathrooms: BathroomRow[];
  /** SiteRoles at this site not yet linked to an identity, newest first. */
  pendingInvites: SiteRoleRow[];
}

/** Lists every Site with its Bathrooms and pending invites for the Company-Admin console. */
export async function listSitesWithBathrooms(db: AppDatabase): Promise<SiteWithBathrooms[]> {
  const siteRows = await db.select().from(sites).orderBy(sites.createdAt);
  const result: SiteWithBathrooms[] = [];
  for (const site of siteRows) {
    const bathroomRows = await db
      .select()
      .from(bathrooms)
      .where(eq(bathrooms.siteId, site.id))
      .orderBy(bathrooms.createdAt);
    const pendingInvites = await db
      .select()
      .from(siteRoles)
      .where(and(eq(siteRoles.siteId, site.id), eq(siteRoles.status, 'pending')))
      .orderBy(siteRoles.createdAt);
    result.push({ site, bathrooms: bathroomRows, pendingInvites });
  }
  return result;
}

/** Raised when an onboarding action names a Site that does not exist. */
export class SiteNotFoundError extends Error {
  constructor() {
    super('Site not found');
    this.name = 'SiteNotFoundError';
  }
}

/** Raised when a QR issuance names a Bathroom not found within the target Site. */
export class BathroomNotFoundError extends Error {
  constructor() {
    super('Bathroom not found for site');
    this.name = 'BathroomNotFoundError';
  }
}
