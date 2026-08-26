# Phase 3 — Saved (Mock) Payment Method + Repeat-Request Step-Up — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document first").
> Scope: product backlog items 3 + 4 — mock up saving a payment method for the first time,
> and let a subsequent request from the same site reuse it, gated by step-up
> re-authentication. Plus a duplicate-active-request guard. **Still mock-only — no Stripe
> SDK, no live keys, no real card collection.** Builds directly on Phase 2
> (`docs/phase2-payment-authorization-plan.md`), which this phase amends rather than
> replaces.

## Goal

1. An authorized Manager/Assistant with no saved payment method for their site can add one
   — a **mock** record only, never a real-looking card-entry field.
2. Once a site has a saved method, a later request from that site skips straight to
   "Authorize hold" instead of asking to add a method again.
3. Reusing a saved method to place a **new** hold requires the session to have
   authenticated (or re-authenticated) within a short recency window — a genuine step-up
   control, not a formality — before the hold is created.
4. A bathroom can never have two concurrent, non-terminal `CleaningRequest`s (double-tap
   protection), rejected cleanly (409) before any gateway call.

## Non-negotiable constraints

- **No card-shaped UI, even mocked.** No free-text PAN/CVV/expiry field anywhere, even a
  fake one — that pattern is exactly what gets copy-pasted into a real-money path later.
  The only UI surface is a single "Add a payment method (mock)" button that creates a
  synthetic record server-side.
- **Reuse the existing seams.** `authorizeAction`/`authorizeOrReject` (deny-by-default
  matrix) for every mutation; `createAppForRuntime`/`createHttpServer` for real-HTTP tests;
  no parallel authorization path, no parallel session/CSRF path.
- **Price stays server-derived** (SDD §8); this phase does not touch pricing.
- **Step-up is a real gate, enforced server-side on the mutating request**, not just hidden
  in the UI — `POST /s/:token/authorize` independently re-checks recency every time,
  exactly like it already independently re-checks price and authority.
- Spec-first, test-first, no secrets, no framework, no bundler.

## Design decision — who owns a saved payment method: Site or User?

**Decision: the Site.** A saved (mock) payment method belongs to `Site`, not to the
individual `User` who added it.

Rationale:

- Product reality: this is a facilities/cleaning expense the business site pays for, not a
  staff member's personal card. The bill should follow the bathroom's site regardless of
  which authorized Manager or Assistant happened to be the one who tapped "add."
- The rest of the payment model is already site-scoped: `Site.fixed_price_cents` is the
  price, `CleaningRequest`/`PaymentAuthorization` are billed against the site's fixed price,
  and `max_authorization_cents` bounds what a SiteRole may authorize **at that site**. A
  per-user card would be a new, inconsistent billing axis alongside an already-established
  site-level one.
- Turnover safety: if a per-user card were used and that Assistant were later revoked, a
  site-scoped hold-authoring capability would suddenly have no funding source, or worse, an
  ex-employee's mock "card" would silently keep working for other staff at the site. A
  site-owned record has no such dangling-identity failure mode.
- Least surprise for a Company Admin: `GET /admin/payments` already reports holds by site;
  a site-scoped payment method keeps "who pays for this site's cleanings" a single,
  inspectable fact instead of one that varies by which staff member is currently signed in.

This is recorded in SDD §4 (`SitePaymentMethod` entity) and §9.4.

## Design decision — step-up re-authentication window

**Decision: 5 minutes, keyed off the existing session's `iat` (issued-at) — no new state.**

- The signed session (`src/auth/session.ts`) already carries `iat`, stamped at the moment
  Cognito authentication completed (`/auth/callback`, both the SMS-OTP and passkey paths —
  §6.1, §6.2). Every full authentication event — including a passkey re-assertion or a
  fresh OTP — re-issues the session cookie with a fresh `iat`. That is exactly "time of
  last authentication," so it needs no new column, no new cookie, and no new state: a new
  `sessionAuthenticatedWithin(session, windowSeconds)` predicate in `src/auth/guard.ts` is
  sufficient.
- **The gate applies uniformly to every `POST /s/:token/authorize` against an existing
  saved method — including the very first authorize immediately after saving it in the same
  visit.** We deliberately do not special-case "just-added" vs. "older" methods: a uniform
  rule is simpler, easier to verify, and closes a potential loophole where a step-up
  requirement could be sidestepped by re-adding a (mock) method right before an otherwise
  stale-session authorize. The cost is a minor UX rough edge (a brand-new session that is
  already >5 minutes old when the user finishes adding the method will be asked to
  re-authenticate once more before the hold goes through); this is judged an acceptable,
  conservative trade for a genuine security control per the task brief ("not a formality").
- **Adding** a payment method (`POST /s/:token/payment-method`) is _not_ gated by recency —
  only _placing a hold against_ a saved method is. This matches the literal scope of the
  requirement ("reusing a saved method to place a new hold") and does not create a
  money-movement bypass: adding a mock record moves no money and creates no obligation by
  itself; only `POST /s/:token/authorize` does, and that call is always gated.
- On a stale session, `GET /s/:token` renders a "please re-authenticate" state (a link to
  `/auth/login?next=/s/:token`) instead of a live authorize button, and
  `POST /s/:token/authorize` independently re-checks the same condition and returns `401`
  if it does not hold — the UI state is a convenience, not the enforcement point.
- **New: `next` redirect on `GET /auth/login`.** Today the Cognito callback always redirects
  to `/`. To make step-up re-authentication actually usable, `GET /auth/login` now accepts
  an optional `next` query parameter; if it matches a strict allow-list shape
  (`^/s/[A-Za-z0-9_-]+$` — exactly the QR scan path shape, nothing else, no scheme, no
  protocol-relative `//`), it is stored in a new short-lived HttpOnly cookie
  (`rs_oauth_return_to`, same lifetime as the existing `rs_oauth_state` cookie) and
  `GET /auth/callback` redirects there instead of `/` once authentication completes. Any
  value that does not match the allow-list is ignored (falls back to `/`) — this is a
  narrow, purpose-built allow-list, not a general open-redirect surface.
  `GET /auth/passkey/register` does not accept `next` (out of scope — it is a pure identity
  action per §6.2) and clears the cookie so a stale value can never leak into that flow.

## Design decision — duplicate-active-request guard

A bathroom must never have two concurrent non-terminal `CleaningRequest`s
(`status` ∈ {`authorizing`, `authorized`}; terminal = `completed`/`canceled`/`expired`).
Guarded two ways, mirroring the existing "conditional write + defensive catch" idiom this
codebase already uses for the §3.3 invite bridge (`bridgePendingSiteRoles`,
`src/db/access.ts`):

1. **Read-check first** in `createCleaningRequest` (`src/payments/service.ts`): before ever
   calling the gateway, look for an existing `authorizing`/`authorized` request for the same
   `bathroomId`; if found, throw `DuplicateActiveRequestError` and make no gateway call and
   no write.
2. **Partial unique index as the race backstop**: a new partial unique index,
   `cleaning_requests_bathroom_active_key` on `(bathroom_id)` `WHERE status IN
('authorizing', 'authorized')`, makes a true double-tap race (two requests passing the
   read-check concurrently) impossible to write twice at the database level. A resulting
   Postgres unique-violation (`23505`) on the insert is caught and re-thrown as the same
   `DuplicateActiveRequestError` — never surfaced as an unhandled 500, exactly like the
   existing `isUniqueViolation` handling in `db/access.ts` (now exported and reused here
   instead of duplicated).

The route (`POST /s/:token/authorize`) maps `DuplicateActiveRequestError` to a clean `409`.

## Schema changes

- **`site_payment_methods`** (new table, `src/db/schema.ts`): `id`, `site_id` (FK → sites,
  **unique** — at most one saved method per site in this phase), `gateway_token` (mock only,
  prefixed `mock_pm_`), `display_label` (fixed mock string, e.g. `"Mock Visa •••• 4242"` —
  never a real-looking free-text PAN), `created_by_user_id` (FK → users, audit only),
  `created_at`.
- **`cleaning_requests_bathroom_active_key`**: new partial unique index (see above). No
  column changes to `cleaning_requests`.

Both are additive; `npm run db:generate` produces the migration, no manual SQL authored by
hand beyond what drizzle-kit emits from the schema diff.

## Capability matrix changes (`src/auth/authorize.ts`)

- New capability `payment_method:save`, new action `{ type: 'save_payment_method'; siteId }`.
- Granted to `manager` and `assistant` in `SITE_ROLE_CAPABILITIES` — the same role set (and
  same `authorized`-status requirement, enforced by the existing matrix machinery) that
  already holds `cleaning_request:create`. Rationale: adding the mock method is tightly
  coupled to placing a hold, and the SDD's existing model already lets an authorized
  Assistant place holds, not just a Manager.
- **Not** granted to `company_admin` (platform axis) — a Company Admin does not request
  cleanings and does not authorize card holds (§2, §9.1), so it should not seed a site's
  payment method either; consistent with the existing exclusion.
- No other matrix change. This is a new leaf capability, not a rewrite of `authorize()`.

## Routes (`src/public/routes.ts`, amended + new)

- **`GET /s/:token`** (amended again): for a caller who already clears
  `create_cleaning_request` (unchanged Phase 2 gate — site authority + within
  `max_authorization_cents`), the page now renders one of three states instead of always the
  authorize form:
  1. **No saved method** → "Add a payment method (mock)" form
     (`POST /s/:token/payment-method`).
  2. **Saved method + session authenticated within the last 5 minutes** → the existing
     authorize form, now also showing the saved method's mock display label.
  3. **Saved method + stale session** → a "please re-authenticate" state with a link to
     `/auth/login?next=/s/:token`; no authorize button rendered.
     Everyone without site authority still gets the byte-identical neutral page — unchanged.
- **`POST /s/:token/payment-method`** (new): requires session + CSRF (existing global gate),
  re-resolves the token, gates on `save_payment_method`, then creates the site's saved
  method via `saveSitePaymentMethod`. `409` if one already exists (clean, not a parallel
  create path). On success, renders whichever of states 2/3 above now applies (reuses the
  same state-selection helper as the `GET` handler) — so "add, then authorize" is two clicks
  with no full page navigation, without pre-emptively skipping the step-up check.
- **`POST /s/:token/authorize`** (amended): after the existing `create_cleaning_request`
  gate, two new checks before any gateway call: `409` if the site has no saved method yet
  ("Add a payment method before authorizing a hold"), then `401` if the session is not
  within the recency window ("Re-authentication required"). Then calls
  `createCleaningRequest` as before; a `DuplicateActiveRequestError` maps to `409`.

`src/auth/routes.ts` gains the `next`-redirect handling described above; no new route paths
there, only amended `GET /auth/login` / `GET /auth/callback` behavior.

## Client-side (`public/js/confirm.js`, amended)

The existing fetch-based form submission already distinguishes ok vs. not-ok responses. It
now special-cases `401`: instead of an `alert`, it redirects the browser to
`/auth/login?next=<current path>` so the step-up flow in the design above is actually
reachable from the UI. Every other non-ok status keeps the existing `alert` behavior. No
bundler, no framework, still a small vanilla ES module.

## Explicitly out of scope for this phase

- Real Stripe SDK/keys/webhooks — still mock-only, unchanged from Phase 2.
- Storing more than one saved method per site, or a "replace saved method" flow — a second
  `POST /s/:token/payment-method` for a site that already has one is rejected `409`, not
  silently overwritten. A future phase can add explicit replace/remove if needed.
- Threading the saved method's mock token into `PaymentGateway.authorize()` — the interface
  (`src/payments/gateway.ts`) is untouched. The mock gateway needs no card reference at all
  today, and speculatively plumbing one through now (before a real gateway exists to
  consume it) would be exactly the kind of premature abstraction AGENTS.md warns against;
  it is deferred to whenever the real `StripeGateway` lands.
- NFC tags, AWS/real-Cognito deployment — unrelated, already handled elsewhere.
- Phase 4 (assistant one-time approval) and Phase 5 (promotion/revocation, deploy).
