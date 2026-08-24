import { renderLayout } from './layout.js';

/**
 * Renders the home page. Reached directly by an anonymous visitor, or as the
 * post-login landing spot for a signed-in user who holds no role anywhere
 * (resolvePostLoginDestination) -- a company_admin/manager/authorized_user
 * lands on their own console/page instead (SDD §3, §6). `signedIn` picks
 * between the two: an anonymous visitor gets a sign-in prompt, a signed-in
 * no-role user gets told to contact an administrator, not the same copy.
 */
export function renderHomePage({ signedIn }: { signedIn: boolean }): string {
  const bodyHtml = signedIn
    ? `
      <header class="page-header">
        <h1>Request Service</h1>
      </header>
      <section class="card">
        <p>You don't have access to any site yet. Contact your administrator.</p>
      </section>
  `
    : `
      <header class="page-header">
        <h1>Request Service</h1>
        <p class="subtitle">QR bathroom cleaning.</p>
      </header>
      <section class="card">
        <p><a href="/auth/login">Sign in</a> to get started.</p>
      </section>
  `;
  return renderLayout({ title: 'Request Service', bodyHtml });
}
