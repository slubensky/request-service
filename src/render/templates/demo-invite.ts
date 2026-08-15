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

/** Renders the outcome page after a valid code is redeemed (SDD §6.3 / §3.3). */
export function renderAcceptResult({
  activated,
  role,
}: {
  activated: boolean;
  role: InvitableRole;
}): string {
  const safeRole = escapeHtml(role);
  const message = activated
    ? `You are now an authorized <strong>${safeRole}</strong>. Your site is operable.`
    : `Your <strong>${safeRole}</strong> invitation is linked, but still pending. ` +
      'A manager must promote you before you can act.';
  const bodyHtml = `
      <header class="page-header">
        <h1>Invitation accepted</h1>
      </header>
      <section class="card">
        <p>${message}</p>
        <p><a href="/">Continue</a></p>
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
