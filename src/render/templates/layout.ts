import { escapeHtml } from '../escape.js';

export interface LayoutOptions {
  /** Page title, rendered inside <title> and escaped. */
  title: string;
  /** Server-rendered body markup. Callers are responsible for escaping any
   * untrusted values before composing this string. */
  bodyHtml: string;
}

/**
 * Base HTML document shell shared by every page. No client framework: the
 * only script loaded is a vanilla ES module for progressive enhancement.
 */
export function renderLayout({ title, bodyHtml }: LayoutOptions): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="stylesheet" href="/css/base.css" />
  </head>
  <body>
    <main id="app">
      ${bodyHtml}
    </main>
    <script type="module" src="/js/main.js"></script>
  </body>
</html>
`;
}
