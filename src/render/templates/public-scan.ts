import { renderLayout } from './layout.js';

/**
 * The neutral public scan page (see SDD.md §11.2). Rendered for every
 * `GET /s/:token`, byte-for-byte identical whether the token is active,
 * revoked, or unknown, and whether or not the site has an activated manager --
 * so it can never act as an oracle for token validity or operational state.
 *
 * It deliberately reveals NOTHING: no price, billing status, manager identity,
 * request queue, or history. It is static, hand-authored copy with no dynamic
 * interpolation, so there is no untrusted value to escape and no per-scan
 * variation to leak. It ships zero client JS (AGENTS.md public-page budget).
 */
export function renderPublicScanPage(): string {
  const bodyHtml = `
      <header class="page-header">
        <h1>Restroom care</h1>
        <p class="subtitle">Thanks for helping keep this space clean.</p>
      </header>
      <section class="card">
        <p>If this restroom needs attention, please notify on-site staff.</p>
        <p class="muted-note">Site staff can arrange cleaning. There is nothing to submit or pay here.</p>
      </section>
  `;
  return renderLayout({ title: 'Restroom care', bodyHtml, scripts: [] });
}
