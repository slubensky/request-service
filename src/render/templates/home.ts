import { renderLayout } from './layout.js';

/**
 * Renders the scaffold home page. This is a placeholder for the eventual
 * QR-scan entry point (see SDD.md); it exists in this PR only to prove the
 * SSR pipeline (router -> template -> HTML response) end to end.
 */
export function renderHomePage(): string {
  const bodyHtml = `
      <header class="page-header">
        <h1>Request Service</h1>
        <p class="subtitle">QR bathroom cleaning, scaffolded.</p>
      </header>
      <section class="card">
        <p>This is the SSR scaffold. No client framework, no bundler.</p>
      </section>
  `;
  return renderLayout({ title: 'Request Service', bodyHtml });
}
