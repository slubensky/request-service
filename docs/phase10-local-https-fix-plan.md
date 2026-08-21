# Phase 10 — Fix: demo invite accept fails on a different browser ("Invalid or missing form token") — Plan

> Required by AGENTS.md (plan before a >5-step task, and explicit approval before executing it).

## Bug: accepting a manager invite link in a different browser fails with "Invalid or missing form token"

Reported: as an admin, inviting a manager and opening the "Accept link" in a different browser
than the one that generated it fails on submit with "Invalid or missing form token".

### Root cause

Every cookie the app sets (`src/auth/cookies.ts`'s `serializeCookie`) is marked `Secure`
unconditionally -- correct for production, but local dev has always run over plain
`http://localhost:3000` (README, `.env.example`). A `Secure` cookie set over plain HTTP is
silently dropped by any browser without a "localhost is a secure context" exception (Safari;
Firefox on a non-`localhost` hostname; a phone hitting a LAN IP, per `.env.example`'s own
`PUBLIC_BASE_URL` note). The demo invite's already-correct per-request nonce-scoped CSRF cookie
(SDD changelog #013(b)) never reaches the server in those browsers, so its token comparison
fails with no cookie present at all -- not a defect in that fix itself. This is an environment
problem (dev never runs real HTTPS), not specific to the invite flow: the session cookie itself
would fail the same way in an affected browser.

### Fix

Considered and rejected: relaxing `Secure` conditionally on the connection (e.g. trusting
`x-forwarded-proto`) touches cookie/CSRF logic across every auth surface to fix an
environment-only problem. Instead:

- `src/index.ts` refuses to start over plain HTTP in local development (`NODE_ENV` unset/not
  `production`) unless `TLS_CERT_FILE`/`TLS_KEY_FILE` are both set -- fail closed, matching
  AGENTS.md's secure-defaults rule, rather than silently falling back to a broken HTTP mode.
- `createHttpServer` (`src/server/app.ts`) serves HTTPS via `node:https` when those two env
  vars are set, otherwise plain HTTP unchanged -- so tests (neither var set) and production
  (TLS terminated at the reverse proxy, SDD §13) are unaffected.
- README documents one-time local cert generation via [mkcert](https://github.com/FiloSottile/mkcert).
- `.env.example` adds `TLS_CERT_FILE`/`TLS_KEY_FILE` and updates `COGNITO_REDIRECT_URI`,
  `COGNITO_LOGOUT_REDIRECT_URI`, and `PUBLIC_BASE_URL` to `https://`, with a note that a phone
  scanning a LAN QR code needs to trust the machine's mkcert root CA.
- Cookie logic (`cookies.ts`, `demo/routes.ts`, `auth/routes.ts`) is unchanged. SDD §12 gets a
  new "Cookies always Secure" invariant naming this as the reason local dev requires real TLS.

## Files

- `src/server/app.ts` -- `createHttpServer` HTTPS branch.
- `src/index.ts` -- fail-closed TLS requirement for local dev.
- `.env.example`, `README.md`, `scripts/dev-login.ts` -- mkcert setup + `https://` URLs.
- `SDD.md` -- changelog #014 + §12 invariant.
- `test/tls-server.test.ts`, `test/dev-tls-required.test.ts`, `test/fixtures/tls/*` -- new tests
  and a throwaway self-signed test fixture (not a real credential).

## Tests

- `test/tls-server.test.ts`: `createHttpServer` returns a plain `http.Server` when the TLS env
  vars are unset (today's behavior) and an `https.Server` that completes a real TLS handshake
  when both are set, against a fixture cert.
- `test/dev-tls-required.test.ts`: the dev entry point exits 1 with the expected message when
  TLS vars are missing outside production, starts successfully when they're set, and skips the
  check entirely under `NODE_ENV=production`.
- Full gate: `npm test` (198 pass), `npm run test:coverage` (floors met), `npm run lint`,
  `npm run build`.

## Out of scope

Any change to cookie/CSRF logic itself, and any change to how production terminates TLS.
