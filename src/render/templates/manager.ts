/**
 * Site Manager console templates (see SDD.md §11.4).
 *
 * Every dynamic value is escaped before interpolation. The invite mutation is a
 * real <form> enhanced by /js/manager.js, which submits it via fetch with the
 * session-bound `x-csrf-token` header; without JS the form is inert (this is an
 * authenticated console, not the public page).
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';
import type { ManagedSite } from '../../manager/service.js';
import type { SiteRoleRow } from '../../db/schema.js';

// Demo-only (SDD §6.3): the single-use accept code plus a copyable accept link.
// Rendered only when a code is present for the invite (DEMO_MODE on); otherwise
// the invite renders exactly as before.
function renderDemoCode(code: string): string {
  const safeCode = escapeHtml(code);
  const acceptLink = `/invite/accept?code=${encodeURIComponent(code)}`;
  return `
            <span class="invite-code">Code: <code>${safeCode}</code></span>
            <a class="invite-accept-link" href="${escapeHtml(acceptLink)}">Accept link</a>`;
}

function renderPendingInvite(invite: SiteRoleRow, demoCode: string | undefined): string {
  const safePhone = escapeHtml(invite.invitedPhone ?? 'unknown number');
  const safeRole = escapeHtml(invite.role);
  const demoHtml = demoCode ? renderDemoCode(demoCode) : '';
  return `
          <li class="invite">
            <span class="invite-phone">${safePhone}</span>
            <span class="invite-role">${safeRole}</span>${demoHtml}
          </li>`;
}

function renderManagedSite(entry: ManagedSite, demoCodes: ReadonlyMap<string, string>): string {
  const { site } = entry;
  const safeName = escapeHtml(site.name);
  const safeAddress = escapeHtml(site.address);
  const invitesHtml =
    entry.pendingInvites.length === 0
      ? '<li class="empty">No pending invites.</li>'
      : entry.pendingInvites
          .map((invite) => renderPendingInvite(invite, demoCodes.get(invite.id)))
          .join('');
  const inviteAction = `/manager/sites/${encodeURIComponent(site.id)}/invites`;
  return `
      <section class="card site">
        <h3>${safeName}</h3>
        <p class="subtitle">${safeAddress}</p>
        <ul class="invites">${invitesHtml}</ul>
        <form class="stack-form" method="post" action="${escapeHtml(inviteAction)}" data-manager-form>
          <label>Invite by phone
            <input name="phone" required maxlength="32" inputmode="tel" autocomplete="off" />
          </label>
          <label>Role
            <select name="role" required>
              <option value="assistant">Assistant</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <button type="submit">Send invite</button>
        </form>
      </section>`;
}

/**
 * Renders the console: every Site the caller manages, its pending invites, and an
 * invite form. `demoCodes` maps a pending invite's SiteRole id to its single-use
 * accept code (SDD §6.3); it is empty (and nothing extra renders) unless
 * DEMO_MODE is on.
 */
export function renderManagerConsole(
  sites: ManagedSite[],
  csrfToken: string,
  demoCodes: ReadonlyMap<string, string> = new Map(),
): string {
  const sitesHtml =
    sites.length === 0
      ? '<p class="muted-note">You are not an authorized manager at any site yet.</p>'
      : sites.map((entry) => renderManagedSite(entry, demoCodes)).join('');
  const bodyHtml = `
      <header class="page-header">
        <h1>Site Manager</h1>
        <p class="subtitle">Invite managers and assistants to the sites you run.</p>
      </header>
      ${sitesHtml}
  `;
  return renderLayout({
    title: 'Site Manager',
    bodyHtml,
    csrfToken,
    scripts: ['/js/main.js', '/js/manager.js'],
  });
}
