/**
 * Site Manager console templates (see SDD.md §11.4).
 *
 * Every dynamic value is escaped before interpolation. Mutations are real
 * <form> elements enhanced by /js/manager.js, which submits them via fetch with
 * the session-bound `x-csrf-token` header; without JS the forms are inert (this
 * is an authenticated console, not the public page).
 */
import { escapeHtml } from '../escape.js';
import { renderLayout } from './layout.js';
import { renderDemoInviteCode } from './demo-invite-code.js';
import { renderPhoneField } from './phone-field.js';
import { formatCents } from './confirm.js';
import type { ManagedSite } from '../../manager/service.js';
import type { PendingApprovalView } from '../../payments/approvals.js';
import type { SiteRoleRow } from '../../db/schema.js';

function roleLabel(role: SiteRoleRow['role']): string {
  return role === 'manager' ? 'Manager' : 'Authorized user';
}

/** Renders one member row: role, status, phone, and — for an authorized user — their limit
 * with set-limit + delete controls. A pending invite also shows its demo accept code. */
function renderMember(siteId: string, member: SiteRoleRow, demoCode: string | undefined): string {
  const safePhone = escapeHtml(member.invitedPhone ?? 'linked account');
  const safeRole = escapeHtml(roleLabel(member.role));
  const safeStatus = escapeHtml(member.status);
  const demoHtml = demoCode ? renderDemoInviteCode(demoCode) : '';

  let controls = '';
  if (member.role === 'authorized_user') {
    const limitText =
      member.maxAuthorizationCents === null ? 'none' : formatCents(member.maxAuthorizationCents);
    const limitAction = `/manager/sites/${encodeURIComponent(siteId)}/roles/${encodeURIComponent(
      member.id,
    )}/limit`;
    const deleteAction = `/manager/sites/${encodeURIComponent(siteId)}/roles/${encodeURIComponent(
      member.id,
    )}/delete`;
    controls = `
            <span class="member-limit">Limit: ${escapeHtml(limitText)}</span>
            <form class="inline-form" method="post" action="${escapeHtml(limitAction)}" data-manager-form>
              <label>New limit (cents)
                <input name="max_authorization_cents" required inputmode="numeric" maxlength="9" autocomplete="off" />
              </label>
              <button type="submit">Update limit</button>
            </form>
            <form class="inline-form" method="post" action="${escapeHtml(deleteAction)}" data-manager-form>
              <button type="submit">Delete</button>
            </form>`;
  }

  return `
          <li class="member">
            <span class="member-phone">${safePhone}</span>
            <span class="member-role">${safeRole}</span>
            <span class="member-status">${safeStatus}</span>${controls}${demoHtml}
          </li>`;
}

/** Renders one pending over-limit approval with an Approve control (SDD §10). */
function renderApproval(approval: PendingApprovalView): string {
  const safeBathroom = escapeHtml(approval.bathroomLabel);
  const safePhone = escapeHtml(approval.requesterPhone ?? 'a requester');
  const safeAmount = escapeHtml(formatCents(approval.approval.amountCents));
  const action = `/manager/approvals/${encodeURIComponent(approval.approval.id)}/approve`;
  return `
          <li class="approval">
            <span class="approval-bathroom">${safeBathroom}</span>
            <span class="approval-requester">${safePhone}</span>
            <span class="approval-amount">${safeAmount}</span>
            <form class="inline-form" method="post" action="${escapeHtml(action)}" data-manager-form>
              <button type="submit">Approve hold for ${safeAmount}</button>
            </form>
          </li>`;
}

function renderManagedSite(
  entry: ManagedSite,
  approvals: readonly PendingApprovalView[],
  demoCodes: ReadonlyMap<string, string>,
): string {
  const { site } = entry;
  const safeName = escapeHtml(site.name);
  const safeAddress = escapeHtml(site.address);
  const membersHtml =
    entry.members.length === 0
      ? '<li class="empty">No members yet.</li>'
      : entry.members.map((m) => renderMember(site.id, m, demoCodes.get(m.id))).join('');
  const siteApprovals = approvals.filter((a) => a.approval.siteId === site.id);
  const approvalsHtml =
    siteApprovals.length === 0
      ? '<li class="empty">No requests awaiting approval.</li>'
      : siteApprovals.map((a) => renderApproval(a)).join('');
  const inviteAction = `/manager/sites/${encodeURIComponent(site.id)}/invites`;
  return `
      <section class="card site">
        <h3>${safeName}</h3>
        <p class="subtitle">${safeAddress}</p>
        <h4>Members</h4>
        <ul class="members">${membersHtml}</ul>
        <h4>Requests awaiting approval</h4>
        <ul class="approvals">${approvalsHtml}</ul>
        <h4>Invite a member</h4>
        <form class="stack-form" method="post" action="${escapeHtml(inviteAction)}" data-manager-form>
          ${renderPhoneField('Phone')}
          <label>Role
            <select name="role" required>
              <option value="authorized_user">Authorized user</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <label>Authorization limit in cents (authorized users only)
            <input name="max_authorization_cents" inputmode="numeric" maxlength="9" autocomplete="off" />
          </label>
          <button type="submit">Send invite</button>
        </form>
      </section>`;
}

/**
 * Renders the console: every Site the caller manages, its members, pending
 * over-limit approvals, and an invite form. `demoCodes` maps a pending invite's
 * SiteRole id to its single-use accept code (SDD §6.3); it is empty (and nothing
 * extra renders) unless DEMO_MODE is on.
 */
export function renderManagerConsole(
  sites: ManagedSite[],
  csrfToken: string,
  approvals: readonly PendingApprovalView[] = [],
  demoCodes: ReadonlyMap<string, string> = new Map(),
): string {
  const sitesHtml =
    sites.length === 0
      ? '<p class="muted-note">You are not an authorized manager at any site yet.</p>'
      : sites.map((entry) => renderManagedSite(entry, approvals, demoCodes)).join('');
  const bodyHtml = `
      <header class="page-header">
        <h1>Site Manager</h1>
        <p class="subtitle">Invite managers and authorized users, set their limits, and approve over-limit requests.</p>
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
