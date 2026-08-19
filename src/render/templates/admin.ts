/**
 * Company-Admin console templates (see SDD.md §11.1, §11.3).
 *
 * Every dynamic value is escaped before interpolation. Onboarding mutations are
 * real <form> elements enhanced by /js/admin.js, which submits them via fetch
 * with the session-bound `x-csrf-token` header; without JS the forms are inert
 * (this is an internal operator console, not the public page).
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';
import { renderDemoInviteCode } from './demo-invite-code.js';
import type { SiteWithBathrooms } from '../../admin/service.js';
import type { SiteRoleRow } from '../../db/schema.js';

function renderPendingInvite(invite: SiteRoleRow, demoCode: string | undefined): string {
  const safePhone = escapeHtml(invite.invitedPhone ?? 'unknown number');
  const safeRole = escapeHtml(invite.role);
  // Demo-only (SDD §6.3): rendered only when a code is present for the invite
  // (DEMO_MODE on); otherwise the invite renders exactly as before.
  const demoHtml = demoCode ? renderDemoInviteCode(demoCode) : '';
  return `
          <li class="invite">
            <span class="invite-phone">${safePhone}</span>
            <span class="invite-role">${safeRole}</span>${demoHtml}
          </li>`;
}

function renderBathroom(siteId: string, bathroomId: string, label: string): string {
  const safeLabel = escapeHtml(label);
  const qrAction = `/admin/sites/${encodeURIComponent(siteId)}/bathrooms/${encodeURIComponent(
    bathroomId,
  )}/qr`;
  return `
          <li class="bathroom">
            <span class="bathroom-label">${safeLabel}</span>
            <form class="inline-form" method="post" action="${escapeHtml(qrAction)}" data-admin-form>
              <button type="submit">Issue / replace QR</button>
            </form>
          </li>`;
}

// Demo-only (SDD §6.3): the pending-invites list itself is new admin-console
// surface introduced for the demo click-through and is gated on DEMO_MODE as a
// whole, not just the code/link within it -- with DEMO_MODE off the admin
// console must render byte-for-byte as it did before this feature existed.
function renderPendingInvites(
  entry: SiteWithBathrooms,
  demoCodes: ReadonlyMap<string, string>,
): string {
  const invitesHtml =
    entry.pendingInvites.length === 0
      ? '<li class="empty">No pending invites.</li>'
      : entry.pendingInvites
          .map((invite) => renderPendingInvite(invite, demoCodes.get(invite.id)))
          .join('');
  return `\n        <ul class="invites">${invitesHtml}</ul>`;
}

function renderSite(
  entry: SiteWithBathrooms,
  demoMode: boolean,
  demoCodes: ReadonlyMap<string, string>,
): string {
  const { site } = entry;
  const safeName = escapeHtml(site.name);
  const safeAddress = escapeHtml(site.address);
  const bathroomsHtml =
    entry.bathrooms.length === 0
      ? '<li class="empty">No bathrooms yet.</li>'
      : entry.bathrooms.map((b) => renderBathroom(site.id, b.id, b.label)).join('');
  const invitesSection = demoMode ? renderPendingInvites(entry, demoCodes) : '';
  const bathroomAction = `/admin/sites/${encodeURIComponent(site.id)}/bathrooms`;
  const managerAction = `/admin/sites/${encodeURIComponent(site.id)}/managers`;
  return `
      <section class="card site">
        <h3>${safeName}</h3>
        <p class="subtitle">${safeAddress}</p>
        <ul class="bathrooms">${bathroomsHtml}</ul>${invitesSection}
        <form class="stack-form" method="post" action="${escapeHtml(bathroomAction)}" data-admin-form>
          <label>Bathroom label
            <input name="label" required maxlength="120" autocomplete="off" />
          </label>
          <button type="submit">Add bathroom</button>
        </form>
        <form class="stack-form" method="post" action="${escapeHtml(managerAction)}" data-admin-form>
          <label>Invite initial manager (phone)
            <input name="phone" required maxlength="32" inputmode="tel" autocomplete="off" />
          </label>
          <button type="submit">Invite manager</button>
        </form>
      </section>`;
}

/**
 * Renders the console: a create-site form plus each site with its onboarding
 * actions. `demoMode` gates the entire pending-invites section (SDD §6.3): when
 * false the console renders byte-for-byte as it did before this feature
 * existed. `demoCodes` maps a pending invite's SiteRole id to its single-use
 * accept code, and is only consulted when `demoMode` is true.
 */
export function renderAdminConsole(
  sites: SiteWithBathrooms[],
  csrfToken: string,
  demoMode = false,
  demoCodes: ReadonlyMap<string, string> = new Map(),
): string {
  const sitesHtml =
    sites.length === 0
      ? '<p class="muted-note">No sites yet. Create one to begin onboarding.</p>'
      : sites.map((entry) => renderSite(entry, demoMode, demoCodes)).join('');
  const bodyHtml = `
      <header class="page-header">
        <h1>Company Admin</h1>
        <p class="subtitle">Onboard sites, bathrooms, QR tags, and the first manager.</p>
      </header>
      <section class="card">
        <h2>Create a site</h2>
        <form class="stack-form" method="post" action="/admin/sites" data-admin-form>
          <label>Name<input name="name" required maxlength="120" autocomplete="off" /></label>
          <label>Address<input name="address" required maxlength="240" autocomplete="off" /></label>
          <label>Timezone<input name="timezone" required maxlength="64" value="America/New_York" /></label>
          <label>Currency<input name="currency" required maxlength="8" value="usd" /></label>
          <label>Fixed price (cents)
            <input name="fixed_price_cents" required inputmode="numeric" pattern="[0-9]+" />
          </label>
          <button type="submit">Create site</button>
        </form>
      </section>
      ${sitesHtml}
  `;
  return renderLayout({
    title: 'Company Admin',
    bodyHtml,
    csrfToken,
    scripts: ['/js/main.js', '/js/admin.js'],
  });
}

/**
 * Renders the one-time QR issuance result: the inline SVG QR and the public
 * scan URL (which carries the raw token). This is shown only to the authorized
 * Company Admin at issuance; the raw token is never persisted server-side.
 */
export function renderQrIssued(scanUrl: string, qrSvg: string): string {
  const safeUrl = escapeHtml(scanUrl);
  // qrSvg is generated by the qrcode library from the scan URL only (no
  // untrusted input); it is a complete <svg> document embedded inline.
  const bodyHtml = `
      <header class="page-header">
        <h1>QR issued</h1>
        <p class="subtitle">Print this tag for the bathroom. Any previous tag is now revoked.</p>
      </header>
      <section class="card qr-card">
        <div class="qr-image">${qrSvg}</div>
        <p class="muted-note">Scan target:</p>
        <p><a href="${safeUrl}">${safeUrl}</a></p>
        <p class="muted-note">Works for NFC too: write this same URL to an NFC tag with any NFC-writing app (e.g. NFC Tools). No separate provisioning -- it's the identical opaque, revocable token either way (SDD §5).</p>
      </section>
      <p><a href="/admin">Back to console</a></p>
  `;
  return renderLayout({ title: 'QR issued', bodyHtml });
}
