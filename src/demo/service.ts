/**
 * Demo invitation-code operations (SDD §6.3). DEMO_MODE only.
 *
 * These functions mint, look up, and redeem a single-use code bound to one
 * pending SiteRole so the invite -> accept -> activation loop can be walked in a
 * browser without live SMS/Cognito. They make no authorization decision: a code
 * grants nothing on its own. Acceptance reuses the identity-resolution
 * (`findOrCreateUserByCognitoSub`) and the §3.3 activation bridge
 * (`bridgePendingSiteRoles`) UNCHANGED, so the demo exercises the real logic
 * rather than a parallel path. All writes go through Drizzle's parameterized
 * builder; the raw code alphabet excludes visually ambiguous characters.
 */
import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { demoInviteCodes, siteRoles, type DemoInviteCodeRow } from '../db/schema.js';
import { bridgePendingSiteRoles, findOrCreateUserByCognitoSub } from '../db/access.js';
import type { InvitableRole } from '../manager/service.js';

// Human-typable code: no 0/O/1/I/L to avoid transcription errors. Two groups of
// four gives ~31^8 ≈ 8.5e11 combinations -- ample for demo, and unique-indexed.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 2;
const CODE_GROUP_LENGTH = 4;

/** Generates a fresh, unambiguous demo code such as `K7QF-M2WD`. */
export function generateInviteCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < CODE_GROUP_LENGTH; i += 1) {
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Normalizes user-entered codes: trimmed, upper-cased (the alphabet is upper-case). */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Returns the still-unused code for a pending SiteRole, minting one if none
 * exists yet. Idempotent per invite: a repeat invite of the same pending role
 * reuses its outstanding code rather than accumulating duplicates.
 */
export async function issueDemoInviteCode(
  db: AppDatabase,
  siteRoleId: string,
): Promise<DemoInviteCodeRow> {
  const [existing] = await db
    .select()
    .from(demoInviteCodes)
    .where(and(eq(demoInviteCodes.siteRoleId, siteRoleId), isNull(demoInviteCodes.usedAt)))
    .limit(1);
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(demoInviteCodes)
    .values({ siteRoleId, code: generateInviteCode() })
    .returning();
  if (!row) {
    throw new Error('Failed to issue demo invite code');
  }
  return row;
}

/**
 * Maps each of the given pending SiteRole ids to its outstanding (unused) code,
 * for the manager console display. SiteRoles without a usable code are absent
 * from the map.
 */
export async function unusedCodesForSiteRoles(
  db: AppDatabase,
  siteRoleIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (siteRoleIds.length === 0) {
    return map;
  }
  const rows = await db
    .select()
    .from(demoInviteCodes)
    .where(
      and(inArray(demoInviteCodes.siteRoleId, [...siteRoleIds]), isNull(demoInviteCodes.usedAt)),
    );
  for (const row of rows) {
    if (!map.has(row.siteRoleId)) {
      map.set(row.siteRoleId, row.code);
    }
  }
  return map;
}

/** The outcome of redeeming a valid demo code -- enough to mint a session + result page. */
export interface DemoAcceptOutcome {
  /** The resolved demo `users.id` the caller is now authenticated as. */
  userId: string;
  /** The synthetic Cognito subject stamped into the session (stands in for SMS OTP). */
  sub: string;
  /** The invited role the code was bound to. */
  role: InvitableRole;
  /** True when the §3.3 bridge activated the role (manager -> authorized). */
  activated: boolean;
  /** The site the invite targets. */
  siteId: string;
}

/**
 * Redeems a demo code: claims it single-use, stands in for SMS-OTP verification
 * of the invited phone, and runs the §3.3 bridge UNCHANGED. Returns null for an
 * unknown or already-used code (fail closed: no identity resolved, no bridge).
 *
 * The claim is a single conditional UPDATE (`code = ? AND used_at IS NULL`), so
 * a concurrent or later second submission of the same code updates no row and is
 * rejected -- there is no read-then-write window to double-spend.
 */
export async function acceptDemoInviteCode(
  db: AppDatabase,
  rawCode: string,
): Promise<DemoAcceptOutcome | null> {
  const code = normalizeCode(rawCode);
  if (code.length === 0) {
    return null;
  }

  const [claimed] = await db
    .update(demoInviteCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(demoInviteCodes.code, code), isNull(demoInviteCodes.usedAt)))
    .returning();
  if (!claimed) {
    return null;
  }

  const [role] = await db
    .select()
    .from(siteRoles)
    .where(eq(siteRoles.id, claimed.siteRoleId))
    .limit(1);
  // A code is always bound to a phone-addressed pending invite; guard defensively.
  if (!role || !role.invitedPhone) {
    return null;
  }
  const invitedPhone = role.invitedPhone;

  // Stand in for SMS-OTP verification: resolve a deterministic demo identity
  // whose VERIFIED phone equals the invite's phone. Deterministic per phone so a
  // repeat demo accept re-resolves the same User, keeping the §3.3 bridge idempotent.
  const sub = `demo:${invitedPhone}`;
  const user = await findOrCreateUserByCognitoSub(db, sub, invitedPhone);

  // Reuse the real activation bridge UNCHANGED: both manager and authorized_user
  // invites activate to `authorized` on accept (SDD §3.3, Phase 6).
  await bridgePendingSiteRoles(db, user.id, invitedPhone);

  // Reflect the actual post-bridge state rather than assuming it.
  const [updated] = await db
    .select({ status: siteRoles.status })
    .from(siteRoles)
    .where(eq(siteRoles.id, claimed.siteRoleId))
    .limit(1);

  return {
    userId: user.id,
    sub,
    role: role.role,
    activated: updated?.status === 'authorized',
    siteId: role.siteId,
  };
}
