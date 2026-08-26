# Phase 2 — Cleaning Request + Payment Authorization (Mocked Gateway) — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document first").
> Scope: the "authorize now" half of the payment lifecycle (SDD §9.1 steps 1-3) for an
> authorized Manager or Assistant, plus Company-Admin capture/cancel. **Mocked payment
> gateway only — no Stripe SDK, no live keys, no real card collection.** Human-gated merge.

## Goal

Close the loop the Blueprint calls "the heart of the system" far enough to demo and test
the full state machine, without pulling in Stripe yet (explicit direction: Phase 2 and
Phase 3 are both mock-only; Stripe integration itself is a later, separate task):

1. A Manager or authorized Assistant who scans a bathroom's QR **while signed in** sees the
   server-derived fixed price and can place a hold (SDD §9.1 steps 1-2).
2. A Company Admin can capture or cancel an outstanding hold (SDD §9.1 step 3).
3. The hold is created against a `PaymentGateway` interface with an in-memory mock
   implementation standing in for Stripe's manual-capture PaymentIntent semantics, so the
   real Stripe SDK can be swapped in later behind the same interface with no call-site
   changes.

## Non-negotiable constraints

- **Mock, not fake-safe-to-ship.** The mock gateway is clearly named and documented as a
  stand-in; nothing about it should read as production-ready. No real money can move
  through this phase under any configuration.
- **Reuse** `authorize()` / `authorizeAction` / `authorizeOrReject` — no parallel authz
  path. `create_cleaning_request`, `capture_payment`, `cancel_payment` already exist in the
  matrix (`src/auth/authorize.ts`) with the right role/status/scope semantics; this phase
  wires routes to them, it does not change the matrix.
- **Price is server-derived** (SDD §8): the amount used for both the authorization check and
  the hold is read from `Site.fixed_price_cents` server-side; nothing client-submitted is
  trusted for the amount.
- **Authorization precedes any side effect** (SDD §7): the site/bathroom/price lookup needed
  to build the `Action` is read-only and happens first; the gateway call and DB writes only
  happen after `authorize()` allows.
- **No oracle for a caller without site authority.** The existing `GET /s/:token` neutral
  page stays byte-for-byte unchanged for anyone who is not an authorized Manager/Assistant
  at the resolved site — public visitors, customers, pending assistants, a manager at a
  different site. Only a caller who already holds authorized site authority sees a
  different (price-confirmation) response for that site's own QR.
- Use the merged schema as-is (`cleaning_requests`, `payment_authorizations` already exist,
  unused until now). No migration.
- Spec-first, test-first, no secrets, no framework, no bundler.

## Design

### `src/payments/gateway.ts` — the swap seam

```ts
export interface PaymentGateway {
  authorize(input: { amountCents: number; idempotencyKey: string }): Promise<{ gatewayId: string }>;
  capture(gatewayId: string): Promise<void>;
  cancel(gatewayId: string): Promise<void>;
}
```

`MockPaymentGateway` implements this with no network calls: `authorize` always succeeds
(there is no real card collection in this phase, so there is nothing that could decline)
and returns an id prefixed `mock_pi_` so it is never mistaken for a real Stripe id in logs,
tests, or the admin UI. `capture`/`cancel` are no-ops on the gateway side — our own
`payment_authorizations.status` column (checked before ever calling the gateway) is what
actually prevents an invalid transition like double-capture, exactly as it will once a real
`StripeGateway` replaces this one.

### `src/payments/service.ts`

- `createCleaningRequest(db, gateway, { siteId, bathroomId, requestedByUserId, amountCents })`
  — calls `gateway.authorize`, then inserts `CleaningRequest` (`status=authorized`) and
  `PaymentAuthorization` (`status=requires_capture`) only after the hold succeeds (SDD
  §9.1 step 2: a failed authorization creates neither row). `amountCents` is supplied by
  the caller, which resolved it server-side moments earlier for the authorization check —
  never re-trusted from the client, never re-derived a second, possibly-inconsistent way.
- `listPendingCaptures(db)` — outstanding (`requires_capture`) authorizations for the
  Company Admin console, joined to their request.
- `captureCleaningRequest` / `cancelCleaningRequest(db, gateway, paymentAuthorizationId)` —
  reload the row, reject if not `requires_capture`, call the gateway, then update both the
  `PaymentAuthorization` and `CleaningRequest` rows.

`price_version` is recorded as `1` for every request in this phase (no price-history
mechanism exists yet — `price:manage` is defined in the matrix but has no route, matching
the project's existing pattern of documenting unwired-but-specified capabilities). Revisit
when price editing ships.

### Routes

- `GET /s/:token` (`src/public/routes.ts`, amended) — resolves the token as today, then, if
  the caller has a valid session **and** an authorized Manager/Assistant SiteRole at the
  resolved site **and** the amount is within their `max_authorization_cents`, renders a
  price-confirmation page instead of the neutral page. Everyone else — including an
  authenticated identity with no authority there — gets the unchanged neutral page.
- `POST /s/:token/authorize` (new) — re-resolves the token and price server-side, gates on
  `create_cleaning_request` via `authorizeAction`, then calls `createCleaningRequest`.
- `GET /admin/payments`, `POST /admin/payments/:id/capture`, `POST /admin/payments/:id/cancel`
  (new, `src/admin/routes.ts`) — Company-Admin-only console over `listPendingCaptures` /
  `captureCleaningRequest` / `cancelCleaningRequest`, gated the same way every other admin
  mutation is (`authorizeOrReject`, CSRF already enforced globally).

### Gateway wiring

A single `PaymentGateway` instance is constructed once in `buildRouter` (`src/server/app.ts`)
and passed to both `registerPublicRoutes` and `registerAdminRoutes` — capture/cancel must
observe the same gateway an authorization went through. Both registration functions accept
it as an injectable parameter (default `new MockPaymentGateway()`), mirroring the existing
injectable-rate-limiter pattern in `registerManagerRoutes`, so tests can share one instance
across an authorize-then-capture flow.

## Explicitly out of scope for this phase

- Real Stripe SDK, webhooks, live keys, Payment Element / card collection.
- Assistant one-time approval (Phase 4) — a pending assistant scanning still sees the
  neutral page, unchanged; the matrix already denies `create_cleaning_request` for a
  `pending` status.
- Automatic expiry-to-void and its operational alert (inherently webhook/scheduler-driven
  against a real Stripe integration).
- Repeat-request / duplicate-request guard (Phase 3).
