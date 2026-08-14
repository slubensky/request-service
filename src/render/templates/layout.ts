import { escapeHtml } from '../escape.js';

export interface LayoutOptions {
  /** Page title, rendered inside <title> and escaped. */
  title: string;
  /** Server-rendered body markup. Callers are responsible for escaping any
   * untrusted values before composing this string. */
  bodyHtml: string;
  /**
   * Module scripts to load at the end of <body>. Defaults to the shared
   * progressive-enhancement entry point. Pass `[]` for a zero-JS page (the
   * public visitor page ships no client script -- AGENTS.md perf budget).
   */
  scripts?: readonly string[];
  /**
   * Session-bound CSRF token to expose to same-origin scripts via a meta tag.
   * Only rendered for authenticated pages whose enhancement submits mutations
   * (e.g. the admin console); omitted entirely on public pages.
   */
  csrfToken?: string;
}

const DEFAULT_SCRIPTS: readonly string[] = ['/js/main.js'];

/**
 * Base HTML document shell shared by every page. No client framework: the only
 * scripts loaded are vanilla ES modules for progressive enhancement, and the
 * default set is a single tiny entry point. A page may opt out of all scripts.
 */
export function renderLayout({ title, bodyHtml, scripts, csrfToken }: LayoutOptions): string {
  const safeTitle = escapeHtml(title);
  const scriptList = scripts ?? DEFAULT_SCRIPTS;
  const csrfMeta =
    csrfToken === undefined
      ? ''
      : `\n    <meta name="csrf-token" content="${escapeHtml(csrfToken)}" />`;
  const scriptTags = scriptList
    .map((src) => `\n    <script type="module" src="${escapeHtml(src)}"></script>`)
    .join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>${csrfMeta}
    <link rel="stylesheet" href="/css/base.css" />
  </head>
  <body>
    <main id="app">
      ${bodyHtml}
    </main>${scriptTags}
  </body>
</html>
`;
}
