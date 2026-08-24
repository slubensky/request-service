/**
 * SMS gateway seam, mirroring `src/payments/gateway.ts`'s pattern: every call
 * site (src/admin/service.ts, src/manager/service.ts) is written against this
 * interface, not against SNS directly, so swapping implementations requires no
 * call-site changes.
 *
 * `send` never throws -- a delivery failure must not block or roll back the
 * SiteRole invite it's reporting on, which is already persisted and is the
 * real source of authority (SDD §3.3). Callers surface `result.sent` to the
 * inviter so a failed send is visible and they can follow up another way.
 */

export interface SmsSendResult {
  sent: boolean;
  /** Present only when `sent` is false; a short, loggable reason. */
  error?: string;
}

export interface SmsGateway {
  send(phone: string, message: string): Promise<SmsSendResult>;
}

/** The one message this app sends today: invite text for a manager or authorized-user
 * invite (SDD §3.3, §11.1, §11.4). Shared by admin/routes.ts and manager/routes.ts so
 * both invite paths send byte-identical wording. No token in the link -- the invite
 * bridge links a pending SiteRole by the invitee's own verified phone once they sign in
 * through Cognito's real SMS OTP, so the link itself carries no secret to leak. */
export function buildInviteMessage(siteName: string, baseUrl: string): string {
  return `${siteName} invited you to Restroom Hero. Sign in at ${baseUrl}/auth/login to get started.`;
}

/**
 * In-memory mock: records every attempted send so tests can assert on
 * recipient/content, and always reports success. Used for local dev
 * (DEMO_MODE) and as the default in tests, exactly as `MockPaymentGateway`
 * stands in for Stripe.
 */
export class MockSmsGateway implements SmsGateway {
  readonly sent: { phone: string; message: string }[] = [];

  send(phone: string, message: string): Promise<SmsSendResult> {
    this.sent.push({ phone, message });
    return Promise.resolve({ sent: true });
  }
}
