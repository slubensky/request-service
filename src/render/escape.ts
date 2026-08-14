/**
 * Escapes untrusted text for safe interpolation into HTML element content.
 * Every template must run dynamic values through this before embedding them;
 * static, hand-authored markup is fine as literal template text.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
