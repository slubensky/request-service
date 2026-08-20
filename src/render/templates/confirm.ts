/**
 * Authenticated price-confirmation flow for an authorized Manager or authorized
 * user scanning their site's QR (see SDD.md §9.3, §11.6). Every dynamic value is
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
  /** The site's saved (mock) payment method label (SDD §9.4), e.g. "Mock Visa •••• 4242". */
  savedMethodLabel: string;
}

/** The price-confirmation + authorize-hold page (SDD §11.6, §11.7). Rendered only once the
 * site has a saved (mock) payment method and the session clears the step-up recency check
 * (SDD §6.4) -- see `renderAddPaymentMethodPage` / `renderReauthRequiredPage` for the other
 * two states of `GET /s/:token`. */
export function renderConfirmPage({
  siteName,
  amountCents,
  token,
  csrfToken,
  savedMethodLabel,
}: ConfirmPageOptions): string {
  const safeSiteName = escapeHtml(siteName);
  const safePrice = escapeHtml(formatCents(amountCents));
  const safeMethod = escapeHtml(savedMethodLabel);
  const action = `/s/${encodeURIComponent(token)}/authorize`;
  const bodyHtml = `
      <header class="page-header">
        <h1>Request a cleaning</h1>
        <p class="subtitle">${safeSiteName}</p>
      </header>
      <section class="card">
        <p>Fixed price for this cleaning:</p>
        <p class="price">${safePrice}</p>
        <p class="muted-note">Charged to ${safeMethod} (mock). Your card is placed on hold now and only charged after the cleaning is completed.</p>
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

export interface AddPaymentMethodPageOptions {
  siteName: string;
  amountCents: number;
  token: string;
  csrfToken: string;
}

/** First-time (mock) payment-method setup (SDD §9.4, §11.7): the *only* payment-method UI
 * action in this app. Deliberately no free-text PAN/CVV/expiry field -- a single button
 * creates a synthetic saved method server-side. Rendered when the site has no saved method
 * yet, for a caller who already clears the site-authority gate for this bathroom. */
export function renderAddPaymentMethodPage({
  siteName,
  amountCents,
  token,
  csrfToken,
}: AddPaymentMethodPageOptions): string {
  const safeSiteName = escapeHtml(siteName);
  const safePrice = escapeHtml(formatCents(amountCents));
  const action = `/s/${encodeURIComponent(token)}/payment-method`;
  const bodyHtml = `
      <header class="page-header">
        <h1>Request a cleaning</h1>
        <p class="subtitle">${safeSiteName}</p>
      </header>
      <section class="card">
        <p>Fixed price for this cleaning:</p>
        <p class="price">${safePrice}</p>
        <p class="muted-note">This site has no saved payment method yet. Add one (a mock record only -- no card details are collected) to continue.</p>
        <form class="stack-form" method="post" action="${escapeHtml(action)}" data-confirm-form>
          <button type="submit">Add a payment method (mock)</button>
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

export interface ReauthRequiredPageOptions {
  siteName: string;
  token: string;
  savedMethodLabel: string;
}

/** Step-up re-authentication prompt (SDD §6.4, §9.4): rendered instead of the authorize
 * form when the site has a saved method but the session was not established within the
 * recency window. No authorize action is offered here -- `POST /s/:token/authorize`
 * independently re-checks the same condition regardless of what this page shows. */
export function renderReauthRequiredPage({
  siteName,
  token,
  savedMethodLabel,
}: ReauthRequiredPageOptions): string {
  const safeSiteName = escapeHtml(siteName);
  const safeMethod = escapeHtml(savedMethodLabel);
  const next = `/s/${encodeURIComponent(token)}`;
  const loginHref = `/auth/login?next=${encodeURIComponent(next)}`;
  const bodyHtml = `
      <header class="page-header">
        <h1>Request a cleaning</h1>
        <p class="subtitle">${safeSiteName}</p>
      </header>
      <section class="card">
        <p>Placing a hold on ${safeMethod} requires a recent sign-in. Please re-verify your identity to continue.</p>
        <a class="button-link" href="${escapeHtml(loginHref)}">Re-authenticate</a>
      </section>
  `;
  return renderLayout({ title: 'Request a cleaning', bodyHtml, scripts: ['/js/main.js'] });
}

export interface RequestApprovalPageOptions {
  siteName: string;
  amountCents: number;
  token: string;
  csrfToken: string;
}

/** Over-limit request page (SDD §10, §11.6): rendered for an authorized user whose limit is
 * below the site price. Submitting does not place a hold -- it records a pending approval a
 * manager must grant. Reuses `data-confirm-form` so the same fetch/CSRF enhancement applies;
 * the server (`POST /s/:token/authorize`) re-derives the over-limit condition, never this page. */
export function renderRequestApprovalPage({
  siteName,
  amountCents,
  token,
  csrfToken,
}: RequestApprovalPageOptions): string {
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
        <p class="muted-note">This is above your authorization limit, so a manager must approve it before the hold is placed. Submitting sends your request to a manager.</p>
        <form class="stack-form" method="post" action="${escapeHtml(action)}" data-confirm-form>
          <button type="submit">Request manager approval</button>
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

/** The page shown after an over-limit request is recorded (SDD §10): no hold yet, awaiting a
 * manager's approval. Also the `GET /s/:token` state while a pending approval already exists. */
export function renderApprovalPendingPage(siteName: string, amountCents: number): string {
  const safeSiteName = escapeHtml(siteName);
  const safePrice = escapeHtml(formatCents(amountCents));
  const bodyHtml = `
      <header class="page-header">
        <h1>Awaiting manager approval</h1>
        <p class="subtitle">${safeSiteName}</p>
      </header>
      <section class="card">
        <p>Your request for a ${safePrice} cleaning is above your authorization limit and has been sent to a manager for approval. The hold is placed only once a manager approves.</p>
      </section>
  `;
  return renderLayout({ title: 'Awaiting approval', bodyHtml, scripts: [] });
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
