# Software Design Document — QR Bathroom Cleaning Service Request App

> **Last edited:** 2026-08-14 (per AGENTS.md spec policy, edit date/time recorded here)
>
> **Status:** Approved for Phase 0 build. Source of truth for coders; mirrors the reviewed Blueprint (`art_RUHUe0PF`, v0.3).

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

| Actor                         | Description                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manager**                   | Owns or administers a Site. Creates SiteRoles (invites assistants), sets `max_authorization_cents`, approves assistant one-time requests, replaces/revokes QR tags.                                                                                               |
| **Assistant**                 | Site staff invited by a manager. Has a SiteRole with status `pending` or `authorized`. Can initiate cleaning requests within their authorized limits once `authorized`; while `pending`, can only initiate a request that requires a manager's one-time approval. |
| **Customer / public visitor** | Anyone who scans a bathroom QR and has no SiteRole for that site — whether unauthenticated or authenticated via Cognito. Sees only the neutral public page; can optionally leave a non-billable alert.                                                            |

No other roles exist in the MVP. There is no "admin" role distinct from manager, and no customer account tier.

## 3. Identity vs. authority (critical model)

This is the central security invariant of the system: **the system never decides authority from anything the person presents.**

- **Authentication** (Amazon Cognito) proves _who you are_ — a verified phone number or a registered passkey bound to a Cognito subject (`cognito_sub`).
- **Authorization** (a manager-created `SiteRole`) proves _what you may do at a site_.

These are deliberately separate systems, and the second never follows automatically from the first.

### 3.1 No self-service elevation

There is **no self-service path** from customer to assistant:

- Verifying a phone number or enrolling a passkey through Cognito never grants site authority. It only confirms identity.
- Possessing or scanning a QR code grants nothing — the QR resolves to a bathroom, not to a role.
- A member of the public who successfully authenticates through Cognito is still just a customer unless a manager has separately created a SiteRole for that identity at that site.

### 3.2 Resolution table

| Who                                   | What the server finds                                                                      | Can start a paid request?                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Customer / public visitor             | Authenticated (or anonymous) identity with **no SiteRole** for this site                   | No — neutral "see staff" page; optional non-billable alert                               |
| Invited assistant, not yet authorized | **Pending** SiteRole (`role=assistant, status=pending`) created by a manager inviting them | No self-authorize — can only initiate a request that needs a manager's one-time approval |
| Authorized assistant                  | `role=assistant, status=authorized`                                                        | Yes, within limits (`max_authorization_cents`)                                           |
| Manager                               | `role=manager`, active, with `max_authorization_cents`                                     | Yes, up to the authorized amount                                                         |

### 3.3 The bridge: invite → pending → linked

1. A manager invites an assistant by identifier (e.g., phone number). This creates a **pending SiteRole** — a record that exists before the invitee has ever authenticated.
2. When the invitee authenticates that same identifier through Cognito (SMS OTP or passkey enrollment), the server links the pending SiteRole to the resulting Cognito subject / `User` record.
3. Only at that point does the invitee become a known-but-not-yet-authorized assistant (`status=pending`, now linked to an identity). A manager subsequently promotes them to `authorized` (see §9, Assistant workflow).
4. **No invite means no SiteRole means customer.** There is no code path that creates a SiteRole except an explicit manager action.

This bridge is the only route by which a SiteRole comes to exist for a given identity. It is never inferred from a QR scan, a Cognito login, or any client-submitted claim.

## 4. Data model

All entities are stored in PostgreSQL (Aurora Serverless v2) via Drizzle ORM. Payment fields are references only — the system never stores raw card data. Identity is anchored to a Cognito subject, never to a password.

| Entity                       | Key fields                                                                          | Notes                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Site**                     | `name`, `address`, `timezone`, `currency`, `fixed_price_cents`, `terms`             | One billing configuration; owns Bathrooms.                                                                                                                        |
| **Bathroom**                 | `site_id`, `label`, `status`                                                        | Belongs to exactly one Site; at most one active QRToken.                                                                                                          |
| **QRToken**                  | `bathroom_id`, `token_hash`, `status`                                               | Stores a one-way hash of the token only; opaque and non-authorizing; replaceable/revocable.                                                                       |
| **User**                     | `cognito_sub`, `phone`, `status`                                                    | Identity anchored to a Cognito subject; no passwords stored.                                                                                                      |
| **SiteRole**                 | `user_id`, `site_id`, `role`, `status`, `max_authorization_cents`, `bathroom_scope` | Manager-created site authority; deny by default; distinguishes assistant from customer. `role` ∈ {manager, assistant}; `status` ∈ {pending, authorized, revoked}. |
| **CleaningRequest**          | `bathroom_id`, `price_version`, `amount_cents`, `status`                            | Exactly one payment authorization per request in the MVP.                                                                                                         |
| **PaymentAuthorization**     | `request_id`, `stripe_payment_intent_id`, `status`                                  | Manual-capture; created fresh per request; never reused.                                                                                                          |
| **AssistantApprovalRequest** | `site_id`, `bathroom_id`, `price_version`, `amount`, `assistant_id`, `expires_at`   | Single-use; 5–15 minute expiry; bound values invalidate the approval on change.                                                                                   |
| **PublicAlert**              | `bathroom_id`, `note`, `created_at`                                                 | Non-billable; no associated PaymentIntent or CleaningRequest.                                                                                                     |

### 4.1 Referential notes

- `SiteRole.user_id` may reference a `User` created before or after the invite — the pending SiteRole exists independent of the `User` row until the bridge (§3.3) links them.
- `CleaningRequest.price_version` anchors the price used at authorization time so later `Site.fixed_price_cents` changes cannot retroactively alter an in-flight or historical request.
- `PaymentAuthorization` is 1:1 with `CleaningRequest` in the MVP (no partial charges, no multiple holds per request).

## 5. QR generation & resolution

- Tokens are **opaque, cryptographically random, non-sequential** — no bathroom ID, site ID, or other identifying structure is embedded in or derivable from the token.
- The server stores only a **one-way hash** of the token (never the raw token); resolution looks up the incoming scanned value by hash.
- QR resolution is **rate-limited** at the endpoint level to blunt brute-force enumeration (see AGENTS.md security rules on complete mediation and fail-safe defaults; hardened rate limiting is out of scope for MVP per §1.5).
- Tags are **revocable and replaceable**: a manager can invalidate a QRToken (e.g., a printed tag is lost or compromised) and issue a new one for the same Bathroom without any change to the Bathroom's identity or history.
- A resolved QRToken identifies a Bathroom **only**. It never authenticates a person and never itself authorizes any action — see §3 for why authority requires a separate SiteRole lookup.

## 6. Authentication (Amazon Cognito)

- Amazon Cognito is the managed passwordless identity provider: **SMS OTP** and **WebAuthn passkeys**.
- Cognito owns authentication end-to-end (OTP delivery/verification, passkey registration/assertion, session/token issuance). The application server never handles raw credentials.
- Successful Cognito authentication yields a `cognito_sub` used to look up (or create) the corresponding `User` row. It confirms identity only — see §3 for the strict separation from authorization.
- Cognito managed login (Hosted UI) is the assumed default for lowest implementation cost; see ARCHITECTURE.md for the stack decision.

## 7. Authorization

- **Deny-by-default.** Every state-changing endpoint (creating a CleaningRequest, capturing/canceling a PaymentAuthorization, inviting/promoting/revoking a SiteRole, replacing a QRToken, approving an AssistantApprovalRequest) requires an explicit, active `SiteRole` check scoped to the relevant Site (and `bathroom_scope` where applicable).
- The server **never trusts** UI state, QR contents, or any client-submitted claim about role or authority. Every authorization decision is re-derived server-side from the current `SiteRole` record at request time.
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
2. **Authorize.** The server creates a Stripe **manual-capture PaymentIntent** with a request-specific **idempotency key**. The `CleaningRequest` row is created only after the hold succeeds — a failed authorization creates no CleaningRequest and no PaymentAuthorization.
3. **Capture.** Only internal operations/backend logic may trigger a capture, only after a completion action is recorded, and never for more than the originally authorized amount.
4. **Recover.**
   - Cancellation releases the hold (Stripe PaymentIntent canceled; `PaymentAuthorization.status` updated accordingly).
   - An authorization that is never captured **expires to void** on Stripe's side; the system treats this as an operational event and raises an alert for follow-up (no silent loss of a pending job).

### 9.2 Invariants

- **Fresh hold each time.** Every paid request creates a new PaymentIntent. A prior hold is never reused for a different bathroom or a different request, even for the same requester.
- **No raw card data.** Card entry happens exclusively in Stripe's hosted UI (Payment Element, loaded from Stripe's CDN). The application server never receives, stores, or logs raw card data or client secrets — only Stripe-issued IDs (`stripe_payment_intent_id`, etc.).
- **Verified webhooks.** Stripe webhooks are signature-verified and processed idempotently to update `PaymentAuthorization.status` — no unauthenticated or replayed webhook can alter payment state.
- **Idempotency keys** on all PaymentIntent creation calls prevent duplicate holds from client retries or network errors.

## 10. Assistant one-time approval

An assistant with a **pending** SiteRole cannot self-authorize a paid request. Instead:

- The assistant's action creates an `AssistantApprovalRequest`, bound to a specific `site_id`, `bathroom_id`, `price_version`, `amount`, and `assistant_id`.
- The approval is **single-use** and expires **5–15 minutes** after creation.
- **Changing any bound value invalidates the approval** — e.g., if the site's price changes, or a different bathroom or amount is implied, the previously issued approval can no longer be exercised and a new one must be created.
- Only a manager for that site can grant the approval. Granting it authorizes exactly the one bound request; it does not promote the assistant's SiteRole to `authorized` (promotion is a separate, explicit manager action — see the Blueprint's build plan, Phase 4/5).

## 11. Public visitor flow

- A visitor scan (no SiteRole, whether anonymous or authenticated) always resolves to a **generic, neutral page**: "Need this restroom cleaned? Notify staff."
- This page **never reveals**: price, billing status, manager identity, request queue, or history.
- The visitor may optionally submit a **non-billable `PublicAlert`** — this never creates a PaymentIntent, a CleaningRequest, or any payment obligation.
- **Pre-activation privacy:** if a Site has not yet had a manager activate it, a scan still shows the same neutral page — it does not disclose that the site lacks a manager, which would otherwise leak operational state to an unauthenticated visitor.

## 12. Security invariants

| Invariant                 | Statement                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity ≠ authority      | Cognito authentication proves who a user is; only a manager-created SiteRole grants site authority. No self-service path elevates a customer to an assistant.       |
| Authorize by site         | Every state-changing endpoint validates that an active user holds the required SiteRole permission. Deny by default; never trust UI, QR contents, or client claims. |
| Fresh hold each time      | Every paid request creates a new PaymentIntent. A prior hold is never reused for another bathroom or request.                                                       |
| No raw card data          | Card entry happens only in Stripe's UI. The system stores Stripe IDs and never logs card data or client secrets.                                                    |
| Opaque, hashed QR         | Random, non-sequential tokens; only a one-way hash is stored; resolution is rate-limited; tags are revocable/replaceable.                                           |
| One-time approval binding | Assistant approval is single-use and bound to site, bathroom, price version, amount, and assistant; changing any bound value invalidates it.                        |
| Verified webhooks         | Stripe webhooks are signature-verified and processed idempotently to update payment status.                                                                         |
| Managed secrets           | Stripe keys and Cognito/DB credentials live in AWS Secrets Manager; never hardcoded, never in logs or diffs.                                                        |

## 13. Confirmed stack decisions

These decisions are locked pending final sign-off on the Blueprint (`art_RUHUe0PF`, v0.3) and are detailed in ARCHITECTURE.md:

- **Stack:** No-framework, no-bundler Lean SSR — TypeScript on Node.js, native `node:http` + a small typed router, server-rendered HTML via template literals, progressive-enhancement vanilla ES modules, hand-authored mobile-first CSS. Single-deployable modular monolith.
- **Deploy:** AWS via Terraform — App Runner (SSR), RDS/Aurora Serverless v2 PostgreSQL, Secrets Manager, ACM + Route 53, region `us-east-1`.
- **Auth:** Amazon Cognito managed passwordless — SMS OTP + passkeys, via Cognito managed login (Hosted UI). Cognito owns authentication; the application server owns authorization (SiteRole).
- **Identity vs. authority:** customer = no SiteRole; assistant = manager-created SiteRole (pending/authorized). No self-service elevation (§3).
- **Payments:** Stripe manual-capture PaymentIntents with idempotency keys; capture only after completion; server-derived price (§8, §9).
- **Database:** Aurora Serverless v2 PostgreSQL with Drizzle ORM for typed, parameterized queries and migrations.
- **Public alerts:** neutral "see staff" page only for MVP (§11).
- **Delivery:** build and host in the sandbox first; PR into `main` and AWS deploy only after human review, per the Blueprint's sandbox-first build plan.

Each new dependency (Drizzle, Stripe SDK, `qrcode`, AWS SDK) and each managed service (Cognito, RDS/Aurora, App Runner) is justified above and in ARCHITECTURE.md before adoption, per AGENTS.md's minimal-dependency rule.
