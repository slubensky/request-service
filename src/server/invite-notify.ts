/**
 * Shared tail of every invite-creation route (SDD §11.1, §11.4): admin's
 * initial-manager invite and manager's site-member invite both create the
 * SiteRole first (via their own service call, which differs), then do the
 * exact same thing with the outcome -- report an idempotent no-op, otherwise
 * mint a demo accept code (DEMO_MODE) or send the real invite SMS, then
 * respond. Extracted here since the two were previously near-identical
 * copies in src/admin/routes.ts and src/manager/routes.ts.
 */
import type { RouteContext } from './router.js';
import { publicBaseUrl } from './base-url.js';
import { sendText } from './respond.js';
import { isDemoMode } from '../demo/config.js';
import { issueDemoInviteCode } from '../demo/service.js';
import { buildInviteMessage, type SmsGateway } from '../sms/gateway.js';
import type { AppDatabase } from '../db/client.js';
import type { InviteOutcome } from '../admin/service.js';

export async function respondToInviteOutcome(
  ctx: RouteContext,
  db: AppDatabase,
  outcome: InviteOutcome,
  phone: string,
  smsGateway: SmsGateway,
): Promise<void> {
  if (!outcome.created) {
    // Idempotent no-op: the phone already holds a non-revoked role here.
    sendText(ctx.res, 200, 'That phone is already a member of this site — no new invite created.');
    return;
  }
  if (isDemoMode()) {
    // Mints the single-use accept code so the console can display it, via
    // the same service both consoles share.
    await issueDemoInviteCode(db, outcome.role.id);
  } else {
    // A send failure never blocks or rolls back the already-created invite
    // (src/sms/gateway.ts) -- it's surfaced in the response so the inviter
    // can follow up another way.
    const message = buildInviteMessage(outcome.siteName, publicBaseUrl(ctx));
    const result = await smsGateway.send(phone, message);
    if (!result.sent) {
      sendText(
        ctx.res,
        200,
        'Invite created, but the text message failed to send. Let them know another way.',
      );
      return;
    }
  }
  sendText(ctx.res, 200, 'Invitation sent.');
}
