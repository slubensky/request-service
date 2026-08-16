/**
 * Shared demo invite-code markup (SDD §6.3), DEMO_MODE only.
 *
 * Both consoles that can create an invite -- the Site Manager console
 * (src/render/templates/manager.ts) and the Company Admin console
 * (src/render/templates/admin.ts) -- render the exact same single-use code +
 * copyable accept link through this one function, so the markup never drifts
 * between the two call sites. Rendered only when a code is present for the
 * invite (DEMO_MODE on); callers omit it entirely when DEMO_MODE is off.
 */
import { escapeHtml } from '../escape.js';

/** Renders the single-use accept code and its copyable `/invite/accept` link. */
export function renderDemoInviteCode(code: string): string {
  const safeCode = escapeHtml(code);
  const acceptLink = `/invite/accept?code=${encodeURIComponent(code)}`;
  return `
            <span class="invite-code">Code: <code>${safeCode}</code></span>
            <a class="invite-accept-link" href="${escapeHtml(acceptLink)}">Accept link</a>`;
}
