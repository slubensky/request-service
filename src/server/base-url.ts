/**
 * The externally-reachable base URL for this request: an explicit env
 * override, else the request host with the scheme the request actually
 * arrived over -- never hardcoded, so it matches whichever of plain HTTP or
 * HTTPS this process is actually serving (SDD §5, changelog #015). Shared by
 * every route that builds a link a user will actually click: printed QR codes
 * (src/admin/routes.ts) and invite SMS (src/admin/routes.ts,
 * src/manager/routes.ts).
 */
import { getEnv } from '../config/env.js';
import type { RouteContext } from './router.js';

/** True when this request arrived over a real TLS connection (an `https.Server`'s socket is a
 * `tls.TLSSocket`, which carries `.encrypted`; a plain `http.Server`'s socket does not). */
function isEncryptedConnection(req: RouteContext['req']): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function publicBaseUrl({ req }: RouteContext): string {
  const configured = getEnv('PUBLIC_BASE_URL');
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const host = req.headers.host ?? 'localhost';
  const scheme = isEncryptedConnection(req) ? 'https' : 'http';
  return `${scheme}://${host}`;
}
