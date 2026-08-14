# Software Design Document — QR Bathroom Cleaning Service Request App

> **Last edited:** 2026-08-14 — reintroduced the platform-level **Company Admin** role, which an earlier edit had incorrectly dropped by asserting no admin role exists distinct from manager. This corrects §2–§5, §7, §9, §11, and §13 to match the original product spec: Company Admin is a cross-site internal operator (site/bathroom/QR/price creation, payment capture/cancel, initial-manager invite), while Site Manager remains site-scoped and cannot create sites or capture/cancel payments. Per AGENTS.md spec policy, edit date/time recorded here.

> **Last edited:** 2026-08-14 15:00 UTC — Phase 0 vertical slice: documented the concrete HTTP surface for Company Admin onboarding (§11.1) and the privacy-safe public scan endpoint (§11.2), and recorded that the optional public `PublicAlert` affordance is intentionally deferred for this slice (see §11.3). No role-model or data-model change; the slice reuses the merged schema and the deny-by-default capability matrix (§7) unchanged. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Last edited:** 2026-08-14 18:00 UTC — Phase 1, Manager invitation flow: documented the HTTP surface (§11.4) an authorized Site Manager uses to invite additional members (manager or assistant) to their own site, generalizing the Company Admin's initial-manager invite. Clarified §2 that a Manager also invites/promotes/revokes additional managers, not only assistants. No new capability, role, or migration — this reuses the `invite_site_role` / `site_role:invite` matrix entry (§7) and the existing SiteRole schema (§4) unchanged. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Status:** Approved for Phase 0 build; Phase 1 manager invitation flow in review. Source of truth for coders; mirrors the reviewed Blueprint (`art_RUHUe0PF`, v0.3).

## 1. Purpose & scope

### 1.1 Purpose

A mobile-first web app lets authorized site staff request a fixed-price bathroom cleaning by scanning a QR code, while a public scan can never create a payment obligation. A QR code identifies a bathroom only — it never authenticates a person, exposes payment data, or authorizes a card.

### 1.2 Problem

Site staff need a one-tap way to request a predefined-price cleaning at a specific bathroom. QR codes are public and copyable, so possession of a QR must grant no authority, and no public scan may ever start a charge.

### 1.3 Outcome

An authorized requester scans, authenticates passwordlessly, sees the exact fixed price, and places a temporary card hold. The card is captured only after cleaning is completed. Visitors get a neutral "notify staff" page only.

### 1.4 In scope (MVP)

- Site & bathroom setup.
- Unique QR generation and replacement.
- Passwordless authentication (SMS OTP + passkeys via Amazon Cognito).
- Site-scoped roles and deny-by-default authorization.
- Fixed-price display and confirmation.
- Stripe payment-method collection, manual-capture authorization, capture/cancel, and webhook processing.
- Assistant one-time approval and promotion.
- Public visitor alert (neutral, non-billable).

### 1.5 Out of scope (MVP) — non-goals

- Notification delivery as a hardened system (best-effort only in MVP).
- Rate limiting as a hardened system (basic protection only; not a dedicated subsystem).
- Dispatch/lifecycle tracking beyond the request states defined in this document.
- Variable pricing or bidding.
- Multi-service checkout (one fixed-price cleaning service only).
- Partial charges (capture is all-or-nothing up to the authorized amount).
- Customer self-service admin (no customer-facing account management).
- Native mobile apps.
- Offline operation.
- Scheduling or route planning for cleaning staff.

Any of the above may become in-scope in a later phase, but each requires a spec update before implementation, per AGENTS.md.

## 2. Actors & roles

| Actor                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Company Admin**             | Platform-level internal operator (`platform_role=company_admin`) — **not** a SiteRole, and not scoped to any single site. Creates and edits Sites and Bathrooms, issues/replaces QRTokens, sets and manages the fixed price (price versions), invites the _initial_ Manager for a new Site, and triggers payment capture/cancel (internal backend). Does **not** request cleanings and does **not** authorize card holds.            |
| **Manager**                   | Site-scoped (SiteRole `role=manager`). Requests cleaning and authorizes fixed-price holds at their site, approves assistant one-time requests, invites/promotes/revokes assistants **and additional managers** at their site, views full payment details for their site, and may replace the QR at their own site. **Cannot** create Sites or Bathrooms and **cannot** capture or cancel payments — those are Company Admin actions. |
| **Assistant**                 | Site staff invited by a manager. Has a SiteRole with status `pending` or `authorized`. Can initiate cleaning requests within their authorized limits once `authorized`; while `pending`, can only initiate a request that requires a manager's one-time approval.                                                                                                                                                                    |
| **Customer / public visitor** | Anyone who scans a bathroom QR and has no SiteRole for that site — whether unauthenticated or authenticated via Cognito. Sees only the neutral public page; can optionally leave a non-billable alert.                                                                                                                                                                                                                               |

No other roles exist in the MVP. There is no customer account tier.

## 3. Identity vs. authority (critical model)

This is the central security invariant of the system: **the system never decides authority from anything the person presents.**

- **Authentication** (Amazon Cognito) proves _who you are_ — a verified phone number or a registered passkey bound to a Cognito subject (`cognito_sub`).
- **Authorization** is one of two kinds, and both are deliberately separate from authentication:
  - A manager-created `SiteRole` proves _what you may do at a site_.
  - `platform_role=company_admin` proves _cross-site internal operator authority_, independent of any site. It is **provisioned internally** — seeded directly, or granted by an existing Company Admin — and is **never** obtained via self-service signup, a QR scan, or a Cognito login. The same identity-vs-authority principle applies: authenticating through Cognito never makes anyone a Company Admin.

These are deliberately separate systems, and authorization never follows automatically from authentication.

### 3.1 No self-service elevation

There is **no self-service path** from customer to assistant:

- Verifying a phone number or enrolling a passkey through Cognito never grants site authority. It only confirms identity.
- Possessing or scanning a QR code grants nothing — the QR resolves to a bathroom, not to a role.
- A member of the public who successfully authenticates through Cognito is still just a customer unless a manager has separately created a SiteRole for that identity at that site.

### 3.2 Resolution table

| Who                                   | What the server finds                                                                      | Can start a paid request?                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer / public visitor             | Authenticated (or anonymous) identity with **no SiteRole** for this site                   | No — neutral "see staff" page; optional non-billable alert                                                                                                                      |
| Invited assistant, not yet authorized | **Pending** SiteRole (`role=assistant, status=pending`) created by a manager inviting them | No self-authorize — can only initiate a request that needs a manager's one-time approval                                                                                        |
| Authorized assistant                  | `role=assistant, status=authorized`                                                        | Yes, within limits (`max_authorization_cents`)                                                                                                                                  |
| Manager                               | `role=manager`, active, with `max_authorization_cents`                                     | Yes, up to the authorized amount                                                                                                                                                |
| Company Admin                         | `platform_role=company_admin` (no SiteRole needed at any site)                             | No — does not request cleanings or authorize holds; instead creates Sites/Bathrooms, issues/replaces QR, sets price, invites the initial Manager, and captures/cancels payments |

### 3.3 The bridge: invite → pending → linked

1. A manager invites an assistant by identifier (e.g., phone number). This creates a **pending SiteRole** — a record that exists before the invitee has ever authenticated.
2. When the invitee authenticates that same identifier through Cognito (SMS OTP or passkey enrollment), the server links the pending SiteRole to the resulting Cognito subject / `User` record.
3. Only at that point does the invitee become a known-but-not-yet-authorized assistant (`status=pending`, now linked to an identity). A manager subsequently promotes them to `authorized` (see §9, Assistant workflow).
4. **No invite means no SiteRole means customer.** There is no code path that creates a SiteRole except an explicit manager action.

This bridge is the only route by which a SiteRole comes to exist for a given identity. It is never inferred from a QR scan, a Cognito login, or any client-submitted claim.

The same bridge bootstraps the very first Manager for a new Site: a **Company Admin** invites the initial Manager by identifier during onboarding, creating a pending `role=manager` SiteRole; when the invitee authenticates that identifier through Cognito, the server links it exactly as in steps 1–2 above. From that point forward, that Manager can invite/promote/revoke assistants at their own site — but only a Company Admin can create the next Site or invite the next Site's initial Manager.

## 4. Data model

All entities are stored in PostgreSQL (Aurora Serverless v2) via Drizzle ORM. Payment fields are references only — the system never stores raw card data. Identity is anchored to a Cognito subject, never to a password.

| Entity                       | Key fields                                                                          | Notes                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Site**                     | `name`, `address`, `timezone`, `currency`, `fixed_price_cents`, `terms`             | One billing configuration; owns Bathrooms.                                                                                                                        |
| **Bathroom**                 | `site_id`, `label`, `status`                                                        | Belongs to exactly one Site; at most one active QRToken.                                                                                                          |
| **QRToken**                  | `bathroom_id`, `token_hash`, `status`                                               | Stores a one-way hash of the token only; opaque and non-authorizing; replaceable/revocable.                                                                       |
| **User**                     | `cognito_sub`, `phone`, `status`, `platform_role`                                   | Identity anchored to a Cognito subject; no passwords stored. `platform_role` ∈ {member, company_admin}, default `member`.                                         |
| **SiteRole**                 | `user_id`, `site_id`, `role`, `status`, `max_authorization_cents`, `bathroom_scope` | Manager-created site authority; deny by default; distinguishes assistant from customer. `role` ∈ {manager, assistant}; `status` ∈ {pending, authorized, revoked}. |
| **CleaningRequest**          | `bathroom_id`, `price_version`, `amount_cents`, `status`                            | Exactly one payment authorization per request in the MVP.                                                                                                         |
| **PaymentAuthorization**     | `request_id`, `stripe_payment_intent_id`, `status`                                  | Manual-capture; created fresh per request; never reused.                                                                                                          |
| **AssistantApprovalRequest** | `site_id`, `bathroom_id`, `price_version`, `amount`, `assistant_id`, `expires_at`   | Single-use; 5–15 minute expiry; bound values invalidate the approval on change.                                                                                   |
| **PublicAlert**              | `bathroom_id`, `note`, `created_at`                                                 | Non-billable; no associated PaymentIntent or CleaningRequest.                                                                                                     |

### 4.1 Referential notes

- `SiteRole.user_id` may reference a `User` created before or after the invite — the pending SiteRole exists independent of the `User` row until the bridge (§3.3) links them.
- `User.platform_role` is **platform-level** authority (cross-site, e.g. `company_admin`), orthogonal to the **site-scoped** authority carried by `SiteRole`. A `User` may hold `platform_role=company_admin` with zero, one, or many SiteRoles — the two are independent axes. `SiteRole.role` remains ∈ {manager, assistant} in all cases; Company Admin is never itself a `SiteRole.role` value.
- `CleaningRequest.price_version` anchors the price used at authorization time so later `Site.fixed_price_cents` changes cannot retroactively alter an in-flight or historical request.
- `PaymentAuthorization` is 1:1 with `CleaningRequest` in the MVP (no partial charges, no multiple holds per request).

## 5. QR generation & resolution

- Tokens are **opaque, cryptographically random, non-sequential** — no bathroom ID, site ID, or other identifying structure is embedded in or derivable from the token.
- The server stores only a **one-way hash** of the token (never the raw token); resolution looks up the incoming scanned value by hash.
- QR resolution is **rate-limited** at the endpoint level to blunt brute-force enumeration (see AGENTS.md security rules on complete mediation and fail-safe defaults; hardened rate limiting is out of scope for MVP per §1.5).
- A **Company Admin** issues the initial QRToken for a Bathroom as part of onboarding (alongside creating the Site, Bathroom, and price). Tags are **revocable and replaceable**: a Company Admin can invalidate and reissue a QRToken for any Site, and a **Site Manager** may likewise replace the QRToken at their own site (e.g., a printed tag is lost or compromised), without any change to the Bathroom's identity or history.
- A resolved QRToken identifies a Bathroom **only**. It never authenticates a person and never itself authorizes any action — see §3 for why authority requires a separate SiteRole lookup.

## 6. Authentication (Amazon Cognito)

- Amazon Cognito is the managed passwordless identity provider: **SMS OTP** and **WebAuthn passkeys**.
- Cognito owns authentication end-to-end (OTP delivery/verification, passkey registration/assertion, session/token issuance). The application server never handles raw credentials.
- Successful Cognito authentication yields a `cognito_sub` used to look up (or create) the corresponding `User` row. It confirms identity only — see §3 for the strict separation from authorization.
- Cognito managed login (Hosted UI) is the assumed default for lowest implementation cost; see ARCHITECTURE.md for the stack decision.

## 7. Authorization

- **Deny-by-default, capability matrix.** Every state-changing endpoint is gated by an explicit capability matrix keyed by `(platform_role, SiteRole.role, SiteRole.status)`, scoped to the target Site (and `bathroom_scope` where applicable). A request is denied unless the matrix names an explicit allow for its endpoint given the caller's platform role and, where relevant, their SiteRole at the target Site.
- **Platform-level-only capabilities.** Creating or editing a Site or Bathroom, issuing the initial QRToken, setting/managing the fixed price (price versions), and capturing/canceling a PaymentAuthorization gate on `platform_role=company_admin` **only** — no `SiteRole`, including `role=manager`, ever satisfies these checks.
- **Site-scoped capabilities.** Creating a CleaningRequest, authorizing a hold, inviting/promoting/revoking a SiteRole, replacing a QRToken at a site, and approving an AssistantApprovalRequest require an explicit, active `SiteRole` check scoped to the relevant Site.
- The server **never trusts** UI state, QR contents, or any client-submitted claim about role or authority. Every authorization decision is re-derived server-side from the current `platform_role` and `SiteRole` record at request time.
- Authorization checks precede any business logic (price lookup, Stripe call, etc.) — a request with insufficient authority fails closed before any side effect occurs.
- `max_authorization_cents` bounds the amount a given SiteRole holder may authorize; requests exceeding this bound are rejected server-side regardless of what the client displayed.

## 8. Pricing

- Price is **always server-derived** from `Site.fixed_price_cents` (captured as `price_version` at request creation).
- Any amount submitted by the browser is **ignored**. The client may display the price for confirmation, but the server independently looks up and uses its own value when creating the PaymentIntent and the CleaningRequest.
- This prevents a manipulated client from requesting a cleaning at an arbitrary or zero price.

## 9. Payment lifecycle (Stripe, manual capture)

The payment authorization lifecycle is the heart of the system: **authorize a hold now, capture only after completion, and never reuse a hold.**

### 9.1 Flow

1. **Confirm.** The authorized requester scans the QR, authenticates via Cognito (passkey or OTP), and confirms the server-derived fixed price.
2. **Authorize.** The Site Manager (or an authorized/one-time-approved assistant) triggers the hold; the server creates a Stripe **manual-capture PaymentIntent** with a request-specific **idempotency key**. The `CleaningRequest` row is created only after the hold succeeds — a failed authorization creates no CleaningRequest and no PaymentAuthorization. The Site Manager and assistants can authorize a hold but can never capture or cancel one.
3. **Capture.** Only a **Company Admin** or internal operations/backend logic (`platform_role=company_admin`) may trigger a capture or a cancel, only after a completion action is recorded, and never for more than the originally authorized amount. No SiteRole — including `role=manager` — can capture or cancel.
4. **Recover.**
   - Cancellation, triggered only by a **Company Admin** or internal backend logic, releases the hold (Stripe PaymentIntent canceled; `PaymentAuthorization.status` updated accordingly).
   - An authorization that is never captured **expires to void** on Stripe's side; the system treats this as an operational event and raises an alert for follow-up (no silent loss of a pending job).

### 9.2 Invariants

- **Fresh hold each time.** Every paid request creates a new PaymentIntent. A prior hold is never reused for a different bathroom or a different request, even for the same requester.
- **No raw card data.** Card entry happens exclusively in Stripe's hosted UI (Payment Element, loaded from Stripe's CDN). The application server never receives, stores, or logs raw card data or client secrets — only Stripe-issued IDs (`stripe_payment_intent_id`, etc.).
- **Verified webhooks.** Stripe webhooks are signature-verified and processed idempotently to update `PaymentAuthorization.status` — no unauthenticated or replayed webhook can alter payment state.
- **Idempotency keys** on all PaymentIntent creation calls prevent duplicate holds from client retries or network errors.
- **Capture/cancel is Company-Admin/internal-backend only.** A Site Manager may authorize a hold at their site but can never capture or cancel a PaymentAuthorization; only `platform_role=company_admin` (interactively or via internal backend logic) may do so.

## 10. Assistant one-time approval

An assistant with a **pending** SiteRole cannot self-authorize a paid request. Instead:

- The assistant's action creates an `AssistantApprovalRequest`, bound to a specific `site_id`, `bathroom_id`, `price_version`, `amount`, and `assistant_id`.
- The approval is **single-use** and expires **5–15 minutes** after creation.
- **Changing any bound value invalidates the approval** — e.g., if the site's price changes, or a different bathroom or amount is implied, the previously issued approval can no longer be exercised and a new one must be created.
- Only a manager for that site can grant the approval. Granting it authorizes exactly the one bound request; it does not promote the assistant's SiteRole to `authorized` (promotion is a separate, explicit manager action — see the Blueprint's build plan, Phase 4/5).

## 11. Onboarding & public visitor flow

### 11.1 Company Admin onboarding flow (entry flow)

A new Site enters the system only through a Company Admin, in this order:

1. **Create the Site** — `name`, `address`, `timezone`, `currency`, `terms`.
2. **Create its Bathrooms**.
3. **Issue a QRToken** for each Bathroom (§5).
4. **Set the fixed price** (`fixed_price_cents`, establishing the first `price_version`; §8).
5. **Invite the initial Manager** by identifier, creating a pending `role=manager` SiteRole (§3.3) — the invitee becomes an active Manager once they authenticate through Cognito and the bridge links their identity.

Only a Company Admin can perform steps 1–4; no Site, Bathroom, QRToken, or price can exist without one. Step 5 is the last Company Admin action required before the Site is operable — all subsequent day-to-day requesting, hold authorization, and assistant management happen under the Manager's own SiteRole.

### 11.2 Public visitor flow

- A visitor scan (no SiteRole, whether anonymous or authenticated) always resolves to a **generic, neutral page**: "Need this restroom cleaned? Notify staff."
- This page **never reveals**: price, billing status, manager identity, request queue, or history.
- The visitor may optionally submit a **non-billable `PublicAlert`** — this never creates a PaymentIntent, a CleaningRequest, or any payment obligation.
- **Pre-activation privacy:** if a Site has not yet had a manager activate it, a scan still shows the same neutral page — it does not disclose that the site lacks a manager, which would otherwise leak operational state to an unauthenticated visitor.

### 11.3 Phase 0 HTTP surface (implementation)

The Phase 0 vertical slice realizes the flows above with these routes; all authorization is re-derived server-side through the deny-by-default capability matrix (§7), never from client input:

- `GET /admin` — Company Admin console. Requires an authenticated session whose `platform_role=company_admin` (checked via the matrix); an authenticated non-admin receives `403`, an unauthenticated caller is redirected to login.
- `POST /admin/sites` — create a Site with `name`, `address`, `timezone`, `currency`, and `fixed_price_cents` (gated on `site:create`).
- `POST /admin/sites/:siteId/bathrooms` — add a Bathroom to a Site (gated on `bathroom:create`).
- `POST /admin/sites/:siteId/bathrooms/:bathroomId/qr` — issue a fresh opaque QRToken, revoking any prior active token for that Bathroom (gated on `qr_token:issue`). The raw token is rendered once into an inline SVG QR encoding the public scan URL; only its one-way hash is persisted (§5).
- `POST /admin/sites/:siteId/managers` — invite the initial Site Manager by phone, creating a pending `role=manager` SiteRole (gated on `site_role:invite_initial_manager`; §3.3).
- `GET /s/:token` — public scan resolution. Rate-limited hash lookup (§5), then a neutral "see staff" page (§11.2). The response is byte-for-byte identical whether the token is active, revoked, or unknown, and whether or not the Site has an activated manager — no oracle. It creates no PaymentIntent and writes no data.

All onboarding `POST`s are state-changing and therefore require the existing session-bound CSRF token (§ CSRF guard); the Company Admin console submits them via a small progressive-enhancement ES module that echoes the token in the `x-csrf-token` header. The public scan page loads no such requirement and ships ~0 KB JS.

> **Deferred in this slice — public `PublicAlert` affordance.** The neutral page does not yet expose an interactive "notify staff" submission. The global CSRF guard requires an authenticated session for every state-changing request, and an anonymous state-changing endpoint would be a spam/CSRF surface (hardened rate limiting and duplicate protection are out of scope for MVP per §1.5). The `PublicAlert` entity and the non-billable alert flow remain specified (§4, §11.2) and will be added behind an appropriate anti-abuse control in a later phase; deferring it keeps complete mediation intact rather than shipping a weaker anonymous mutation.

### 11.4 Phase 1 HTTP surface — Site Manager invitation flow (implementation)

This slice generalizes the Company Admin's initial-manager invite (§11.1, §11.3) so an
authorized Site Manager can invite additional members — another manager or an assistant —
to their own site. It reuses the `invite_site_role` action / `site_role:invite` capability
that the matrix (§7) already grants to an authorized `role=manager` SiteRole at its own
site; Company Admin authority (`invite_initial_manager`) is unchanged and orthogonal.

- `GET /manager` — Site Manager console. Requires an authenticated session; lists every
  Site where the caller holds an `authorized` `role=manager` SiteRole, each with its
  pending invites and an invite form. This is a self-scoped read (filtered by the caller's
  own `user_id`), so an authenticated customer or assistant simply sees an empty console —
  never another manager's sites.
- `POST /manager/sites/:siteId/invites` — invite a user by phone as `manager` or
  `assistant` at `:siteId`, creating a pending SiteRole (`user_id=null`, `status=pending`;
  gated on `site_role:invite`, scoped to `:siteId`). A repeat invite for the same
  not-yet-linked phone at the same site is idempotent (returns the existing pending/
  authorized record rather than a duplicate row). Rate-limited per authenticated user
  (same fixed-window primitive as §11.3's public scan limiter) since no SMS cost bounds
  invite volume in this phase. **This phase persists a DB record only — no SMS/OTP is
  sent.** Delivery and the invite-bridge link to a Cognito identity on first login (§3.3)
  are separate, later tasks.

The invite `POST` is state-changing and therefore requires the same session-bound CSRF
token as the Company Admin console (§11.3); the manager console submits it via the same
progressive-enhancement pattern (`x-csrf-token` header), inert without JS.

## 12. Security invariants

| Invariant                      | Statement                                                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity ≠ authority           | Cognito authentication proves who a user is; only a manager-created SiteRole grants site authority, and only internal provisioning grants `platform_role=company_admin`. No self-service path elevates a customer to an assistant, a manager, or a Company Admin. |
| Authorize by capability matrix | Every state-changing endpoint validates against a capability matrix keyed by `(platform_role, SiteRole.role, SiteRole.status)`, scoped to the target site. Deny by default; never trust UI, QR contents, or client claims.                                        |
| Fresh hold each time           | Every paid request creates a new PaymentIntent. A prior hold is never reused for another bathroom or request.                                                                                                                                                     |
| No raw card data               | Card entry happens only in Stripe's UI. The system stores Stripe IDs and never logs card data or client secrets.                                                                                                                                                  |
| Opaque, hashed QR              | Random, non-sequential tokens; only a one-way hash is stored; resolution is rate-limited; tags are revocable/replaceable.                                                                                                                                         |
| One-time approval binding      | Assistant approval is single-use and bound to site, bathroom, price version, amount, and assistant; changing any bound value invalidates it.                                                                                                                      |
| Verified webhooks              | Stripe webhooks are signature-verified and processed idempotently to update payment status.                                                                                                                                                                       |
| Managed secrets                | Stripe keys and Cognito/DB credentials live in AWS Secrets Manager; never hardcoded, never in logs or diffs.                                                                                                                                                      |

## 13. Confirmed stack decisions

These decisions are locked pending final sign-off on the Blueprint (`art_RUHUe0PF`, v0.3) and are detailed in ARCHITECTURE.md:

- **Stack:** No-framework, no-bundler Lean SSR — TypeScript on Node.js, native `node:http` + a small typed router, server-rendered HTML via template literals, progressive-enhancement vanilla ES modules, hand-authored mobile-first CSS. Single-deployable modular monolith.
- **Deploy:** AWS via Terraform — App Runner (SSR), RDS/Aurora Serverless v2 PostgreSQL, Secrets Manager, ACM + Route 53, region `us-east-1`.
- **Auth:** Amazon Cognito managed passwordless — SMS OTP + passkeys, via Cognito managed login (Hosted UI). Cognito owns authentication; the application server owns authorization (SiteRole).
- **Identity vs. authority:** customer = no SiteRole; assistant/manager = manager-created SiteRole (pending/authorized); Company Admin = platform-level `platform_role=company_admin`, provisioned internally/seeded (or granted by an existing Company Admin), never via self-service, QR, or Cognito login. No self-service elevation to any of these (§3).
- **Payments:** Stripe manual-capture PaymentIntents with idempotency keys; capture/cancel is Company-Admin/internal-backend only; server-derived price (§8, §9).
- **Database:** Aurora Serverless v2 PostgreSQL with Drizzle ORM for typed, parameterized queries and migrations.
- **Public alerts:** neutral "see staff" page only for MVP (§11).
- **Delivery:** build and host in the sandbox first; PR into `main` and AWS deploy only after human review, per the Blueprint's sandbox-first build plan.

Each new dependency (Drizzle, Stripe SDK, `qrcode`, AWS SDK) and each managed service (Cognito, RDS/Aurora, App Runner) is justified above and in ARCHITECTURE.md before adoption, per AGENTS.md's minimal-dependency rule.
