/**
 * Cleaning request + payment authorization data operations (see SDD.md §9.1,
 * §9.3, §11.6).
 *
 * These functions perform the writes only -- they do NOT make authorization
 * decisions. Every caller (public/admin routes) must first clear
 * `authorizeAction`/`authorizeOrReject` so the deny-by-default matrix (§7) is
 * the single gate, and must resolve the server-derived amount (§8) before
 * calling in, since authorization has to run against that same amount before
 * any side effect occurs (§7). All queries are parameterized through Drizzle.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { isUniqueViolation } from '../db/access.js';
import {
  cleaningRequests,
  paymentAuthorizations,
  sitePaymentMethods,
  type CleaningRequestRow,
  type PaymentAuthorizationRow,
  type SitePaymentMethodRow,
} from '../db/schema.js';
import type { PaymentGateway } from './gateway.js';

export interface CreateCleaningRequestInput {
  siteId: string;
  bathroomId: string;
  requestedByUserId: string;
  /** Server-derived (SDD §8) by the caller immediately before this call. */
  amountCents: number;
}

/**
 * Places a hold via the gateway and, only once it succeeds, creates the
 * `CleaningRequest` (status `authorized`) and `PaymentAuthorization` (status
 * `requires_capture`) rows (SDD §9.1 step 2). A failed authorization creates
 * neither row. `price_version` is `1` for every request in this phase -- no
 * price-history mechanism exists yet (SDD §11.6).
 *
 * A bathroom may have any number of simultaneous non-terminal requests (SDD
 * §9.4 -- the earlier one-active-request-per-bathroom guard was removed by
 * explicit product decision); each is its own CleaningRequest/
 * PaymentAuthorization pair, independently captured or canceled.
 */
export async function createCleaningRequest(
  db: AppDatabase,
  gateway: PaymentGateway,
  input: CreateCleaningRequestInput,
): Promise<{ request: CleaningRequestRow; authorization: PaymentAuthorizationRow }> {
  const authorized = await gateway.authorize({
    amountCents: input.amountCents,
    idempotencyKey: randomUUID(),
  });

  const [request] = await db
    .insert(cleaningRequests)
    .values({
      siteId: input.siteId,
      bathroomId: input.bathroomId,
      requestedByUserId: input.requestedByUserId,
      priceVersion: 1,
      amountCents: input.amountCents,
      status: 'authorized',
    })
    .returning();
  if (!request) {
    throw new Error('Failed to create cleaning request');
  }

  const [authorization] = await db
    .insert(paymentAuthorizations)
    .values({
      requestId: request.id,
      stripePaymentIntentId: authorized.gatewayId,
      status: 'requires_capture',
      amountCents: input.amountCents,
    })
    .returning();
  if (!authorization) {
    throw new Error('Failed to create payment authorization');
  }

  return { request, authorization };
}

export interface PendingCapture {
  authorization: PaymentAuthorizationRow;
  request: CleaningRequestRow;
}

/** Every outstanding (`requires_capture`) authorization, for the Company-Admin console. */
export async function listPendingCaptures(db: AppDatabase): Promise<PendingCapture[]> {
  const rows = await db
    .select({ authorization: paymentAuthorizations, request: cleaningRequests })
    .from(paymentAuthorizations)
    .innerJoin(cleaningRequests, eq(paymentAuthorizations.requestId, cleaningRequests.id))
    .where(eq(paymentAuthorizations.status, 'requires_capture'))
    .orderBy(paymentAuthorizations.createdAt);
  return rows;
}

/** Raised when a capture/cancel names a `PaymentAuthorization` id that does not exist. */
export class PaymentAuthorizationNotFoundError extends Error {
  constructor() {
    super('Payment authorization not found');
    this.name = 'PaymentAuthorizationNotFoundError';
  }
}

/** Raised when a capture/cancel is attempted on an authorization not in `requires_capture`. */
export class InvalidPaymentStateError extends Error {
  constructor(status: string) {
    super(`Payment authorization is not capturable/cancelable (status=${status})`);
    this.name = 'InvalidPaymentStateError';
  }
}

/**
 * Loads a `PaymentAuthorization` with its `CleaningRequest` (for the site id
 * every capture/cancel action needs), or throws if the id is unknown. Read-only
 * -- used both to resolve the site id for the authorization gate before any
 * write, and again to load the row for the actual mutation.
 */
export async function loadPaymentAuthorization(
  db: AppDatabase,
  paymentAuthorizationId: string,
): Promise<PendingCapture> {
  const [row] = await db
    .select({ authorization: paymentAuthorizations, request: cleaningRequests })
    .from(paymentAuthorizations)
    .innerJoin(cleaningRequests, eq(paymentAuthorizations.requestId, cleaningRequests.id))
    .where(eq(paymentAuthorizations.id, paymentAuthorizationId))
    .limit(1);
  if (!row) {
    throw new PaymentAuthorizationNotFoundError();
  }
  return row;
}

/** Captures a hold (SDD §9.1 step 3): Company-Admin/internal-backend only, enforced by the caller. */
export async function captureCleaningRequest(
  db: AppDatabase,
  gateway: PaymentGateway,
  paymentAuthorizationId: string,
): Promise<void> {
  const { authorization } = await loadPaymentAuthorization(db, paymentAuthorizationId);
  if (authorization.status !== 'requires_capture') {
    throw new InvalidPaymentStateError(authorization.status);
  }
  await gateway.capture(authorization.stripePaymentIntentId);
  await db
    .update(paymentAuthorizations)
    .set({ status: 'captured' })
    .where(eq(paymentAuthorizations.id, paymentAuthorizationId));
  await db
    .update(cleaningRequests)
    .set({ status: 'completed' })
    .where(eq(cleaningRequests.id, authorization.requestId));
}

/** Releases a hold (SDD §9.1 step 4): Company-Admin/internal-backend only, enforced by the caller. */
export async function cancelCleaningRequest(
  db: AppDatabase,
  gateway: PaymentGateway,
  paymentAuthorizationId: string,
): Promise<void> {
  const { authorization } = await loadPaymentAuthorization(db, paymentAuthorizationId);
  if (authorization.status !== 'requires_capture') {
    throw new InvalidPaymentStateError(authorization.status);
  }
  await gateway.cancel(authorization.stripePaymentIntentId);
  await db
    .update(paymentAuthorizations)
    .set({ status: 'canceled' })
    .where(eq(paymentAuthorizations.id, paymentAuthorizationId));
  await db
    .update(cleaningRequests)
    .set({ status: 'canceled' })
    .where(eq(cleaningRequests.id, authorization.requestId));
}

/** Raised when a site already has a saved payment method (SDD §9.4: at most one per site). */
export class SitePaymentMethodAlreadyExistsError extends Error {
  constructor() {
    super('This site already has a saved payment method');
    this.name = 'SitePaymentMethodAlreadyExistsError';
  }
}

/** Reads the site's saved (mock) payment method, or null if none has been added yet. */
export async function getSitePaymentMethod(
  db: AppDatabase,
  siteId: string,
): Promise<SitePaymentMethodRow | null> {
  const [row] = await db
    .select()
    .from(sitePaymentMethods)
    .where(eq(sitePaymentMethods.siteId, siteId))
    .limit(1);
  return row ?? null;
}

/**
 * Creates the site's saved (mock) payment method (SDD §9.4). Deliberately not a real card:
 * `displayLabel` is a fixed mock string and `gatewayToken` is prefixed `mock_pm_` so it can
 * never be mistaken for a real Stripe payment-method id -- there is no free-text PAN/CVV/
 * expiry field anywhere in this flow. Rejects with `SitePaymentMethodAlreadyExistsError` if
 * the site already has one (no silent overwrite, no parallel create path); the unique index
 * on `site_id` backstops a true double-add race the pre-check above can't fully close on its
 * own (`isUniqueViolation` maps the resulting conflict to the same error, not an unhandled 500).
 */
export async function saveSitePaymentMethod(
  db: AppDatabase,
  siteId: string,
  createdByUserId: string,
): Promise<SitePaymentMethodRow> {
  const existing = await getSitePaymentMethod(db, siteId);
  if (existing) {
    throw new SitePaymentMethodAlreadyExistsError();
  }
  try {
    const [row] = await db
      .insert(sitePaymentMethods)
      .values({
        siteId,
        gatewayToken: `mock_pm_${randomUUID()}`,
        displayLabel: 'Mock Visa •••• 4242',
        createdByUserId,
      })
      .returning();
    if (!row) {
      throw new Error('Failed to save payment method');
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SitePaymentMethodAlreadyExistsError();
    }
    throw error;
  }
}
