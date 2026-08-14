/**
 * Opaque QR token generation, hashing, and resolution (see SDD.md §5).
 *
 * Security invariants encoded here:
 * - Tokens are cryptographically random and non-sequential: 32 bytes from
 *   node:crypto, base64url-encoded. Nothing about the bathroom or site is
 *   derivable from a token.
 * - The raw token is NEVER persisted. Only its one-way SHA-256 hash is stored
 *   in `qr_tokens.token_hash`; resolution hashes the presented value and looks
 *   it up by that unique-indexed column.
 * - Resolution matches only an `active` token, so a revoked/replaced tag stops
 *   resolving immediately without altering the bathroom's identity or history.
 *
 * A raw token is opaque and high-entropy (256 bits), so a fast one-way hash is
 * appropriate here -- this is a lookup key, not a low-entropy password, and no
 * salted KDF is needed. We use only node:crypto (approved primitives; no
 * invented crypto), per AGENTS.md.
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { bathrooms, qrTokens } from '../db/schema.js';

/** Number of random bytes in an opaque token. 32 bytes = 256 bits of entropy. */
const TOKEN_BYTES = 32;

/** Generates a fresh opaque, non-sequential token. The caller stores only its hash. */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** One-way hash of a raw token; the only representation ever persisted. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** The bathroom + site a valid, active token resolves to. Identity only -- no authority. */
export interface ResolvedQrTarget {
  bathroomId: string;
  siteId: string;
}

/**
 * Resolves a presented raw token to its bathroom/site, or null when it does not
 * match an active token (unknown or revoked). Looks up by the one-way hash via
 * the unique `token_hash` index; the raw token is never compared against stored
 * plaintext because none exists.
 */
export async function resolveActiveQrToken(
  db: AppDatabase,
  rawToken: string,
): Promise<ResolvedQrTarget | null> {
  if (rawToken.length === 0) {
    return null;
  }
  const rows = await db
    .select({ bathroomId: qrTokens.bathroomId, siteId: bathrooms.siteId })
    .from(qrTokens)
    .innerJoin(bathrooms, eq(qrTokens.bathroomId, bathrooms.id))
    .where(and(eq(qrTokens.tokenHash, hashToken(rawToken)), eq(qrTokens.status, 'active')))
    .limit(1);

  const row = rows[0];
  return row ? { bathroomId: row.bathroomId, siteId: row.siteId } : null;
}
