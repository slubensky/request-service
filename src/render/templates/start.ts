import { renderLayout } from './layout.js';

/**
 * Post-login landing page for an authorized_user (resolvePostLoginDestination):
 * they hold no console of their own -- their whole role is requesting a
 * cleaning by scanning a bathroom's QR code (or an NFC tag encoding the same
 * URL), which lands them on GET /s/:token (src/public/routes.ts), not here.
 * This page is purely instructional.
 */
export function renderStartPage(): string {
  const bodyHtml = `
      <header class="page-header">
        <h1>Request Service</h1>
      </header>
      <section class="card">
        <p>Tap the NFC tag or scan the QR code in the bathroom to request service.</p>
      </section>
  `;
  return renderLayout({ title: 'Request Service', bodyHtml });
}
