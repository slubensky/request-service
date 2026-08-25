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
import { renderPhoneField } from './phone-field.js';
import { formatCents } from './confirm.js';
import type { SiteWithBathrooms } from '../../admin/service.js';
import type { SiteRoleRow } from '../../db/schema.js';

function renderManagerRow(
  siteId: string,
  manager: SiteRoleRow,
  demoCode: string | undefined,
): string {
  const safePhone = escapeHtml(manager.invitedPhone ?? 'linked account');
  const safeStatus = escapeHtml(manager.status);
  // Demo-only (SDD §6.3): the accept code is shown only for a pending manager invite
  // when a code is present (DEMO_MODE on); otherwise nothing extra renders.
  const demoHtml = demoCode ? renderDemoInviteCode(demoCode) : '';
  const revokeAction = `/admin/sites/${encodeURIComponent(siteId)}/roles/${encodeURIComponent(
    manager.id,
  )}/revoke`;
  return `
          <li class="manager">
            <span class="manager-phone">${safePhone}</span>
            <span class="manager-status">${safeStatus}</span>
            <form class="inline-form" method="post" action="${escapeHtml(revokeAction)}" data-admin-form>
              <button type="submit" class="button-danger">Revoke</button>
            </form>${demoHtml}
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

/** Renders one authorized-user row: status, approval limit, a set-limit form, and Revoke.
 * A pending invite also shows its demo accept code (DEMO_MODE only). */
function renderAuthorizedUserRow(
  siteId: string,
  user: SiteRoleRow,
  demoCode: string | undefined,
): string {
  const safePhone = escapeHtml(user.invitedPhone ?? 'linked account');
  const safeStatus = escapeHtml(user.status);
  const limitText =
    user.maxAuthorizationCents === null ? 'none' : formatCents(user.maxAuthorizationCents);
  const demoHtml = demoCode ? renderDemoInviteCode(demoCode) : '';
  const base = `/admin/sites/${encodeURIComponent(siteId)}/roles/${encodeURIComponent(user.id)}`;
  return `
          <li class="authorized-user">
            <span class="member-phone">${safePhone}</span>
            <span class="member-status">${safeStatus}</span>
            <span class="member-limit">Limit: ${escapeHtml(limitText)}</span>
            <form class="inline-form" method="post" action="${escapeHtml(`${base}/limit`)}" data-admin-form>
              <label>New limit (cents)
                <input name="max_authorization_cents" required inputmode="numeric" maxlength="9" autocomplete="off" />
              </label>
              <button type="submit">Update limit</button>
            </form>
            <form class="inline-form" method="post" action="${escapeHtml(`${base}/revoke`)}" data-admin-form>
              <button type="submit" class="button-danger">Revoke</button>
            </form>${demoHtml}
          </li>`;
}

// The membership lists give the Company Admin visibility of who manages and who is
// authorized at each site, with Revoke (both) and set-limit (authorized users) controls
// (SDD §11.1, §11.3). Rendered in every environment; the per-invite demo accept code is
// still DEMO_MODE-only.
function renderMembers(entry: SiteWithBathrooms, demoCodes: ReadonlyMap<string, string>): string {
  const managers = entry.members.filter((m) => m.role === 'manager');
  const authorizedUsers = entry.members.filter((m) => m.role === 'authorized_user');
  const managersHtml =
    managers.length === 0
      ? '<li class="empty">No managers yet.</li>'
      : managers
          .map((manager) => renderManagerRow(entry.site.id, manager, demoCodes.get(manager.id)))
          .join('');
  const usersHtml =
    authorizedUsers.length === 0
      ? '<li class="empty">No authorized users yet.</li>'
      : authorizedUsers
          .map((user) => renderAuthorizedUserRow(entry.site.id, user, demoCodes.get(user.id)))
          .join('');
  return (
    `\n        <h4>Managers</h4>\n        <ul class="managers">${managersHtml}</ul>` +
    `\n        <h4>Authorized users</h4>\n        <ul class="authorized-users">${usersHtml}</ul>`
  );
}

function renderSite(entry: SiteWithBathrooms, demoCodes: ReadonlyMap<string, string>): string {
  const { site } = entry;
  const safeName = escapeHtml(site.name);
  const safeAddress = escapeHtml(site.address);
  const bathroomsHtml =
    entry.bathrooms.length === 0
      ? '<li class="empty">No bathrooms yet.</li>'
      : entry.bathrooms.map((b) => renderBathroom(site.id, b.id, b.label)).join('');
  const membersSection = renderMembers(entry, demoCodes);
  const bathroomAction = `/admin/sites/${encodeURIComponent(site.id)}/bathrooms`;
  const managerAction = `/admin/sites/${encodeURIComponent(site.id)}/managers`;
  return `
      <section class="card site">
        <h3>${safeName}</h3>
        <p class="subtitle">${safeAddress}</p>
        <ul class="bathrooms">${bathroomsHtml}</ul>${membersSection}
        <form class="stack-form" method="post" action="${escapeHtml(bathroomAction)}" data-admin-form>
          <label>Bathroom label
            <input name="label" required maxlength="120" autocomplete="off" />
          </label>
          <button type="submit">Add bathroom</button>
        </form>
        <form class="stack-form" method="post" action="${escapeHtml(managerAction)}" data-admin-form>
          ${renderPhoneField('Invite initial manager (phone)')}
          <button type="submit">Invite manager</button>
        </form>
      </section>`;
}

/**
 * Renders the console: a create-site form plus each site with its onboarding
 * actions and its managers list (with Revoke). `demoCodes` maps a pending
 * manager invite's SiteRole id to its single-use accept code (SDD §6.3) and is
 * empty unless DEMO_MODE is on -- the managers list itself renders in every
 * environment.
 */
export function renderAdminConsole(
  sites: SiteWithBathrooms[],
  csrfToken: string,
  demoCodes: ReadonlyMap<string, string> = new Map(),
): string {
  const sitesHtml =
    sites.length === 0
      ? '<p class="muted-note">No sites yet. Create one to begin onboarding.</p>'
      : sites.map((entry) => renderSite(entry, demoCodes)).join('');
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
