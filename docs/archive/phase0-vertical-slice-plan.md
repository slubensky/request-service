# Phase 0 Vertical Slice — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document first").
> Scope: company-admin onboarding + privacy-safe public QR scan page. Human-gated merge.

## Goal

Ship the Phase 0 vertical slice on top of the merged data layer + capability-matrix
authorization (PR #6):

1. **Company-admin onboarding** (platform-level operator, `User.platform_role=company_admin`
   — never a Site Manager): create a Site with a fixed price (cents), add Bathrooms,
   issue opaque QR tokens (store the one-way hash only), and invite the initial Site
   Manager (a pending `manager` SiteRole).
2. **Privacy-safe public resolution page**: scanning a QR renders a neutral "see staff"
   page. No price, billing, identity, queue, or history; no Stripe PaymentIntent; and a
   scan of a not-yet-activated site must not disclose that the site lacks a manager.

## Non-negotiable constraints

- **Reuse** the deny-by-default matrix in `src/auth/authorize.ts`. Every onboarding action
  is gated through `authorize()` on `platform_role=company_admin`. No hardcoded role
  branches, no parallel authz path. Company Admin is cross-site and never a SiteRole.
- Use the merged Drizzle schema **as-is**. No new migration is needed — every column the
  slice writes already exists (sites, bathrooms, qr_tokens, users, site_roles).
- No framework, no bundler. Mobile-first SSR; the public page ships ~0 KB JS.
- Spec-first, test-first, no secrets in code.

## Design

### Authorization enforcement (`src/auth/enforce.ts`)

`authorizeAction(db, userId, action)` resolves the principal (platform role always;
SiteRole only when the action targets a site) from stored rows scoped to the authenticated
user id, then delegates to the pure `authorize()` core. This is the single reused seam;
routes never branch on role directly.

### QR tokens (`src/qr/tokens.ts`, `src/qr/image.ts`)

- `generateOpaqueToken()` — 32 crypto-random bytes, base64url. High-entropy and opaque.
- `hashToken(raw)` — SHA-256 hex. Only the hash is persisted (`qr_tokens.token_hash`).
- `resolveActiveQrToken(db, raw)` — hashes the presented token and looks up an **active**
  row by the unique `token_hash` index; returns the bathroom/site or null. Revoked or
  unknown tokens resolve to null.
- `renderQrSvg(url)` — wraps the `qrcode` library to emit an inline SVG (no binary asset,
  no client JS). `qrcode` is the blueprint-sanctioned server-side QR dependency.

Issuing a new token revokes any prior active token for the bathroom (revocable/replaceable).

### Onboarding service (`src/admin/service.ts`)

Pure data operations over Drizzle: `createSite`, `addBathroom`, `issueQrToken`,
`inviteInitialManager` (pending `manager` SiteRole keyed by invited phone, `user_id` null
until the invitee authenticates), and `listSitesWithBathrooms` for the console.

### Routes

- `src/admin/routes.ts` — `GET /admin` console + `POST` onboarding endpoints. Each handler:
  read session -> resolve+authorize via `authorizeAction` -> 403 on deny -> act. State-
  changing requests additionally pass the existing session-bound CSRF guard (header token);
  `public/js/admin.js` submits forms via `fetch` with the `x-csrf-token` header.
- `src/public/routes.ts` — `GET /s/:token`. Rate-limited hash resolution, then an invariant
  neutral page regardless of validity (no oracle). No DB write, no Stripe call.

### Rate limiting (`src/server/rate-limit.ts`)

Minimal in-memory fixed-window limiter (injectable clock) applied to the public scan route,
satisfying the "resolution is rate-limited" invariant without a new dependency.

## Tests (node:test)

- `test/qr.test.ts` — token entropy, hash stability, raw token never equals hash,
  resolve active/revoked/unknown.
- `test/admin.test.ts` — onboarding denied for a plain member, allowed for company_admin
  (through the matrix); service persists rows; QR stored hashed (raw never stored); invite
  creates a pending manager SiteRole.
- `test/public-scan.test.ts` — HTTP: neutral page contains no price/billing/identity/queue/
  history fields, issues no PaymentIntent, and is identical for an activated vs
  not-yet-activated (manager-less) site and for an unknown token.
- `test/rate-limit.test.ts` — window allows N then blocks, resets after the window.
- `test/admin-routes.test.ts` — HTTP: unauthenticated onboarding POST is refused; a
  company_admin with a valid session + CSRF token creates a site.

## Out of scope (intentionally deferred)

- Interactive public alert POST: the global CSRF guard requires a session, and an anonymous
  state-changing endpoint is a spam/CSRF surface. The PublicAlert affordance is deferred
  rather than weaken complete mediation. Documented in SDD.
- Cognito login is unchanged; the slice does not add auth flows.
- Payments, assistant approval, promotion/revocation — later phases.
