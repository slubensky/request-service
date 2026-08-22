import { createHttpServer } from './server/app.js';

const port = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';
const hasTls = Boolean(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);

// Local dev must run over real HTTPS, not just http://localhost: cookies are unconditionally
// Secure (SDD §12), and a browser without a "localhost is a secure context" exception (Safari,
// non-"localhost" hostnames, a phone on the LAN) silently drops them over plain HTTP -- see SDD
// changelog #014. Production skips this: TLS terminates at the reverse proxy (SDD §13), so
// Node itself stays plain HTTP there by design.
if (!isProduction && !hasTls) {
  // eslint-disable-next-line no-console -- fail-closed startup diagnostic.
  console.error(
    'Refusing to start over plain HTTP in local development: cookies are always Secure and a ' +
      'non-Chromium browser silently drops them without real TLS. Set TLS_CERT_FILE and ' +
      'TLS_KEY_FILE (see README "Local development" -- generate them with mkcert) and retry.',
  );
  process.exit(1);
}

let server: ReturnType<typeof createHttpServer>;
try {
  server = createHttpServer();
} catch (error) {
  // eslint-disable-next-line no-console -- fail-closed startup diagnostic.
  console.error(
    `Could not start with TLS_CERT_FILE=${process.env.TLS_CERT_FILE ?? '(unset)'} ` +
      `TLS_KEY_FILE=${process.env.TLS_KEY_FILE ?? '(unset)'}:`,
    error,
  );
  process.exit(1);
}

server.listen(port, () => {
  // eslint-disable-next-line no-console -- startup log is expected operational output.
  console.log(`request-service listening on ${hasTls ? 'https' : 'http'}://localhost:${port}`);
});
