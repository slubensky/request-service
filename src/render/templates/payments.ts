/**
 * Company-Admin pending-captures console (see SDD.md §9.3, §11.6). Every
 * dynamic value is escaped before interpolation. Mutations are real <form>
 * elements enhanced by /js/admin.js (session-bound `x-csrf-token`), inert
 * without JS -- same pattern as the rest of the admin console.
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';
import { formatCents } from './confirm.js';
import type { PendingCapture } from '../../payments/service.js';

function renderPendingCapture(entry: PendingCapture): string {
  const { authorization, request } = entry;
  const safeAmount = escapeHtml(formatCents(authorization.amountCents));
  const safeGatewayId = escapeHtml(authorization.stripePaymentIntentId);
  const captureAction = `/admin/payments/${encodeURIComponent(authorization.id)}/capture`;
  const cancelAction = `/admin/payments/${encodeURIComponent(authorization.id)}/cancel`;
  return `
      <section class="card payment">
        <p class="price">${safeAmount}</p>
        <p class="muted-note">Request ${escapeHtml(request.id)} &middot; ${safeGatewayId}</p>
        <form class="inline-form" method="post" action="${escapeHtml(captureAction)}" data-admin-form>
          <button type="submit">Capture</button>
        </form>
        <form class="inline-form" method="post" action="${escapeHtml(cancelAction)}" data-admin-form>
          <button type="submit">Cancel</button>
        </form>
      </section>`;
}

/** Renders the outstanding-holds console for a Company Admin (SDD §11.6). */
export function renderPaymentsConsole(pending: PendingCapture[], csrfToken: string): string {
  const listHtml =
    pending.length === 0
      ? '<p class="muted-note">No outstanding holds.</p>'
      : pending.map(renderPendingCapture).join('');
  const bodyHtml = `
      <header class="page-header">
        <h1>Outstanding holds</h1>
        <p class="subtitle">Capture after a cleaning is completed, or cancel to release the hold.</p>
      </header>
      ${listHtml}
      <p><a href="/admin">Back to console</a></p>
  `;
  return renderLayout({
    title: 'Outstanding holds',
    bodyHtml,
    csrfToken,
    scripts: ['/js/main.js', '/js/admin.js'],
  });
}
