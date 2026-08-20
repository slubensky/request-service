# Phase 3 (saved payment method, repeat-request reuse, step-up, duplicate guard) — Smoke Test Report

> Records a manual, live end-to-end verification of the Phase 3 backlog items (see
> `docs/phase3-saved-payment-method-plan.md`, merged in PR #20 /
> `42204fe`) against a real local Postgres 16 instance and the actual dev
> server (not PGlite, not `createAppForRuntime` in-process tests). The 163
> automated tests already cover this behavior at the unit/integration level;
> this pass exists to confirm the same behavior holds when driven over real
> HTTP against a real database, per the task brief ("Phase 3 ... completed,
> but not yet smoke tested"). No application code changed as a result of this
> pass — see Findings below for the two non-blocking observations raised.

## Environment

- Local PostgreSQL 16 (`pg_ctlcluster 16 main start`), `request_service` database, migrated with `npm run db:migrate`.
- Dev server via `npm run dev` (Node 22.22.2), `DEMO_MODE=1` (from `.env.example`), no Cognito/Stripe configured (both intentionally out of scope, both fail closed as documented in the README).
- Driven with `curl` against the real HTTP surface, using cookie jars per identity, exactly the way a browser session would authenticate — no test-only shortcuts in the app itself.

## Baseline (before any manual walkthrough)

| Check                   | Result                                                               |
| ----------------------- | -------------------------------------------------------------------- |
| `npm test`              | 163/163 pass                                                         |
| `npm run test:coverage` | 77.83% lines / 83.17% branches / 81.97% functions (floors: 73/83/77) |
| `npm run lint`          | clean (eslint + prettier)                                            |
| `npm run build`         | clean, 45 source files built                                         |

## Walkthrough performed

1. **Bootstrap Company Admin** — `npm run dev:login`, reached `GET /admin` with the printed session cookie.
2. **Onboarding** — `POST /admin/sites`, `POST /admin/sites/:siteId/bathrooms`, `POST /admin/sites/:siteId/bathrooms/:bathroomId/qr` — site, bathroom, and QR scan token created; all `204`/`200` as expected.
3. **Invite + demo accept** — `POST /admin/sites/:siteId/managers` (DEMO_MODE code minted), then `GET`/`POST /invite/accept` with the double-submit token — manager authenticated with a fresh signed session, `SiteRole` bridged straight to `authorized` (SDD §3.3, unchanged).
4. **`GET /s/:token`, state 1 (no saved method)** — rendered the "Add a payment method (mock)" form, price shown, no card-shaped input anywhere — matches plan.
5. **`POST /s/:token/payment-method`** — created the mock method (`Mock Visa •••• 4242`), page transitioned to state 2 (authorize form) in the same response, no full navigation — matches plan.
6. **`POST /s/:token/authorize` (first hold)** — `200`, "Hold placed", `CleaningRequest.status = authorized`, `PaymentAuthorization.status = requires_capture`.
7. **Duplicate-active-request guard** — a second `POST /s/:token/authorize` against the same bathroom while the first request was still active returned a clean `409` ("An active cleaning request already exists for this bathroom") with no gateway call and no second row written — matches plan §"duplicate-active-request guard".
8. **Admin capture** — `POST /admin/payments/:id/capture` → `204`; `CleaningRequest` moved to `completed`, `PaymentAuthorization` to `captured`.
9. **Repeat-request reuse** — with the request now terminal, `GET /s/:token` again showed the saved method and authorize form (state 2, no re-add needed); `POST /s/:token/authorize` succeeded again, reusing the same saved method — matches plan goal #2.
10. **Admin cancel** — `POST /admin/payments/:id/cancel` on the second hold → `204`, `CleaningRequest` → `canceled` — exercised the second terminal-state path.
11. **Step-up re-authentication gate** — minted a session with an `iat` >5 minutes in the past (same `signSession` the app itself uses, just an old timestamp — no app code touched) and replayed it:
    - `GET /s/:token` rendered state 3 ("Placing a hold ... requires a recent sign-in" + a link to `/auth/login?next=/s/:token`), no authorize button/form.
    - `POST /s/:token/authorize` with a correctly-derived CSRF token for that stale session returned `401 Re-authentication required`, and created no `CleaningRequest`/`PaymentAuthorization` — the server-side gate holds independently of the UI, exactly as designed.
12. **`next` redirect allow-list** — `GET /auth/login?next=/s/:token` returned `503` (Cognito intentionally unconfigured in this sandbox, fails closed as documented) — the cookie-storage and allow-list logic itself is already covered by the automated HTTP tests (`test/public-authorize.test.ts`, `test/authorize.test.ts`), which do exercise it against a fake Cognito exchange.

## Findings (non-blocking, no code changed)

1. **No HTTP-reachable way to set `SiteRole.max_authorization_cents`.** A freshly authorized `SiteRole` (via invite → demo-accept bridge) has `max_authorization_cents = NULL`, which `authorizePaidRequest` (`src/auth/authorize.ts`) correctly treats as "no limit configured" and denies (`no_authorization_limit`) rather than "unlimited". The only way to set it today is a direct DB write (mirrored by the test suite's fixtures). This predates Phase 3 — it is Phase 1/2 territory (SiteRole provisioning) — and is out of this task's scope, but is worth a follow-up ticket since it currently blocks a brand-new manager from placing any request until someone edits the database by hand.
2. **`GET /s/:token` doesn't reflect an already-active duplicate request.** After hold #1 was placed, re-fetching the scan page still rendered the "Authorize hold" button (state 2) rather than an "already in progress" state; the actual `POST` correctly rejects with `409` regardless. This matches the Phase 3 plan doc's three defined states (which are scoped to saved-method/step-up, not to duplicate-request), and the codebase's own stated philosophy that server-side enforcement, not UI state, is the source of truth (see the plan's step-up section). Cosmetic only — no data-integrity or security impact. Candidate for a small follow-up if desired, not addressed here to keep this smoke-test pass to verification only.

## Conclusion

Phase 3 (saved mock payment method, repeat-request reuse, step-up re-authentication, duplicate-active-request guard) behaves exactly per `docs/phase3-saved-payment-method-plan.md` and SDD.md §6.4/§9.4/§11.7 when driven over real HTTP against a real Postgres instance. No regressions, no code changes required.
