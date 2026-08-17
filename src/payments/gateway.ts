/**
 * Payment gateway seam (see SDD.md §9.3).
 *
 * `PaymentGateway` is the interface a real Stripe integration will implement
 * later; every call site in this app (src/payments/service.ts) is written
 * against this interface, not against Stripe directly, so swapping in a real
 * `StripeGateway` requires no call-site changes.
 *
 * `MockPaymentGateway` is the ONLY implementation that exists today. It is
 * explicitly not Stripe: no network call, no SDK, no live keys, and -- because
 * this phase never collects a real card -- nothing that could actually
 * decline. It exists solely so the request/authorization/capture state
 * machine can be built, demoed, and tested before Stripe integration lands as
 * a later, separate task (SDD §9.3). Do not treat this as production-ready:
 * no real money can move through it under any configuration.
 */
import { randomUUID } from 'node:crypto';

export interface AuthorizeInput {
  amountCents: number;
  /** Reserved for a real gateway's duplicate-request dedup; unused by the mock (SDD §9.3). */
  idempotencyKey: string;
}

export interface AuthorizeResult {
  /** Prefixed `mock_pi_` so it can never be mistaken for a real Stripe id (`pi_...`). */
  gatewayId: string;
}

export interface PaymentGateway {
  /** Places a manual-capture-style hold for the given amount. */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  /** Captures a previously authorized hold. */
  capture(gatewayId: string): Promise<void>;
  /** Releases a previously authorized hold. */
  cancel(gatewayId: string): Promise<void>;
}

/**
 * In-memory mock standing in for Stripe (SDD §9.3). `authorize` always
 * succeeds for a positive amount; `capture`/`cancel` are no-ops on the
 * gateway side -- this app's own `PaymentAuthorization.status`, checked
 * before either is ever called, is what actually prevents an invalid
 * transition (e.g. double-capture), exactly as it will once a real gateway
 * replaces this one.
 */
export class MockPaymentGateway implements PaymentGateway {
  authorize({ amountCents }: AuthorizeInput): Promise<AuthorizeResult> {
    if (amountCents <= 0) {
      return Promise.reject(new Error('amountCents must be positive'));
    }
    return Promise.resolve({ gatewayId: `mock_pi_${randomUUID()}` });
  }

  capture(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
