/**
 * Over-limit request approvals (see SDD.md §10). When an authorized user requests
 * a cleaning whose amount is above their `max_authorization_cents`, no hold is
 * placed; instead a single-use, 15-minute, price-bound `RequestApproval` is
 * recorded and a manager grants it, which places the hold via the normal
 * authorization path (`createCleaningRequest`, §9.1 step 2).
 *
 * These functions perform the writes/reads only. Every caller (public/manager
 * routes) must first clear the deny-by-default matrix (§7): the authorized user's
 * over-limit `create_cleaning_request` denial (`exceeds_max_authorization`) gates
 * creation, and `request:approve` gates the grant. All queries are parameterized
 * through Drizzle.
 */
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import {
  bathrooms,
  requestApprovals,
  sites,
  users,
  type CleaningRequestRow,
  type RequestApprovalRow,
} from '../db/schema.js';
import { createCleaningRequest } from './service.js';
import type { PaymentGateway } from './gateway.js';

/** Over-limit approvals expire 15 minutes after creation (SDD §10). */
const APPROVAL_TTL_MS = 15 * 60_000;

/** Raised when an approve names a `RequestApproval` id that does not exist. */
export class RequestApprovalNotFoundError extends Error {
  constructor() {
    super('Approval request not found');
    this.name = 'RequestApprovalNotFoundError';
  }
}

/** Raised when a pending approval can no longer be granted (already used, expired, or the
 * bound price changed) -- mapped to `409` by the route (SDD §10). */
export class InvalidApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApprovalStateError';
  }
}

export interface CreateRequestApprovalInput {
  siteId: string;
  bathroomId: string;
  requesterUserId: string;
  /** Server-derived price snapshot (SDD §8); `1` in this phase. */
  priceVersion: number;
  amountCents: number;
}

/**
 * Records a pending over-limit approval (SDD §10). Any prior still-pending approval for the
 * same bathroom + requester is superseded (`status=expired`) first, so at most one live
 * pending approval exists per (bathroom, requester) -- the console never accumulates stale
 * duplicates when a requester taps twice.
 */
export async function createRequestApproval(
  db: AppDatabase,
  input: CreateRequestApprovalInput,
): Promise<RequestApprovalRow> {
  await db
    .update(requestApprovals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(requestApprovals.bathroomId, input.bathroomId),
        eq(requestApprovals.requesterUserId, input.requesterUserId),
        eq(requestApprovals.status, 'pending'),
      ),
    );
  const [row] = await db
    .insert(requestApprovals)
    .values({
      siteId: input.siteId,
      bathroomId: input.bathroomId,
      requesterUserId: input.requesterUserId,
      priceVersion: input.priceVersion,
      amountCents: input.amountCents,
      status: 'pending',
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create approval request');
  }
  return row;
}

/** The live pending approval for a (bathroom, requester), or null -- for the scan page's
 * "awaiting approval" state (SDD §11.6). Only a non-expired, still-pending row qualifies. */
export async function findPendingApproval(
  db: AppDatabase,
  bathroomId: string,
  requesterUserId: string,
): Promise<RequestApprovalRow | null> {
  const [row] = await db
    .select()
    .from(requestApprovals)
    .where(
      and(
        eq(requestApprovals.bathroomId, bathroomId),
        eq(requestApprovals.requesterUserId, requesterUserId),
        eq(requestApprovals.status, 'pending'),
        gt(requestApprovals.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface PendingApprovalView {
  approval: RequestApprovalRow;
  bathroomLabel: string;
  /** Requester's invited/verified phone, for the manager console. */
  requesterPhone: string | null;
}

/** Every live pending approval across the given sites, for the manager console (SDD §11.4). */
export async function listPendingApprovalsForSites(
  db: AppDatabase,
  siteIds: readonly string[],
): Promise<PendingApprovalView[]> {
  if (siteIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      approval: requestApprovals,
      bathroomLabel: bathrooms.label,
      requesterPhone: users.phone,
    })
    .from(requestApprovals)
    .innerJoin(bathrooms, eq(requestApprovals.bathroomId, bathrooms.id))
    .leftJoin(users, eq(requestApprovals.requesterUserId, users.id))
    .where(
      and(
        inArray(requestApprovals.siteId, [...siteIds]),
        eq(requestApprovals.status, 'pending'),
        gt(requestApprovals.expiresAt, new Date()),
      ),
    )
    .orderBy(requestApprovals.createdAt);
  return rows.map((row) => ({
    approval: row.approval,
    bathroomLabel: row.bathroomLabel,
    requesterPhone: row.requesterPhone,
  }));
}

/** Loads one approval by id (for the site-scoped authorization gate + the grant), or throws. */
export async function loadRequestApproval(
  db: AppDatabase,
  approvalId: string,
): Promise<RequestApprovalRow> {
  const [row] = await db
    .select()
    .from(requestApprovals)
    .where(eq(requestApprovals.id, approvalId))
    .limit(1);
  if (!row) {
    throw new RequestApprovalNotFoundError();
  }
  return row;
}

/**
 * Grants a pending over-limit approval (SDD §10): re-validates the binding (still pending,
 * not expired, and the site's current fixed price still equals the bound amount), then
 * places the hold via `createCleaningRequest` (the same duplicate-active guard and mock
 * gateway as a direct authorize) and marks the approval `used`. A stale binding is superseded
 * (`status=expired`) and surfaced as `InvalidApprovalStateError` rather than silently
 * placing a hold at an outdated price. The caller (manager route) has already cleared
 * `request:approve` and confirmed the site has a saved payment method.
 */
export async function approveRequest(
  db: AppDatabase,
  gateway: PaymentGateway,
  approvalId: string,
  approverUserId: string,
): Promise<{ approval: RequestApprovalRow; request: CleaningRequestRow }> {
  const approval = await loadRequestApproval(db, approvalId);
  if (approval.status !== 'pending') {
    throw new InvalidApprovalStateError('This request is no longer awaiting approval');
  }
  if (approval.expiresAt.getTime() <= Date.now()) {
    await expireApproval(db, approval.id);
    throw new InvalidApprovalStateError('This approval request has expired');
  }
  const [site] = await db
    .select({ fixedPriceCents: sites.fixedPriceCents })
    .from(sites)
    .where(eq(sites.id, approval.siteId))
    .limit(1);
  if (!site) {
    throw new InvalidApprovalStateError('Site not found');
  }
  // Price-binding (SDD §10): if the site's fixed price changed since the request, the bound
  // amount is stale -- invalidate rather than place a hold at an outdated price.
  if (site.fixedPriceCents !== approval.amountCents) {
    await expireApproval(db, approval.id);
    throw new InvalidApprovalStateError(
      'The site price changed since this request; ask the requester to submit again',
    );
  }
  const { request } = await createCleaningRequest(db, gateway, {
    siteId: approval.siteId,
    bathroomId: approval.bathroomId,
    requestedByUserId: approval.requesterUserId,
    amountCents: approval.amountCents,
  });
  const [used] = await db
    .update(requestApprovals)
    .set({ status: 'used', approvedByUserId: approverUserId, usedAt: new Date() })
    .where(and(eq(requestApprovals.id, approval.id), eq(requestApprovals.status, 'pending')))
    .returning();
  return { approval: used ?? approval, request };
}

/** Marks a single approval `expired` (idempotent on a still-pending row). */
async function expireApproval(db: AppDatabase, approvalId: string): Promise<void> {
  await db
    .update(requestApprovals)
    .set({ status: 'expired' })
    .where(and(eq(requestApprovals.id, approvalId), eq(requestApprovals.status, 'pending')));
}
