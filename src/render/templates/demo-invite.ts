/**
 * Demo invitation-code acceptance templates (SDD §6.3). DEMO_MODE only.
 *
 * Every dynamic value is escaped before interpolation. The accept form is a
 * plain <form> that works with zero client JS: the pre-session POST is protected
 * by a double-submit token carried in a hidden field (not the session-bound
 * header the authenticated consoles use), so no fetch enhancement is required.
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';
import type { InvitableRole } from '../../manager/service.js';

export interface AcceptFormOptions {
  /** Double-submit CSRF token; echoed in a hidden field and matched to the cookie. */
  csrfToken: string;
  /** Prefilled code (e.g. from the console's accept link). */
  code?: string;
  /** Optional error to surface above the form (invalid submission). */
  error?: string;
}

/** Renders the code-entry form. Zero-JS: submits as a normal urlencoded POST. */
export function renderAcceptForm({ csrfToken, code = '', error }: AcceptFormOptions): string {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const bodyHtml = `
      <header class="page-header">
        <h1>Accept your invitation</h1>
        <p class="subtitle">Enter the code your site manager gave you (demo mode).</p>
      </header>
      ${errorHtml}
      <form class="stack-form" method="post" action="/invite/accept">
        <input type="hidden" name="demo_csrf" value="${escapeHtml(csrfToken)}" />
        <label>Invitation code
          <input name="code" required maxlength="32" autocomplete="off"
                 inputmode="text" value="${escapeHtml(code)}" />
        </label>
        <button type="submit">Accept invitation</button>
      </form>`;
  return renderLayout({ title: 'Accept invitation', bodyHtml, scripts: [] });
}

/** Renders the outcome page after a valid code is redeemed (SDD §6.3 / §3.3). `activated`
 * and `role` reflect the accepter's ACTUAL authority at the site after the bridge, so a
 * superseded-duplicate accept reports real authority rather than a stale "pending". Both
 * roles activate in one step (Phase 6) -- there is no promotion, so the copy never mentions
 * one. An activated manager gets a Continue link to their console (`/manager`); an
 * authorized user has no console, so no link is shown (SDD §11.4). */
export function renderAcceptResult({
  activated,
  role,
}: {
  activated: boolean;
  role: InvitableRole;
}): string {
  let message: string;
  if (!activated) {
    message =
      'Your invitation was recorded, but you do not currently hold active authority at this site. Ask a manager to re-invite you.';
  } else if (role === 'manager') {
    message = 'You are now an authorized <strong>manager</strong>. Your site is operable.';
  } else {
    message =
      'You are now an <strong>authorized user</strong>. You can request a cleaning — a request above your limit is sent to a manager for approval.';
  }
  // A manager continues to their console; an authorized user has no console page.
  const continueLink =
    activated && role === 'manager'
      ? '\n        <p><a class="button-link" href="/manager">Continue to your console</a></p>'
      : '';
  const bodyHtml = `
      <header class="page-header">
        <h1>Invitation accepted</h1>
      </header>
      <section class="card">
        <p>${message}</p>${continueLink}
      </section>`;
  return renderLayout({ title: 'Invitation accepted', bodyHtml, scripts: [] });
}

/** Renders the rejection page for an unknown or already-used code (fail closed). */
export function renderAcceptRejected(): string {
  const bodyHtml = `
      <header class="page-header">
        <h1>Invitation not accepted</h1>
      </header>
      <section class="card">
        <p class="error" role="alert">That code is invalid or has already been used.</p>
        <p><a href="/invite/accept">Try another code</a></p>
      </section>`;
  return renderLayout({ title: 'Invitation not accepted', bodyHtml, scripts: [] });
}
