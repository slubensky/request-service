/**
 * Authenticated price-confirmation flow for an authorized Manager/Assistant
 * scanning their site's QR (see SDD.md §9.3, §11.6). Every dynamic value is
 * escaped before interpolation. Distinct from the neutral public-scan page
 * (render/templates/public-scan.ts), which stays byte-for-byte unchanged for
 * anyone without site authority -- these pages are only ever rendered for a
 * caller the deny-by-default matrix (§7) has already confirmed holds it.
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';

/** Formats integer cents as a fixed-price display string, e.g. 4500 -> "$45.00". */
export function formatCents(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

export interface ConfirmPageOptions {
  siteName: string;
  amountCents: number;
  token: string;
  csrfToken: string;
}

/** The price-confirmation + authorize-hold page (SDD §11.6). */
export function renderConfirmPage({
  siteName,
  amountCents,
  token,
  csrfToken,
}: ConfirmPageOptions): string {
  const safeSiteName = escapeHtml(siteName);
  const safePrice = escapeHtml(formatCents(amountCents));
  const action = `/s/${encodeURIComponent(token)}/authorize`;
  const bodyHtml = `
      <header class="page-header">
        <h1>Request a cleaning</h1>
        <p class="subtitle">${safeSiteName}</p>
      </header>
      <section class="card">
        <p>Fixed price for this cleaning:</p>
        <p class="price">${safePrice}</p>
        <p class="muted-note">Your card is placed on hold now and only charged after the cleaning is completed.</p>
        <form class="stack-form" method="post" action="${escapeHtml(action)}" data-confirm-form>
          <button type="submit">Authorize hold for ${safePrice}</button>
        </form>
      </section>
  `;
  return renderLayout({
    title: 'Request a cleaning',
    bodyHtml,
    csrfToken,
    scripts: ['/js/main.js', '/js/confirm.js'],
  });
}

/** The result page after a hold is successfully placed (SDD §9.1 step 2). */
export function renderAuthorizedPage(amountCents: number): string {
  const safePrice = escapeHtml(formatCents(amountCents));
  const bodyHtml = `
      <header class="page-header">
        <h1>Hold placed</h1>
      </header>
      <section class="card">
        <p>A hold for ${safePrice} has been placed. You will be charged only after the cleaning is completed.</p>
      </section>
  `;
  return renderLayout({ title: 'Hold placed', bodyHtml, scripts: [] });
}
