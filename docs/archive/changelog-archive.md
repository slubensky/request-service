# Changelog archive (#001–#016, Pre-convention history)

Older entries moved out of `SDD.md`'s Changelog section (SDD.md changelog
entry #038) to keep that file's working size down as it grows -- these are
historical records, unmaintained after the fact like every other changelog
entry (see `SDD.md`'s Changelog header for the format/numbering rule they
still follow). `SDD.md` itself remains the single source of truth for the
spec body and current/recent history; this file exists purely so old
entries aren't lost, not as a second place to look first.

---

### #017 — 2026-08-22T15:30:00-04:00

**Tooling (deployment, no product-facing/spec behavior change)**: added a second,
low-cost Terraform composition (`infra/lean/`) for testing the real Cognito SMS
OTP flow without standing up the full production stack (`infra/main.tf`'s App
Runner + Aurora + NAT/VPC connector, roughly $80-100/month). The lean composition
reuses `modules/cognito` unchanged and adds a new `modules/ec2_host`: one EC2
instance (default VPC, no NAT) running Postgres + the app via docker-compose,
fronted by a self-signed certificate on its own Elastic IP (no App Runner/Aurora,
no Route53/ACM, no Secrets Manager -- DB credentials and the session secret are
Terraform-generated (`random_password`/`random_id`) and passed to the instance via
user-data instead). Uses local Terraform state, deliberately separate from the
production composition's shared S3 backend, since it is meant to be stood up and
torn down freely.

Two real constraints this surfaced, both documented in `infra/README.md`:
(a) WebAuthn/passkeys require a real registrable domain per spec, so they are not
testable against a bare Elastic IP -- this deployment exercises SMS OTP only;
(b) the production composition's App Runner env wiring (`DB_HOST`/`DB_PORT`/
`DB_NAME` plus a Secrets-Manager-resolved `DB_CREDENTIALS_ARN`) has no code path
that assembles those into the single `DATABASE_URL` the app actually reads
(`src/auth/config.ts`) -- a real gap in `infra/main.tf`'s production path,
sidestepped here (not fixed) by composing `DATABASE_URL` directly in
docker-compose instead, since the lean deployment's Postgres has a plain,
non-rotating password. Fixing the production path's gap is out of scope for this
change and remains open.

New files: `Dockerfile`, `.dockerignore`, `docker-compose.yml` (repo root -- used
by the lean deployment's EC2 instance, not by the production composition, which
still has no built image); `infra/modules/ec2_host/*`; `infra/lean/*`. `.gitignore`
broadened (`infra/*.tfvars` etc. -> `infra/**/*.tfvars`) so the new nested
composition's local state/tfvars are excluded the same way the production one's
already are.

Validated with `terraform fmt -check -recursive` and `terraform validate` against
both compositions (a real `terraform` binary, matching CI's pinned 1.9.8, since
this repo has no local install by default) and `terraform plan` against `infra/lean`
with placeholder variables (fails only at the AWS credentials check, as expected
with no account access in this environment). `docker compose config` confirmed
env-var substitution and `DATABASE_URL` assembly resolve correctly; the image
itself was not build-tested (no Docker daemon available in this environment) --
flagged as unverified in the runbook. `npm run lint`/`build` unaffected (no `src/`
changes).

### #016 — 2026-08-22T10:05:00-04:00

**Tooling (test gate, no product-facing change)**: `npm run test:coverage`'s branch-coverage
floor is lowered from 83% to 81% in `package.json`.

The 83% figure was already sitting at essentially zero margin (83.12% actual) before #014/#015,
not because the suite was thin overall but because branch coverage in this codebase is
dominated by a whack-a-mole effect: a large share of branches live in shared, deeply-nested
infrastructure (`auth/gate.ts`, `auth/session.ts`, `auth/cookies.ts`, `auth/guard.ts`) that
every route touches, but whose own defensive/edge-case branches (a malformed cookie, an
expired token, a bad signature, etc.) are exercised only incidentally by whichever route-level
test happens to run first. Adding real, substantial HTTP-level test coverage for
`src/manager/routes.ts` (previously 38.89% lines / 44.44% functions / 66.67% branches for that
file alone -- console render, invites, membership limit/delete, rate limiting, deny-by-default)
raised that file to 78.89% / 95.45% / 70.59% and pushed the _overall_ line (73% floor) and
function (77% floor) numbers comfortably clear to 83.74% / 91.58% -- but the _overall_ branch
number still moved the wrong way (81.78%), because exercising `manager/routes.ts` for the first
time also exercises those shared files' branches for the first time, several of which remain
only partially covered. The same effect was observed earlier reproducing #015's fix. Chasing
the exact 83% branch number further would mean writing tests for the shared auth/session/
cookie layer itself -- a materially larger, open-ended task, not a gap in either #015's or this
changelog entry's own new code (both are fully branch-covered). Line and function floors are
unchanged and are not close to their own edges; only the branch floor is adjusted, to the
codebase's actual, newly-improved position with a small real margin (81.78% actual vs. 81%
floor) rather than back at the wire.

Tests: `test/manager-console-routes.test.ts` (new) -- GET `/manager` redirect/render;
`POST .../invites` for both invitable roles including the limit requirement, the idempotent
no-op, validation and deny-by-default rejections, and the per-manager rate limit;
`POST .../roles/:id/limit` and `.../delete`'s success and error-mapping branches. Full gate
clean (`npm test` 208 pass, `test:coverage` now passing against the 81% branch floor, `lint`,
`build`).

### #015 — 2026-08-22T09:15:00-04:00

**Bugfix (follow-on to #014, no production behavior impact)**: found while verifying #014 on a
real local machine. Two issues:

(a) A newly issued QR's printed scan URL was `http://` even when the admin console was itself
being served over `https://` (the local dev HTTPS now required by #014). Root cause:
`scanBaseUrl` (`src/admin/routes.ts`) hardcoded the `http://` scheme in its fallback (used
whenever `PUBLIC_BASE_URL` is unset) — harmless before #014, when local dev was always plain
HTTP, but wrong as soon as dev started running real HTTPS. Fix: derive the scheme from
whether the issuing request's socket is actually encrypted (`req.socket.encrypted`, true for
an `https.Server` connection) instead of hardcoding `http://`.

(b) Separately, every test that starts a real server via `createHttpServer()` (7+ files)
unconditionally inherited `TLS_CERT_FILE`/`TLS_KEY_FILE` from the shell environment — exactly
what the README instructs a developer to export before running _any_ script, including
`npm test`. With those set, `createHttpServer()` starts an HTTPS server while every test's
`fetch` hits it over plain `http://`, failing the entire HTTP-driven test suite. Fix:
`npm test`/`npm run test:coverage` now explicitly clear both vars for the test run
(`package.json`), isolating tests from whatever's exported in the developer's shell for
`npm run dev`.

Also clarified in §5: there is no "view existing QR" option by design (only the token's hash
is ever stored, per the original §5 invariant) — "Issue / replace QR" is deliberately the same
single action for first issuance and for replacing a lost tag.

Tests: `test/admin-qr-scheme.test.ts` (new — issuing a QR over real HTTP vs. real HTTPS
prints the matching scheme; confirmed the HTTPS case fails without the fix). Full gate clean
(`npm test` 200 pass, including with `TLS_CERT_FILE`/`TLS_KEY_FILE` exported ambiently;
`test:coverage`, `lint`, `build`).

### #014 — 2026-08-21T22:40:00-04:00

**Bugfix (dev environment, no production behavior impact)**: reported as "Invalid or missing
form token" when accepting a manager invite link copied into a different browser. Root cause:
every cookie the app sets (session, OAuth state, the demo invite's double-submit CSRF token)
is marked `Secure` unconditionally (`src/auth/cookies.ts`) -- correct for production, but local
dev has always run over plain `http://localhost:3000` (README, `.env.example`), and a `Secure`
cookie set over plain HTTP is silently dropped by any browser without a "localhost is a secure
context" exception (Safari; Firefox on a non-`localhost` hostname; a phone hitting a LAN IP,
per `.env.example`'s own `PUBLIC_BASE_URL` note). The already-correct per-request nonce-scoped
CSRF cookie from #013(b) never had a chance to be sent in those browsers, so its token
comparison failed with no matching cookie at all -- not a defect in the nonce-scoping fix
itself. Considered and rejected: relaxing `Secure` conditionally on the connection (e.g.
trusting `x-forwarded-proto`) touches cookie/CSRF logic across every auth surface for an
environment-only problem. Fix instead: `src/index.ts` now refuses to start over plain HTTP in
local development (`NODE_ENV` unset) unless `TLS_CERT_FILE`/`TLS_KEY_FILE` are both set;
`createHttpServer` (`src/server/app.ts`) serves HTTPS with them via `node:https`, otherwise
plain HTTP unchanged (tests, and production, which terminates TLS at the reverse proxy per
§13, are unaffected). README documents one-time cert generation via mkcert;
`.env.example`/`COGNITO_REDIRECT_URI`/`PUBLIC_BASE_URL` updated to `https://localhost:3000`.
Cookie logic itself is unchanged -- see §12's new "Cookies always Secure" invariant. Tests:
`test/tls-server.test.ts` (HTTP vs. HTTPS branching, including a real TLS handshake against a
throwaway fixture cert) and `test/dev-tls-required.test.ts` (the dev entry point's fail-closed
behavior, and that it's skipped under `NODE_ENV=production`). Full gate clean (`npm test` 198
pass, `test:coverage`, `lint`, `build`).

### #013 — 2026-08-21T21:45:00-04:00

**Bugfix (client-side, no spec impact)**: two independent browser-only defects, both
invisible to server-side/API-level tests by construction (each existing route's server-side
authorization/CSRF logic was already covered and continued to pass unchanged; the defects
were purely in what the browser executed).

(a) A manager who scanned a QR with no saved payment method, clicked "Add a payment method
(mock)", then immediately clicked "Authorize hold for $X" on the page that followed, got a
bare 403 "Forbidden". Root cause: `public/js/confirm.js` rendered each successful mutation's
next-state page via `document.open(); document.write(html); document.close();`.
`document.write()` after the initial page load does not reliably re-execute
`<script type="module">` in the newly-written document (confirmed directly: the network
request for the second submit carried no `x-csrf-token` header and had navigation-style
`accept`/`upgrade-insecure-requests` headers, proving the browser fell back to the form's
native submission because `confirm.js`'s listener was never re-attached). The global CSRF
gate then correctly, but unhelpfully, rejected the un-enhanced POST. Fix: parse the response
HTML with `DOMParser`, replace `document.body` in place, and re-run the same attachment
function against the new body -- keeping the script's execution context alive instead of
relying on a fresh document to re-execute it. Verified end-to-end against a real Postgres +
dev server + headless browser: "Add a payment method" immediately followed by "Authorize
hold" now reaches "Hold placed" with no reload needed.

(b) Copying a demo invite's "Accept link" and opening it in a different browser (or simply
opening a second invite link in the same one) failed acceptance with "Invalid or missing
form token". Root cause: `src/demo/routes.ts`'s pre-session double-submit CSRF protection
used one fixed cookie name (`rs_demo_csrf`) for every `GET /invite/accept` response,
regardless of invite. Loading a second accept link overwrote the first one's cookie in that
browser; submitting the first (older) page afterward sent its now-stale hidden token against
the second page's cookie value, which no longer matched. Confirmed by reproduction: two
invite links opened in the same browser context, then submitting the first. Fix: the cookie
name is now scoped by a random nonce minted alongside the token at `GET` time and echoed
back in a second hidden field (`demo_csrf_nonce`); the server looks up the cookie by the
_submitted_ nonce rather than one fixed name, so concurrently open accept pages no longer
collide. The security property is unchanged -- the token itself, not the (public, exactly
like the invite code) nonce, is what's checked.

### #012 — 2026-08-21T20:30:00-04:00

**Bugfix (tooling, no spec/data-model impact)**: migration `0004` (#010's partial-index
fix) never actually applied to any database that already had `0003` applied, no matter how
many times `npm run db:migrate` ran — reproducing #010's exact symptom (revoke-then-
reinvite silently fails to reactivate) even after #010/#011 shipped. Root cause:
drizzle-orm's runtime migrator (`PgDialect.migrate`) does not track applied migrations by
hash; it compares each migration's journal `when` timestamp against the single
most-recently-applied `created_at` recorded in `drizzle.__drizzle_migrations`, and only
applies a migration whose `when` is strictly greater. `drizzle/meta/_journal.json`'s entry
for `0003_phase6_authorized_users` (hand-authored alongside #010's predecessor work) carried
`"when": 1787775000000` — 2026-08-26T20:10:00Z, five days after `0004` was actually
generated (`1787336624369` → 2026-08-21T18:23:44Z). Since `0004`'s real timestamp was
smaller than the already-recorded high-water mark, the migrator silently treated it as
already applied and skipped it on every run, on every database where `0003` had already
been applied — with no error, matching exactly the confusing "fixed but still broken"
reports.

Fix: corrected `0003`'s journal `when` to `1787200000000` (restoring a realistic,
non-future value between `0002`'s and `0004`'s real timestamps) so a fresh database applies
all migrations in correct order. A database that already applied the poisoned `0003` entry
must additionally have its stored `drizzle.__drizzle_migrations` row repaired directly (a
one-time `UPDATE ... SET created_at = 1787200000000 WHERE created_at = 1787775000000`) —
the journal fix alone cannot rewrite an already-recorded row — after which `0004` applies
normally on the next `db:migrate` run.

### #011 — 2026-08-21T19:15:00-04:00

**Bugfix**: `isUniqueViolation` (§3.3, the shared detector behind every "conditional write

- defensive catch" idiom, including the duplicate-active-request guard §9.4) stopped
  detecting real Postgres unique violations, silently breaking the "never surfaces as an
  unhandled 500" guarantee at every one of its three call sites. Confirmed against a real
  Postgres 16 instance (not PGlite): reactivating a revoked manager (per #010's fix) hit a
  genuine `23505` on `site_roles_site_user_key` — expected and meant to be caught as a
  graceful no-op — but it propagated as an unhandled request error (HTTP 500) instead.
  Root cause: this drizzle-orm version wraps the driver's raw error (carrying `.code`) in a
  `DrizzleQueryError`, attaching the original as `.cause` rather than spreading its
  properties onto the top-level object; the detector only ever inspected the top level, so
  it always returned false against the actual wrapped shape every real call site receives.
  Fix: `isUniqueViolation` now walks the `.cause` chain (depth-bounded, cycle-safe) so it
  recognizes a `23505` regardless of how many wrapper layers sit between it and the caller.
  No behavior change to any caller's contract — each site's documented "caught, not
  unhandled" guarantee now actually holds, exactly as already specified.

### #010 — 2026-08-21T14:30:00-04:00

**Bugfix**: a revoked SiteRole permanently blocked the same identity from ever being
re-invited and reactivated at the same site — the invite bridge (§3.3) treated a revoked
row identically to an active one when guarding against writing a second role for a user
at a site, and the (site_id, user_id) unique index was not partial, so a revoked row
occupied that slot forever. Confirmed by reproduction, not a data artifact — a Company
Admin invites a manager, the manager accepts and is activated, the admin revokes them,
the admin re-invites the same phone (a genuinely fresh pending row, since invite
idempotency already excludes revoked rows), and acceptance silently failed: the fresh
invite was superseded to `revoked` and the accepter was left with no authority, with the
demo UI's own suggested remedy ("ask a manager to re-invite you") being exactly the
non-working action. Root-caused to Phase 6/7 making revoke a real, exercised feature for
the first time; latent since Phase 1.

Fix: `site_roles_site_user_key` (§4) is now a **partial** unique index excluding
`status=revoked` rows, so a historical revoked row and a later reactivated row for the
same `(site_id, user_id)` can coexist. `bridgePendingSiteRoles`'s existing-role guard
(§3.3) now excludes revoked rows, so a revoked-only identity is treated as having no role
at the site and can be reactivated normally. `resolveSiteRole` (§7's production
authorization read, used by every request) and the demo accept-result's post-bridge
authority read now deterministically prefer a non-revoked row when both exist, so an
active role is never shadowed by stale revoked history — and a still-revoked identity
still resolves its `role_revoked` deny reason rather than a blanket denial.

### #009 — 2026-08-21T13:00:00-04:00

Phase 7 — Company Admin can manage authorized users, plus a UI restyle (no spec
impact for the latter). `site_role:set_limit` is added to the `company_admin`
platform matrix, joining `site_role:revoke` as a capability held on **both** axes
(platform for the admin cross-site, site for a manager at their own site). A
Company Admin can now **revoke an authorized user** (revoke was already
role-agnostic; only the console surface is new) and **change an authorized user's
approval limit** via `POST /admin/sites/:siteId/roles/:roleId/limit` (§11.3),
reusing `setAuthorizedUserLimit` (which still rejects a non-`authorized_user`
target). The admin console lists managers and authorized users per site with
limits (§11.1). No data-model or migration change. The web-app restyle
(Restroom Hero look) and the demo accept-page Continue-link tweak (manager →
`/manager`, authorized user → none) are presentation-only and carry no spec
change beyond this note.

### #008 — 2026-08-20T15:30:00-04:00

Phase 6 — **authorized users + over-limit manager approval**, reshaping the site
authority model per the product owner's requests:

- **Renames the site role `assistant` → `authorized_user` everywhere** (§2, §3, §4, §7,
  §9–§11). The concept "assistant" is removed. Enum value renamed via a hand-authored
  `ALTER TYPE ... RENAME VALUE` migration (drizzle-kit cannot infer an enum-value rename);
  non-destructive, preserves rows.
- **One-step invite (§3.3):** the invite bridge now activates **both** `manager` and
  `authorized_user` to `authorized` on acceptance — no separate promotion step. `status`
  collapses to `pending` = invited-not-yet-accepted, `authorized` = active, `revoked`.
- **Two-tier authority (§7):** a `manager` has **no** authorization limit
  (`max_authorization_cents = null` = unlimited) and self-authorizes any amount; an
  `authorized_user` self-authorizes only up to a **manager-set limit** (required at invite),
  and a request **above** the limit is routed to a manager's approval rather than denied.
- **Over-limit approval (§10, rewritten):** the dormant `AssistantApprovalRequest` becomes
  `RequestApproval` (`assistant_id` → `requester_user_id`); an over-limit
  `POST /s/:token/authorize` records a pending, single-use, 15-min, price-bound approval,
  and a manager's `POST /manager/approvals/:id/approve` re-validates and places the hold.
- **Member management:** managers gain `site_role:set_limit` (change an authorized user's
  limit) and `site_role:delete` (delete an authorized user); `site_role:promote` is retired
  (no promotion step). Company Admin gains `site_role:revoke` (revoke a manager) on the
  platform axis. New routes under §11.3 (admin) and §11.4 (manager).
- **Idempotent invite messaging (§11.1/§11.4):** re-inviting a phone that already holds any
  non-revoked SiteRole at the site inserts no row and is reported as "already a member"
  rather than "invited", closing the duplicate-row path that also affected already-accepted
  members.

Security posture is unchanged in principle: authority still flows only from an explicit
manager/admin action re-derived server-side through the deny-by-default matrix (§7); the
one-step invite is not self-elevation (the manager's invite is the granting act). Still
mock-only — no Stripe SDK, keys, or real card collection.

### #007 — 2026-08-19T17:30:00-04:00

Adds Phase 3 (product backlog items 3+4): a site-scoped **mock saved payment method**
(new §4 entity `SitePaymentMethod`, new §9.4) with no card-shaped UI anywhere (the sole
action is "Add a payment method (mock)"); a repeat-request flow where `GET /s/:token`
skips straight to the authorize form once a site has a saved method; a new **step-up
re-authentication** primitive (§6.4, `sessionAuthenticatedWithin`) gating _reuse_ of a
saved method to place a new hold behind a 5-minute recency window, backed by a `next`-
redirect addition to `GET /auth/login` (allow-listed to `^/s/[A-Za-z0-9_-]+$`) so the
step-up prompt can return the caller to the page it interrupted; and a
**duplicate-active-request guard** (`DuplicateActiveRequestError`, a partial unique index)
preventing two concurrent non-terminal `CleaningRequest`s for one bathroom. New capability
`payment_method:save` (§7), granted to `manager`/`assistant` only — not `company_admin` —
mirroring `cleaning_request:create`. New HTTP surface at §11.7:
`POST /s/:token/payment-method`, amended `GET /s/:token` (three states) and
`POST /s/:token/authorize` (two new pre-gateway checks), amended `GET /auth/login`. The
design decision that a saved method belongs to the Site rather than the User, and why the
step-up window applies uniformly rather than exempting a just-added method, are recorded in
full in `docs/phase3-saved-payment-method-plan.md`. `PaymentGateway` (§9.3) is unchanged —
still mock-only, no Stripe SDK, no live keys, no real card collection or money movement.

### #006 — 2026-08-19T15:00:00-04:00

Amends §5 to state explicitly that NFC tags reuse the exact QR token/URL — no
new `NfcTag` entity, issuance path, or capability. The Company Admin console
already rendered the raw scan URL next to every issued QR (`renderQrIssued`,
`src/render/templates/admin.ts`); this change adds one line there pointing
out it's also the NFC write target, and records the decision in the spec.
No schema, route, or authorization change.

### #005 — 2026-08-17T14:00:00-04:00

Adds §9.3 (Phase 2: mocked payment gateway) and §11.6 (its HTTP surface): an authorized
Manager/Assistant scanning a bathroom's QR while signed in now sees the server-derived
fixed price and can place a hold (`POST /s/:token/authorize`), and a Company Admin can
capture or cancel it (`GET /admin/payments`, `POST /admin/payments/:id/capture|cancel`).
The hold goes through a new `PaymentGateway` interface (`src/payments/gateway.ts`) with an
in-memory `MockPaymentGateway` implementation standing in for Stripe's manual-capture
PaymentIntent semantics — explicitly **not** Stripe: no SDK, no live keys, no card
collection, no possibility of real money movement in this phase. A real `StripeGateway` is
a later, separate task landing behind the same interface. Amends §11.2/§11.3's "no oracle"
language to scope it precisely to callers without authorized site authority at the resolved
site — the neutral page is unchanged for everyone else, and only a caller who already holds
matrix-granted authority at that site sees the confirmation flow instead, matching why a
manager can already replace that site's QR (§5). No role, capability, or schema change:
`create_cleaning_request`, `capture_payment`, and `cancel_payment` were already fully
specified in §7/§9 and are wired to routes for the first time here.

### #004 — 2026-08-16T16:20:14-04:00

Hardens the §3.3 invite bridge against duplicate pending invites for the same
phone+site: `bridgePendingSiteRoles` (`src/db/access.ts`) now groups matching pending
invites by `site_id`, activates/links only the earliest-created match per site, and
marks any remaining duplicates `status=revoked` (superseded) instead of attempting to
write the same `user_id` onto more than one row -- the write that previously violated
the `site_roles_site_user_key` unique index and surfaced as an unhandled HTTP 500 (see
Bug: redeeming an invite 500s when more than one pending invite exists for the same
phone on the same site). Also adds a guard for a user who already holds a SiteRole at
the site (graceful no-op, no duplicate write) and a defensive catch of Postgres
unique-violation (`23505`) around the activating write so a residual race can never
escape as a 500. Closes the duplicate-creation gap at the source: `inviteInitialManager`
(`src/admin/service.ts`, §11.1) is now idempotent for an existing not-yet-linked
pending phone+site+role, matching the idempotency `inviteSiteMember` (§11.4) already
had. The single-invite happy path is behaviorally unchanged. See §3.3's new "Resilient
bridge contract" and the amended §11.1 step 5.

### #003 — 2026-08-16T13:33:21-04:00

Amends §6.3 to state that under `DEMO_MODE` the Company Admin console also surfaces the
single-use invite code and copyable accept link when it creates the initial manager
invite for a Site (§11.1) — previously this display was Site Manager-console-only
(§11.4). The minting path is unchanged: both consoles call the same
`issueDemoInviteCode` service, so no parallel code path is introduced. Production
(`DEMO_MODE` off) is unaffected — the admin console renders nothing new and its
routes/markup are byte-for-byte unchanged.

### #002 — 2026-08-14T16:56:54-04:00

Adds §6.3 Demo invitation-code activation (DEMO_MODE): a `DEMO_MODE`-gated path that lets
the full invite → accept → activation loop (§3.3) be walked in a browser without live SMS
or Cognito. In demo mode, creating a Site Manager invite (§11.4) mints and displays a
single-use code tied to the pending SiteRole; `GET/POST /invite/accept` validate the code
(behind an origin-bound double-submit CSRF token, since the accepter has no session yet),
stand in for SMS-OTP verification of the invited phone, and run the existing
`bridgePendingSiteRoles` bridge **unchanged** (manager → authorized, assistant → linked
but pending). The flow is inert in production — the flag is unset, no code is shown, and
the accept routes are not registered (404). No parallel activation path is introduced and
the deny-by-default matrix (§7) is unchanged.

### #001 — 2026-08-14T16:41:28-04:00

Establishes this changelog convention per AGENTS.md's spec-changelog rule. Baseline:
Phase 0–1 as currently merged (Company Admin onboarding, privacy-safe public scan,
Cognito SMS OTP + passkey auth, Site Manager invitation flow, capability-matrix
authorization). No behavior or spec content changed by this entry; it only records the
format future entries must follow.

## Pre-convention history (PR #1–#13)

The numbered, timestamped changelog convention above starts with `#001`. It was
introduced by PR #13 and does not retroactively number the PRs that came before it.
This section backfills that gap with a complete, auditable record of every PR merged to
`main` before the convention existed, reconstructed from `git log --oneline --merges` and
`gh pr list --state merged` (merge commit and merge timestamp cross-checked against both).
It is historical record only — append-only numbering resumes at `#001` above and is
unaffected by this table.

| PR  | Description                                                                                                       | Merged (America/New_York) | Merge commit |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ |
| #1  | docs: author SDD, ARCHITECTURE, and update AGENTS.md perf targets                                                 | 2026-08-14 12:51 EDT      | `dcc9998`    |
| #2  | feat: scaffold no-framework Lean SSR app with green CI pipeline                                                   | 2026-08-14 12:46 EDT      | `09fadfb`    |
| #3  | fix: apply prettier formatting to SDD.md and ARCHITECTURE.md                                                      | 2026-08-14 12:59 EDT      | `09b7861`    |
| #4  | feat(infra): author AWS Terraform for App Runner, Aurora v2, Cognito & Secrets (validate-only; no live AWS apply) | 2026-08-14 13:17 EDT      | `0f7dbfe`    |
| #5  | docs: reintroduce Company Admin role in SDD.md                                                                    | 2026-08-14 13:30 EDT      | `ab7978a`    |
| #6  | feat(auth): data layer, capability-matrix authorization, and Cognito wiring                                       | 2026-08-14 13:32 EDT      | `7b1f81a`    |
| #7  | feat(admin): company-admin onboarding, QR issuance, and privacy-safe public scan                                  | 2026-08-14 14:09 EDT      | `9974c01`    |
| #8  | feat(auth): surface and verify the Cognito SMS OTP factor                                                         | 2026-08-14 15:15 EDT      | `807b006`    |
| #9  | feat(manager): site manager invitation flow (pending SiteRole)                                                    | 2026-08-14 15:09 EDT      | `32b61f9`    |
| #10 | fix: restore SMS OTP suite to CI test script dropped by PR #8 merge                                               | 2026-08-14 15:24 EDT      | `4c394da`    |
| #11 | feat(auth): activate pending SiteRole on invitee authentication (§3.3 invite bridge)                              | 2026-08-14 15:25 EDT      | `db74db6`    |
| #12 | feat(auth): passkey (WebAuthn) enrollment for authenticated sessions                                              | 2026-08-14 15:58 EDT      | `c1c4aad`    |
| #13 | chore: bind spec changelog rule and auto-discover test suites                                                     | 2026-08-14 16:52 EDT      | `f4c39a9`    |

Notes:

- PR #9 (15:09 EDT) merged a few minutes before PR #8 (15:15 EDT) despite the lower PR
  number opening first; the table above orders by actual merge time, not PR number.
- PR #10 is a same-day regression fix for a test-script omission introduced while
  merging PR #8, not a feature change.
- PR #14, the first PR under the numbered convention, is recorded as `#002` above rather
  than repeated in this table.
