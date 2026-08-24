# Software Design Document — QR Bathroom Cleaning Service Request App

> **Last edited:** 2026-08-21 21:45 UTC — Two bugfixes (client-side, no spec impact):
> (a) `public/js/confirm.js` rendered each successful mutation via `document.write()`,
> which does not reliably re-execute `<script type="module">` in the new document — so the
> very next form submit (e.g. "Authorize hold" right after "Add a payment method") fell back
> to a native, un-enhanced POST and failed the CSRF gate as a bare 403 "Forbidden"; fixed by
> swapping the DOM in place and re-running the same enhancement instead. (b) the demo
> accept flow's double-submit CSRF cookie used one fixed name, so opening a second
> `/invite/accept` link (a different invite, or the same one reloaded) in the same browser
> silently invalidated an earlier one's cookie, failing that tab with "Invalid or missing
> form token"; fixed by scoping the cookie name to a per-request nonce. Changelog #013.
>
> **Last edited:** 2026-08-21 20:30 UTC — Bugfix (tooling): `drizzle/meta/_journal.json`'s
> `0003_phase6_authorized_users` entry carried a `when` timestamp five days in the future
> relative to `0004`'s real generation time, so drizzle-orm's runtime migrator (which gates
> on timestamp comparison, not hash) silently skipped `0004` (#010's partial-index fix)
> forever on any database that had already applied `0003` — reproducing #010's symptom
> even after #010/#011 shipped. Corrected to a realistic value; an already-migrated
> database additionally needs a one-time row repair (see changelog #012). No spec impact.

> **Last edited:** 2026-08-21 19:15 UTC — Bugfix: `isUniqueViolation` (§3.3, §9.4) now
> walks an error's `.cause` chain, not just its top-level object, so it correctly detects
> a Postgres `23505` wrapped by this drizzle-orm version's `DrizzleQueryError` — closing a
> gap where every "conditional write + defensive catch" site's documented "never surfaces
> as an unhandled 500" guarantee was silently not holding. Changelog #011. Per AGENTS.md
> spec policy, edit date/time recorded here.

> **Last edited:** 2026-08-21 14:30 UTC — Bugfix: a revoked SiteRole no longer permanently
> blocks the same identity from being re-invited and reactivated at the same site.
> `site_roles_site_user_key` (§4) is now a partial unique index excluding revoked rows;
> the invite bridge's existing-role guard (§3.3) excludes revoked rows; `resolveSiteRole`
> (§7) and the demo accept-result read now deterministically prefer a non-revoked row when
> both a historical revoked row and a reactivated row exist for the same
> `(site_id, user_id)`. Updated §3.3, §4; changelog #010. Per AGENTS.md spec policy, edit
> date/time recorded here.

> **Last edited:** 2026-08-21 13:00 UTC — Phase 7: `site_role:set_limit` added to the
> `company_admin` platform matrix so a Company Admin can **change an authorized user's
> approval limit** (and revoke authorized users, revoke already being role-agnostic); new
> admin route `POST /admin/sites/:siteId/roles/:roleId/limit` (§11.3) and the admin console
> now lists managers **and** authorized users with limits (§11.1). Updated §7, §11.1, §11.3;
> changelog #009. The web-app restyle and the demo accept Continue-link tweak are
> presentation-only. Per AGENTS.md spec policy, edit date/time recorded here.

> **Last edited:** 2026-08-20 15:30 UTC — Phase 6: renamed the site role `assistant` →
> **`authorized_user`** everywhere and reshaped site authority into two tiers — a `manager`
> has no authorization limit and self-authorizes any amount, while an `authorized_user` has
> a **manager-set limit** and any **over-limit** request is routed to a manager's approval
> (rewrote §10 as `RequestApproval`). Made the invite **one-step** (the bridge activates
> both roles on accept, no promotion), added manager `site_role:set_limit`/`site_role:delete`
> and Company-Admin `site_role:revoke`, and made re-inviting an existing member idempotent
> and reported as "already a member". Updated §2, §3, §4, §7, §9, §10, §11; changelog #008.
> Per AGENTS.md spec policy, edit date/time recorded here.

> **Last edited:** 2026-08-14 — reintroduced the platform-level **Company Admin** role, which an earlier edit had incorrectly dropped by asserting no admin role exists distinct from manager. This corrects §2–§5, §7, §9, §11, and §13 to match the original product spec: Company Admin is a cross-site internal operator (site/bathroom/QR/price creation, payment capture/cancel, initial-manager invite), while Site Manager remains site-scoped and cannot create sites or capture/cancel payments. Per AGENTS.md spec policy, edit date/time recorded here.

> **Last edited:** 2026-08-14 15:00 UTC — Phase 0 vertical slice: documented the concrete HTTP surface for Company Admin onboarding (§11.1) and the privacy-safe public scan endpoint (§11.2), and recorded that the optional public `PublicAlert` affordance is intentionally deferred for this slice (see §11.3). No role-model or data-model change; the slice reuses the merged schema and the deny-by-default capability matrix (§7) unchanged. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Last edited:** 2026-08-14 20:15 UTC — Phase 1 (Task 17): documented the **passkey (WebAuthn) enrollment path** (new §6.2). Records the authenticated-session enrollment entry point (`GET /auth/passkey/register`) that redirects to Cognito managed login to register a WebAuthn passkey and returns through the **factor-shared** `/auth/callback` (unchanged), reusing the existing state/session modules. Confirms the `WEB_AUTHN` first-auth factor and `web_authn_configuration` are already authored in `infra/modules/cognito` (`terraform validate`-only, no live apply). Establishes that passkey enrollment is an **identity** action gated by an authenticated session only — it confers no site authority and is therefore not a capability-matrix action (§3). No role-model or data-model change. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Prior edit:** 2026-08-14 18:57 UTC — Phase 1 (Task 16): documented the **SMS OTP activation path** (§6.1).
>
> **Last edited:** 2026-08-14 18:00 UTC — Phase 1, Manager invitation flow: documented the HTTP surface (§11.4) an authorized Site Manager uses to invite additional members (manager or assistant) to their own site, generalizing the Company Admin's initial-manager invite. Clarified §2 that a Manager also invites/promotes/revokes additional managers, not only assistants. No new capability, role, or migration — this reuses the `invite_site_role` / `site_role:invite` matrix entry (§7) and the existing SiteRole schema (§4) unchanged. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Last edited:** 2026-08-17 18:00 UTC — Phase 2 (mocked payment gateway): documented the
> "authorize now" implementation (new §9.3) -- a `PaymentGateway` interface with an
> in-memory `MockPaymentGateway` standing in for Stripe's manual-capture PaymentIntent
> semantics (explicitly **not** Stripe; no live keys, no card collection, no real money
> movement under any configuration), plus the concrete HTTP surface for an authorized
> Manager/Assistant to place a hold and a Company Admin to capture/cancel it (§11.6).
> Amends §11.2/§11.3's "no oracle" wording to scope it precisely: the neutral page stays
> byte-for-byte unchanged for any caller **without** authorized site authority at the
> resolved site (public, customer, pending assistant, wrong-site manager); a caller who
> already holds that authority legitimately sees a different, price-confirmation response
> for their own site's QR, matching why a manager can replace a QR at all (§5). No role,
> capability-matrix, or schema change -- `create_cleaning_request`, `capture_payment`, and
> `cancel_payment` were already fully specified in §7/§9 and are wired to routes for the
> first time here. Per AGENTS.md spec policy, edit date/time recorded here.
>
> **Last edited:** 2026-08-19 21:30 UTC — Phase 3 (backlog items 3+4): documented **saved
> (mock) payment methods** (new §4 entity `SitePaymentMethod`, new §9.4), the
> **site-scoped-not-user-scoped** design decision and its rationale, a new **step-up
> re-authentication** primitive (new §6.4, `sessionAuthenticatedWithin`) gating reuse of a
> saved method to place a new hold, a `next`-redirect addition to `GET /auth/login` so
> step-up re-authentication can return the caller to the QR page it interrupted, and a
> **duplicate-active-request guard** preventing two concurrent non-terminal
> `CleaningRequest`s for one bathroom. New HTTP surface at §11.7. New capability
> `payment_method:save` (§7), granted to `manager`/`assistant` only, mirroring
> `cleaning_request:create`. No PAN/CVV/expiry field of any kind is introduced anywhere —
> the only payment-method UI action is "Add a payment method (mock)". Per AGENTS.md spec
> policy, edit date/time recorded here.
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
- Notifications (SMS/email) of an invite or of a pending over-limit approval.
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

| Actor                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Company Admin**             | Platform-level internal operator (`platform_role=company_admin`) — **not** a SiteRole, and not scoped to any single site. Creates and edits Sites and Bathrooms, issues/replaces QRTokens, sets and manages the fixed price (price versions), invites the _initial_ Manager for a new Site, and triggers payment capture/cancel (internal backend). Does **not** request cleanings and does **not** authorize card holds.                                                                                                                                                                                           |
| **Manager**                   | Site-scoped (SiteRole `role=manager`). Requests cleaning and authorizes fixed-price holds at their site with **no authorization limit**, approves an authorized user's over-limit request, invites members (authorized users **and additional managers**) at their site, changes an authorized user's limit, deletes an authorized user, views full payment details for their site, and may replace the QR at their own site. **Cannot** create Sites or Bathrooms and **cannot** capture or cancel payments — those are Company Admin actions. A manager's own SiteRole is created and revoked by a Company Admin. |
| **Authorized user**           | Site staff invited by a manager in a single step (SiteRole `role=authorized_user`). Active the moment they accept the invite (no separate promotion step). Initiates cleaning requests and self-authorizes a hold **up to their manager-set authorization limit**; a request **above** that limit is held as a pending approval until a **manager approves** it. Cannot invite, manage, or approve other members.                                                                                                                                                                                                   |
| **Customer / public visitor** | Anyone who scans a bathroom QR and has no SiteRole for that site — whether unauthenticated or authenticated via Cognito. Sees only the neutral public page; can optionally leave a non-billable alert.                                                                                                                                                                                                                                                                                                                                                                                                              |

No other roles exist in the MVP. There is no customer account tier.

## 3. Identity vs. authority (critical model)

This is the central security invariant of the system: **the system never decides authority from anything the person presents.**

- **Authentication** (Amazon Cognito) proves _who you are_ — a verified phone number or a registered passkey bound to a Cognito subject (`cognito_sub`).
- **Authorization** is one of two kinds, and both are deliberately separate from authentication:
  - A manager-created `SiteRole` proves _what you may do at a site_.
  - `platform_role=company_admin` proves _cross-site internal operator authority_, independent of any site. It is **provisioned internally** — seeded directly, or granted by an existing Company Admin — and is **never** obtained via self-service signup, a QR scan, or a Cognito login. The same identity-vs-authority principle applies: authenticating through Cognito never makes anyone a Company Admin.

These are deliberately separate systems, and authorization never follows automatically from authentication.

### 3.1 No self-service elevation

There is **no self-service path** from customer to authorized user:

- Verifying a phone number or enrolling a passkey through Cognito never grants site authority. It only confirms identity.
- Possessing or scanning a QR code grants nothing — the QR resolves to a bathroom, not to a role.
- A member of the public who successfully authenticates through Cognito is still just a customer unless a manager has separately created a SiteRole for that identity at that site.

### 3.2 Resolution table

| Who                              | What the server finds                                                            | Can start a paid request?                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer / public visitor        | Authenticated (or anonymous) identity with **no SiteRole** for this site         | No — neutral "see staff" page; optional non-billable alert                                                                                                                      |
| Invited member, not yet accepted | **Pending** SiteRole (`status=pending`, `user_id=null`) created by inviting them | No — confers nothing until the invitee accepts (authenticates) and the §3.3 bridge links + activates it                                                                         |
| Authorized user                  | `role=authorized_user, status=authorized`, with `max_authorization_cents`        | Yes up to their limit; a request **above** the limit is held for a manager's approval (§10)                                                                                     |
| Manager                          | `role=manager`, active (`max_authorization_cents = null`, unlimited)             | Yes, any amount — no authorization limit                                                                                                                                        |
| Company Admin                    | `platform_role=company_admin` (no SiteRole needed at any site)                   | No — does not request cleanings or authorize holds; instead creates Sites/Bathrooms, issues/replaces QR, sets price, invites the initial Manager, and captures/cancels payments |

### 3.3 The bridge: invite → pending → active

1. A manager invites a member (an authorized user or an additional manager) by identifier (e.g., phone number). This creates a **pending SiteRole** — a record that exists before the invitee has ever authenticated, carrying the role and, for an authorized user, the manager-set `max_authorization_cents`.
2. When the invitee authenticates that same identifier through Cognito (SMS OTP or passkey enrollment), the server links the pending SiteRole to the resulting Cognito subject / `User` record **and activates it** (`status` → `authorized`).
3. From that point the invitee is an active member at the site: a manager, or an authorized user who can request service (self-authorizing up to their limit, with over-limit requests routed to a manager's approval, §10). There is no separate promotion step.
4. **No invite means no SiteRole means customer.** There is no code path that creates a SiteRole except an explicit manager (or, for the initial manager, Company Admin) action.

This bridge is the only route by which a SiteRole comes to exist for a given identity. It is never inferred from a QR scan, a Cognito login, or any client-submitted claim.

The same bridge bootstraps the very first Manager for a new Site: a **Company Admin** invites the initial Manager by identifier during onboarding, creating a pending `role=manager` SiteRole; when the invitee authenticates that identifier through Cognito, the server links it exactly as in steps 1–2 above. From that point forward, that Manager can invite additional members (authorized users or additional managers), set an authorized user's limit, and delete an authorized user at their own site — but only a Company Admin can create the next Site, invite the next Site's initial Manager, or revoke a Manager.

**Activation on authentication (updated 2026-08-14, 00:00 UTC).** Step 2's link is performed automatically in the authenticated Cognito callback (`src/auth/routes.ts` → `bridgePendingSiteRoles`, `src/db/access.ts`). On each successful authentication the server matches the ID token's **verified** phone number against not-yet-linked pending invites (`invited_phone` equal, `user_id IS NULL`, `status=pending`) and sets `user_id` to the resolved `User`. The two invited roles differ in outcome, matching the resolution table (§3.2):

- **Both** `role=manager` and `role=authorized_user` invites are **activated** in the same step (`status` → `authorized`) when the invitee accepts. A manager invite makes the Site operable per §11.1; an authorized-user invite makes that person able to request service immediately (self-authorizing up to their manager-set limit, §7/§10). This is not self-elevation: the authority-granting act is the manager's explicit invite; accepting only binds the invitee's verified identity to the SiteRole the manager already created. There is no "linked-but-still-pending" state — `pending` means only "invited, not yet accepted."

A token whose verified identifier matches no pending invite links nothing and grants nothing — deny-by-default (§7) is unchanged, and Company Admin (`platform_role`) authority is orthogonal and untouched. The operation is **idempotent**: repeat authentication re-matches only still-unlinked pending invites, so an already-activated role (manager or authorized user) is left exactly as it was. All authority continues to be re-derived from the SiteRole matrix (§7) on every request — activation grants authority only because the resolved role is now `authorized`, never through any parallel code path.

**Resilient bridge contract (added 2026-08-16, PR-D; revoked-row exclusion added
Phase 8).** The unique index `site_roles_site_user_key` on `(site_id, user_id)` permits
at most one **active** (non-revoked) SiteRole per user per site — it is a **partial**
index excluding `status=revoked` rows, so a revoked role and a later reactivated role for
the same user+site can coexist as separate rows, the revoked one kept only as history.
The bridge must never attempt to write the same `user_id` onto more than one _active_ row
at a given site in a single pass — even when duplicate pending invites exist for the same
phone (e.g. a manager re-invites a phone, or two managers independently invite the same
phone to one site). `bridgePendingSiteRoles` enforces this as follows:

- **At most one active role per (user, site).** Matching pending invites for the verified
  phone are grouped by `site_id` before any write; each site yields at most one
  activated/linked row per bridge call. A **revoked** role at that site does not count as
  an existing role for this purpose — see the reactivation guard below.
- **Deterministic pick, graceful supersession.** When more than one pending invite
  matches the same phone at a site, the earliest-created match (`created_at` ascending,
  `id` ascending on tie) is the one activated/linked per steps 1–2 above; every other
  matching row at that site is marked `status=revoked` (superseded) rather than left
  dangling `pending` or written with a colliding `user_id`. A superseded duplicate confers
  no authority and can never be redeemed again.
- **Already-has-an-ACTIVE-role no-ops; a revoked role does not block reactivation
  (Phase 8 fix).** If the resolved user already holds a **non-revoked** SiteRole at a
  site that also has matching pending invites, the bridge leaves that existing role
  untouched and only supersedes the pending duplicates — no insert, no update collision,
  no error. A **revoked** role at that site is deliberately excluded from this guard: it
  must not permanently block the same identity from being re-invited and reactivated at
  that site. (`site_roles_site_user_key`, §4, is a partial unique index excluding revoked
  rows for exactly this reason — a revoked row and a later reactivated row for the same
  `(site_id, user_id)` coexist, the revoked one kept only as history.)
- **No unhandled 500 on a race.** The activating write is a single conditional
  `UPDATE ... WHERE id = ? AND user_id IS NULL AND status = 'pending'`, so a concurrent
  bridge call touching the same row is a no-op, not a conflict. As defense in depth
  against any remaining race, a Postgres unique-violation (`23505`) surfaced during
  activation is caught and treated as "another call already won this site" instead of
  propagating as an unhandled error. `isUniqueViolation` (`src/db/access.ts`) detects this
  by SQLSTATE, walking the error's `.cause` chain — not just the top-level object —
  because the driver's raw error is not necessarily the object a caller catches (a
  wrapping query-error type may attach the original as `.cause`); this is the sole
  detector shared by every "conditional write + defensive catch" site in the codebase,
  including the one-saved-payment-method-per-site guard (§9.4).

This is a resilience change only: the single-invite happy path (one pending invite per
phone per site) is byte-for-byte unchanged in behavior — same row activated/linked, same
returned shape, same idempotency on repeat authentication.

## 4. Data model

All entities are stored in PostgreSQL (Aurora Serverless v2) via Drizzle ORM. Payment fields are references only — the system never stores raw card data. Identity is anchored to a Cognito subject, never to a password.

| Entity                   | Key fields                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Site**                 | `name`, `address`, `timezone`, `currency`, `fixed_price_cents`, `terms`                | One billing configuration; owns Bathrooms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Bathroom**             | `site_id`, `label`, `status`                                                           | Belongs to exactly one Site; at most one active QRToken.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **QRToken**              | `bathroom_id`, `token_hash`, `status`                                                  | Stores a one-way hash of the token only; opaque and non-authorizing; replaceable/revocable.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **User**                 | `cognito_sub`, `phone`, `status`, `platform_role`                                      | Identity anchored to a Cognito subject; no passwords stored. `platform_role` ∈ {member, company_admin}, default `member`.                                                                                                                                                                                                                                                                                                                                                                                       |
| **SiteRole**             | `user_id`, `site_id`, `role`, `status`, `max_authorization_cents`, `bathroom_scope`    | Manager-created site authority; deny by default; distinguishes an authorized user from a customer. `role` ∈ {manager, authorized_user}; `status` ∈ {pending, authorized, revoked}. `max_authorization_cents` is `null` (unlimited) for a manager and a manager-set positive amount for an authorized user. Unique on `(site_id, user_id)` **among non-revoked rows only** (Phase 8) — a revoked role is kept as history and does not block the same identity being re-invited and reactivated at the same site. |
| **CleaningRequest**      | `bathroom_id`, `price_version`, `amount_cents`, `status`                               | Exactly one payment authorization per request in the MVP.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **PaymentAuthorization** | `request_id`, `stripe_payment_intent_id`, `status`                                     | Manual-capture; created fresh per request; never reused.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **RequestApproval**      | `site_id`, `bathroom_id`, `price_version`, `amount`, `requester_user_id`, `expires_at` | An authorized user's **over-limit** request awaiting a manager's approval. Single-use; 15-minute expiry; bound values invalidate the approval on change (§10).                                                                                                                                                                                                                                                                                                                                                  |
| **PublicAlert**          | `bathroom_id`, `note`, `created_at`                                                    | Non-billable; no associated PaymentIntent or CleaningRequest.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **SitePaymentMethod**    | `site_id`, `gateway_token`, `display_label`, `created_by_user_id`                      | **Mock only** (§9.4); one per Site (unique on `site_id`) — belongs to the Site, not the User who added it. `display_label` is a fixed mock string, never a real-looking free-text PAN.                                                                                                                                                                                                                                                                                                                          |

### 4.1 Referential notes

- `SiteRole.user_id` may reference a `User` created before or after the invite — the pending SiteRole exists independent of the `User` row until the bridge (§3.3) links them.
- `User.platform_role` is **platform-level** authority (cross-site, e.g. `company_admin`), orthogonal to the **site-scoped** authority carried by `SiteRole`. A `User` may hold `platform_role=company_admin` with zero, one, or many SiteRoles — the two are independent axes. `SiteRole.role` remains ∈ {manager, authorized_user} in all cases; Company Admin is never itself a `SiteRole.role` value.
- `CleaningRequest.price_version` anchors the price used at authorization time so later `Site.fixed_price_cents` changes cannot retroactively alter an in-flight or historical request.
- `PaymentAuthorization` is 1:1 with `CleaningRequest` in the MVP (no partial charges, no multiple holds per request).
- `SitePaymentMethod.site_id` is unique — at most one saved method per Site in this phase (§9.4). `created_by_user_id` is an audit reference only; it does not change who the method belongs to (the Site) or who may use it (any authorized Manager or authorized user at that Site, per §7).
- A `bathroom_id` may have any number of simultaneous non-terminal (`authorizing`/`authorized`) `CleaningRequest` rows — no per-bathroom cap (removed by explicit product decision, §9.4, changelog #029).

## 5. QR generation & resolution

- Tokens are **opaque, cryptographically random, non-sequential** — no bathroom ID, site ID, or other identifying structure is embedded in or derivable from the token.
- The server stores only a **one-way hash** of the token (never the raw token); resolution looks up the incoming scanned value by hash.
- QR resolution is **rate-limited** at the endpoint level to blunt brute-force enumeration (see AGENTS.md security rules on complete mediation and fail-safe defaults; hardened rate limiting is out of scope for MVP per §1.5).
- A **Company Admin** issues the initial QRToken for a Bathroom as part of onboarding (alongside creating the Site, Bathroom, and price). Tags are **revocable and replaceable**: a Company Admin can invalidate and reissue a QRToken for any Site, and a **Site Manager** may likewise replace the QRToken at their own site (e.g., a printed tag is lost or compromised), without any change to the Bathroom's identity or history.
- A resolved QRToken identifies a Bathroom **only**. It never authenticates a person and never itself authorizes any action — see §3 for why authority requires a separate SiteRole lookup.
- The raw token is shown **exactly once**, on the issuance/replace result page, and is never persisted or re-displayed afterward (only its hash is stored — see above). There is deliberately no "view current QR" recovery path: the printed/written tag itself is the only durable copy. If it's lost, the only remedy is to replace it, which is the same "Issue / replace QR" action as the initial issuance (changelog #015).
- The scan URL's scheme (`http://` vs `https://`) always matches the scheme the issuing request actually arrived over when `PUBLIC_BASE_URL` is unset — never hardcoded — so a QR issued from a local HTTPS dev server (§12/§13) doesn't encode a scheme mismatch (changelog #015).
- **NFC tags reuse the same token and URL** — there is no separate `NfcTag` entity or issuance path. The `GET /s/:token` URL rendered alongside every issued QR (§11.3) is the complete scan target for either medium: writing that same URL to an NFC tag (any standard NFC-writing phone app) is deliberately equivalent to printing the QR — same opaque token, same one-way hash lookup, same revoke/replace semantics, same rate limiting. A site with both a printed QR and a written NFC tag for one Bathroom is just two physical copies of one token until either is replaced.

## 6. Authentication (Amazon Cognito)

- Amazon Cognito is the managed passwordless identity provider: **SMS OTP** and **WebAuthn passkeys**.
- Cognito owns authentication end-to-end (OTP delivery/verification, passkey registration/assertion, session/token issuance). The application server never handles raw credentials.
- Successful Cognito authentication yields a `cognito_sub` used to look up (or create) the corresponding `User` row. It confirms identity only — see §3 for the strict separation from authorization.
- Cognito managed login (Hosted UI) is the assumed default for lowest implementation cost; see ARCHITECTURE.md for the stack decision.

### 6.1 SMS OTP activation path

- The user pool is configured for **choice-based passwordless** sign-in with `SMS_OTP` (and `WEB_AUTHN`, reserved for §6.2) as allowed first-auth factors; phone-number delivery is via SNS, and `phone_number` is an auto-verified attribute (`infra/modules/cognito`). This is authored in Terraform and validated in CI (`terraform validate`); no live AWS apply is in scope, and the application never sends SMS itself — delivery is Cognito's responsibility.
- The single Hosted UI login entry point (`GET /auth/login`) redirects to the managed login authorize endpoint requesting the `openid phone` scopes. Cognito presents the pool's allowed factors, so SMS OTP is offered without the application selecting a factor; the same entry point will surface passkeys once §6.2 lands.
- On success Cognito redirects to `GET /auth/callback`, which is **shared unchanged across all factors**: it validates the single-use `state`, exchanges the code, verifies the ID token via the pool JWKS (issuer, audience, `token_use=id`, signature), maps the subject to a `User`, and issues the signed session cookie. SMS OTP introduces no separate callback or session path.
- An SMS OTP sign-in verifies possession of the phone, so the ID token carries `phone_number_verified: true`. The server persists the `phone` on the `User` **only when it is verified**; an unverified value is discarded and never trusted as contact identity. This verified phone is the key later used to link a phone-addressed **pending SiteRole** invite to the authenticated identity (§4, §7 activation).
- Testing mocks Cognito end-to-end: the JWKS is injected locally and the token endpoint is stubbed (as in the PR #6/#7 auth tests), so the suite runs in CI with no external credentials and no real SMS.

### 6.2 Passkey (WebAuthn) enrollment path

- The user pool advertises `WEB_AUTHN` alongside `SMS_OTP` as an allowed first-auth factor and carries a `web_authn_configuration` (relying-party id + user-verification requirement) in `infra/modules/cognito`. As with SMS OTP this is authored in Terraform and validated in CI (`terraform validate`) only; no live AWS apply is in scope. Cognito owns passkey registration and assertion end-to-end — the application server never handles raw WebAuthn credentials, attestation, or the authenticator ceremony.
- Enrollment is initiated **only from an already-authenticated session**: `GET /auth/passkey/register` reads the signed session cookie and fails closed (401) when it is absent or invalid, so an anonymous caller can never start enrollment. When Cognito is unconfigured the route fails closed (503), matching the rest of the auth surface. Like `GET /auth/login`, it mints a single-use `state` into the same short-lived HttpOnly `rs_oauth_state` cookie and redirects to the Cognito managed login authorize endpoint; because a passkey is bound to identity (not a phone), it requests the `openid` scope only.
- Cognito performs the WebAuthn registration ceremony in managed login and redirects back to `GET /auth/callback`, which is **reused unchanged across all factors**: it validates the single-use `state`, exchanges the code, verifies the ID token via the pool JWKS, maps the subject to the same `User`, and re-issues the signed session cookie. Passkey enrollment introduces no separate callback, session, or token path — it reuses the existing state and session modules verbatim.
- Passkey enrollment is an **identity** action, not an authority action. Per §3, enrolling a passkey confirms who you are and grants zero site authority. Access is therefore gated solely by holding a valid session; it is deliberately **not** routed through the deny-by-default capability matrix (§7), which governs site/platform authority and would wrongly deny an ordinary authenticated user with no `SiteRole`. No role is branched on — every authenticated identity may enroll a passkey for itself.
- Testing mocks Cognito end-to-end exactly as §6.1: the enrollment route is driven with an injected session and the shared callback is exercised with a locally-signed ID token and a stubbed token endpoint, so the suite runs in CI with no external credentials and no live WebAuthn ceremony.

### 6.3 Demo invitation-code activation (DEMO_MODE)

This path exists **only** to let the full invite → accept → activation loop (§3.3) be
walked in a browser during demos and local development, without live SMS delivery or a
Cognito user pool. It is gated end-to-end behind a single `DEMO_MODE` environment flag
and is **inert in production**, where the flag is unset. Production activation remains
phone-verified via SMS OTP (§6.1) plus the §3.3 bridge; this path neither alters nor
weakens that production flow. Both consoles that create an invite — the Site Manager
console (§11.4) and the Company Admin console (§11.1, initial-manager invite) — surface
the resulting code under `DEMO_MODE`; see the "Code minting & display" bullet below.

- **Gating.** When `DEMO_MODE` is off (the production default): no invite code is
  generated or displayed, and the accept routes are **not registered at all** — a request
  to `/invite/accept` is an ordinary `404`. Every demo behaviour below is reachable only
  when the flag is on, so the production build carries the code but never exposes it.
- **Code minting & display.** When an authorized Site Manager creates an invite (§11.4),
  or a Company Admin creates the initial manager invite for a Site (§11.1), in
  `DEMO_MODE` the server mints a **single-use** code tied to that specific pending
  SiteRole and persists it (`demo_invite_codes`, one usable row per pending invite;
  repeat invites reuse the still-unused code rather than minting duplicates) via the same
  `issueDemoInviteCode` service call — there is no parallel minting path for the admin
  case. Whichever console created the invite then displays the code alongside a copyable
  `GET /invite/accept?code=…` link for that invite: the Site Manager console for invites
  it creates, and — as of this change — the Company Admin console for the initial manager
  invite it creates, so the very first invite of a new Site (which only a Company Admin
  can issue) is also click-through demoable. Both consoles render nothing extra when
  `DEMO_MODE` is off. The code binds a demo accept to one pending SiteRole; it confers no
  authority by itself.
- **Accept URL.** `GET /invite/accept` renders a form (the invited person types or
  arrives with a prefilled code) and mints a short-lived, origin-bound double-submit CSRF
  token into an HttpOnly `rs_demo_csrf` cookie plus a matching hidden form field. Because
  the accepter has no session yet, this pre-session `POST` is deliberately exempt from the
  session-bound CSRF gate (§11.3) — an exemption that is itself `DEMO_MODE`-gated and
  inert in production — and is protected instead by the double-submit token compared in
  constant time. `POST /invite/accept` validates that token, then validates the code.
- **One-step session + activation (reuses §3.3 unchanged).** On a valid, unused code the
  server claims it (marks it used in the same conditional write, so a concurrent or later
  reuse claims nothing) and then **stands in for SMS-OTP verification of the invited
  phone**: it resolves a deterministic demo identity whose _verified_ phone equals the
  invite's `invited_phone` (`findOrCreateUserByCognitoSub`, §6.1's persistence contract),
  then runs the **existing `bridgePendingSiteRoles` (§3.3) verbatim**. There is no parallel
  activation code path: the outcome is therefore identical to production — a `manager`
  invite is activated (`status → authorized`, the Site becomes operable per §11.1) and an
  `authorized_user` invite is likewise activated (`status → authorized`, the invitee can
  request service, self-authorizing up to their limit, §7/§10). The server then issues the same signed session cookie the
  Cognito callback issues (§6.1), so the accepter continues authenticated as that verified
  identity, and renders a result page reflecting the outcome.
- **Single-use.** The code is marked used at claim time; a second submission of the same
  code (or an unknown code) is rejected with no session minted and no bridge run. All
  authority is still re-derived from the SiteRole matrix (§7) on every subsequent request
  — the demo accept grants authority only because the reused §3.3 bridge set the resolved
  role to `authorized`, never through any bespoke elevation.

Testing mocks everything: codes and acceptance are exercised against the in-process PGlite
database with no AWS, no Cognito, and no real SMS.

### 6.4 Step-up re-authentication (recency check)

Added in Phase 3 (§9.4) as a general primitive: some sensitive actions require not just a
_valid_ session but a _recently established_ one — proof the caller authenticated (or
re-authenticated) within a short window, not merely that a long-lived session cookie is
still unexpired.

- `sessionAuthenticatedWithin(session, windowSeconds)` (`src/auth/guard.ts`) answers this
  from data the session already carries: `SessionPayload.iat` (§ session token shape) is
  stamped the moment Cognito authentication completes and is re-stamped on **every** full
  authentication (SMS OTP or passkey, both routed through the shared `/auth/callback`,
  §6.1/§6.2) — so `now - iat` is exactly "time since last authentication." No new session
  state, cookie, or column is introduced.
- The **first consumer** of this primitive is §9.4's saved-payment-method reuse gate
  (`POST /s/:token/authorize`), with a 5-minute window. It is a general-purpose helper, not
  payment-specific, so a later feature needing the same "recently authenticated" property
  can reuse it without inventing a parallel mechanism.
- **`next` redirect on `GET /auth/login`.** To make a step-up prompt actually return the
  caller to what they were doing, `GET /auth/login` now accepts an optional `next` query
  parameter. It is honored **only** if it matches a strict allow-list shape —
  `^/s/[A-Za-z0-9_-]+$`, exactly the QR scan path shape and nothing else (no scheme, no
  `//` protocol-relative form) — and is then stored in a new short-lived HttpOnly cookie
  (`rs_oauth_return_to`, same lifetime as the existing `rs_oauth_state` cookie).
  `GET /auth/callback` (unchanged/shared across every auth factor, §6.1–§6.3) redirects
  there instead of `/` once authentication completes, then clears the cookie. Any `next`
  value that does not match the allow-list is ignored — this is a narrow, purpose-built
  allow-list against open redirects, not a general redirect surface.
  `GET /auth/passkey/register` does not accept `next` (out of scope — it remains a pure
  identity action, §6.2) and always clears `rs_oauth_return_to` so a value set by an earlier
  `GET /auth/login` call can never leak into that flow.

Testing drives this through the same signed-session/injected-`nowSeconds` seams §6.1–§6.3
already use — no live Cognito, no real clock dependency.

## 7. Authorization

- **Deny-by-default, capability matrix.** Every state-changing endpoint is gated by an explicit capability matrix keyed by `(platform_role, SiteRole.role, SiteRole.status)`, scoped to the target Site (and `bathroom_scope` where applicable). A request is denied unless the matrix names an explicit allow for its endpoint given the caller's platform role and, where relevant, their SiteRole at the target Site.
- **Platform-level-only capabilities.** Creating or editing a Site or Bathroom, issuing the initial QRToken, setting/managing the fixed price (price versions), and capturing/canceling a PaymentAuthorization gate on `platform_role=company_admin`; no `SiteRole` (including `role=manager`) satisfies these.
- **Cross-cutting SiteRole-management capabilities (both axes).** `site_role:revoke` and `site_role:set_limit` are held by `company_admin` on the platform axis (cross-site) **and** by `manager` on the site axis (at their own site), the same way `qr_token:replace` sits on both axes. A Company Admin thus **revokes** a Manager or an authorized user, and **changes an authorized user's approval limit**, at any site; a Manager does the same for authorized users at their own site (a Manager also **deletes** an authorized user via `site_role:delete`, manager-only). `setAuthorizedUserLimit` rejects a non-`authorized_user` target on either axis.
- **Site-scoped capabilities.** Creating a CleaningRequest, authorizing a hold, saving a site's (mock) payment method, inviting a SiteRole (`site_role:invite`), deleting an authorized user (`site_role:delete`), replacing a QRToken at a site, and approving an over-limit request (`request:approve`) require an explicit, active `SiteRole` check scoped to the relevant Site. `cleaning_request:create` and `payment_method:save` (§9.4) are granted to `manager` and `authorized_user`; `site_role:invite`, `site_role:delete`, and `request:approve` are granted to `manager` only. None of these is held by `company_admin` on the platform axis: a Company Admin does not request cleanings, seed a site's payment method, invite/delete members, or approve requests.
- The server **never trusts** UI state, QR contents, or any client-submitted claim about role or authority. Every authorization decision is re-derived server-side from the current `platform_role` and `SiteRole` record at request time.
- Authorization checks precede any business logic (price lookup, Stripe call, etc.) — a request with insufficient authority fails closed before any side effect occurs.
- **`max_authorization_cents` bounds a paid request by role.** A `manager` has no limit (`null` = unlimited) and may authorize any amount directly. An `authorized_user` may self-authorize only up to their limit; a request **above** the limit is not denied outright but routed to a manager's approval (§10) — the hold is placed only once a manager grants it. A request is never authorized above the limit on the authorized user's own authority, regardless of what the client displayed.

## 8. Pricing

- Price is **always server-derived** from `Site.fixed_price_cents` (captured as `price_version` at request creation).
- Any amount submitted by the browser is **ignored**. The client may display the price for confirmation, but the server independently looks up and uses its own value when creating the PaymentIntent and the CleaningRequest.
- This prevents a manipulated client from requesting a cleaning at an arbitrary or zero price.

## 9. Payment lifecycle (Stripe, manual capture)

The payment authorization lifecycle is the heart of the system: **authorize a hold now, capture only after completion, and never reuse a hold.**

### 9.1 Flow

1. **Confirm.** The authorized requester scans the QR, authenticates via Cognito (passkey or OTP), and confirms the server-derived fixed price.
2. **Authorize.** The Site Manager (any amount), an authorized user (up to their limit), or a manager granting an authorized user's over-limit approval (§10) triggers the hold; the server creates a Stripe **manual-capture PaymentIntent** with a request-specific **idempotency key**. The `CleaningRequest` row is created only after the hold succeeds — a failed authorization creates no CleaningRequest and no PaymentAuthorization. Managers and authorized users can authorize a hold but can never capture or cancel one.
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

### 9.3 Phase 2 implementation: mocked payment gateway

Phase 2 implements the "authorize now" half of §9.1 (steps 1-3) against a `PaymentGateway`
interface, **not** the real Stripe SDK. This is a deliberate, explicit scope decision for
this phase (and Phase 3): no Stripe dependency, no live keys, no Payment Element, no real
card collection, and consequently no possibility of a real charge under any configuration.

- **`PaymentGateway` interface** (`src/payments/gateway.ts`): `authorize({amountCents,
idempotencyKey}) -> {gatewayId}`, `capture(gatewayId)`, `cancel(gatewayId)`. A future
  `StripeGateway` implements the same interface with no call-site changes elsewhere in the
  app — this is the seam Stripe integration lands behind, not a temporary shortcut that
  gets threaded through every call site again later.
- **`MockPaymentGateway`** always succeeds on `authorize` (there is nothing that could
  decline — no real card is ever collected in this phase) and returns an id prefixed
  `mock_pi_` so it can never be mistaken for a real Stripe id (`pi_...`) in logs, tests, or
  the admin console. `capture`/`cancel` are no-ops on the gateway side; the system's own
  `PaymentAuthorization.status` — checked before the gateway is ever called — is what
  actually prevents an invalid transition (e.g. capturing an already-canceled hold),
  exactly as it will once a real gateway replaces this one.
- **Price and authorization ordering are unchanged from §7/§8/§9.1**: the amount used is
  read from `Site.fixed_price_cents` server-side, the `create_cleaning_request` /
  `capture_payment` / `cancel_payment` capability check runs before any gateway call or
  write, and a failed authorization (not reachable via the mock today, but preserved as a
  contract for the real gateway) still creates neither a `CleaningRequest` nor a
  `PaymentAuthorization` row.
- **Not implemented in this phase**: automatic expiry-to-void (inherently
  webhook/scheduler-driven against a real Stripe integration — §9.1 step 4's alerting is
  deferred with it) and Stripe webhook processing (§9.2's verified-webhook invariant applies
  once a real gateway exists; there is no webhook surface to secure yet because there is no
  external payment processor in this phase).

### 9.4 Phase 3: saved (mock) payment method, repeat-request reuse, step-up re-auth

Phase 3 lets an authorized Manager or authorized user save a **mock** payment method for their site
and reuse it on later requests, and adds a duplicate-active-request guard. Still no Stripe:
`PaymentGateway` (§9.3) is untouched — the mock gateway needs no card reference at all, and
threading one through before a real gateway exists to consume it is deferred.

- **`SitePaymentMethod` belongs to the Site, not the User** (§4). Decision and rationale
  recorded in full in `docs/phase3-saved-payment-method-plan.md`; summary: this is a
  facilities expense the site pays for, the rest of the payment model
  (`fixed_price_cents`, `max_authorization_cents`) is already site-scoped, and a per-user
  card would create a dangling-funding-source failure mode on staff turnover that a
  site-owned record cannot have. At most one saved method per Site (`site_id` unique).
- **No card-shaped UI, even mocked.** The only payment-method action is a single "Add a
  payment method (mock)" button (`POST /s/:token/payment-method`, §11.7) that creates a
  synthetic record server-side: a fixed mock `display_label` (e.g. `"Mock Visa •••• 4242"`)
  and a `gateway_token` prefixed `mock_pm_` (never resembling a real Stripe payment-method
  id) — no free-text PAN/CVV/expiry field exists anywhere in this phase, deliberately, to
  avoid creating a UI pattern that invites real card collection later.
- **Repeat-request reuse.** `GET /s/:token` (amended again, §11.7) now renders one of three
  states for a caller who already clears `create_cleaning_request` (§7, unchanged gate):
  no saved method → the add-method form; saved method + recently authenticated (§6.4) →
  the authorize form (now also showing the saved method's mock label); saved method + stale
  session → a re-authenticate prompt, no authorize button. `POST /s/:token/authorize`
  independently re-derives and re-checks both conditions before ever calling the gateway —
  the `GET` state is a convenience, never the enforcement point (same "authorization
  precedes any business logic" principle as every other action in §7).
- **Step-up re-authentication gates reuse, not addition.** `POST /s/:token/authorize`
  requires the site to already have a saved method (`409` if not — "add a payment method
  before authorizing a hold") **and** requires `sessionAuthenticatedWithin(session, 300)`
  (§6.4) to hold (`401` — "re-authentication required" — otherwise, with a
  `GET /auth/login?next=/s/:token` path back into the flow). This check runs uniformly on
  every authorize against an existing saved method, including the very first authorize in
  the same visit immediately after adding it — see
  `docs/phase3-saved-payment-method-plan.md` for why no just-added exception exists.
  `POST /s/:token/payment-method` itself carries no recency requirement — only _placing a
  hold_ is gated, matching the literal scope of the requirement and creating no
  money-movement bypass (adding a mock record moves no money by itself).
- **No duplicate-active-request guard.** Phase 3 originally added one here: `createCleaningRequest`
  rejected a second non-terminal `CleaningRequest` for the same bathroom (backstopped by a
  partial unique index, `cleaning_requests_bathroom_active_key`). **Removed by explicit
  product decision** (changelog #029) — a bathroom may now have any number of simultaneous
  non-terminal requests, each its own independent `CleaningRequest`/`PaymentAuthorization`
  pair, captured or canceled independently. `DuplicateActiveRequestError` no longer exists;
  a concurrent double-tap now succeeds as two independent requests rather than one `200` and
  one `409`.

## 10. Over-limit approval for authorized users

An **authorized user** may self-authorize a hold up to their `max_authorization_cents`
(§7). A request **above** that limit is not placed on the authorized user's own authority;
instead it is held for a manager's approval:

- The authorized user's over-limit `POST /s/:token/authorize` creates a `RequestApproval`
  bound to a specific `site_id`, `bathroom_id`, `price_version`, `amount`, and
  `requester_user_id`, with `status=pending`. No PaymentIntent and no `CleaningRequest` is
  created at this point — nothing moves until a manager approves.
- The approval is **single-use** and expires **15 minutes** after creation.
- **Changing any bound value invalidates the approval** — if the site's price version
  changes (a new fixed price), or a different bathroom or amount is implied, the previously
  issued approval can no longer be exercised and a new one must be created.
- Only a **manager** for that site can grant the approval (`request:approve`). Granting it
  re-validates the binding (not expired; the site's current fixed price still equals the
  bound amount), then places the hold via the normal authorization path (§9.1 step 2, mock
  gateway) and marks the approval `used`. The site must already have
  a saved (mock) payment method (§9.4) — `409` otherwise. The scan-page step-up recency
  check (§6.4) is a control on the self-service scan-and-authorize path; it is not re-imposed
  on this deliberate console management action (like admin capture/cancel, which also carry
  no step-up). A manager has no authorization limit, so a manager may approve any amount.
  Granting an approval authorizes exactly the one bound request; it does not change the
  authorized user's `max_authorization_cents` — a manager adjusts a limit explicitly (§11.4).
- A `manager`'s own request is never routed here — a manager self-authorizes directly.

## 11. Onboarding & public visitor flow

### 11.1 Company Admin onboarding flow (entry flow)

A new Site enters the system only through a Company Admin, in this order:

1. **Create the Site** — `name`, `address`, `timezone`, `currency`, `terms`.
2. **Create its Bathrooms**.
3. **Issue a QRToken** for each Bathroom (§5).
4. **Set the fixed price** (`fixed_price_cents`, establishing the first `price_version`; §8).
5. **Invite the initial Manager** by identifier, creating a pending `role=manager` SiteRole (§3.3) — the invitee becomes an active Manager once they authenticate through Cognito and the bridge links their identity. Idempotent like the Site Manager invitation flow (§11.4): a repeat invite of the same not-yet-linked phone at the same Site returns the existing pending record rather than inserting a duplicate row, so the §3.3 bridge never faces two pending invites for the same phone+site+role from this path.

Only a Company Admin can perform steps 1–4; no Site, Bathroom, QRToken, or price can exist without one. Step 5 is the last Company Admin action required before the Site is operable — subsequent day-to-day requesting and hold authorization happen under a Manager's SiteRole. The Company-Admin console lists, per site, both **managers and authorized users** (with each authorized user's approval limit); a Company Admin may **revoke** a Manager or an authorized user (`site_role:revoke`) and **change an authorized user's approval limit** (`site_role:set_limit`) at any site (§7), alongside the Manager's own membership management at their site (§11.4).

### 11.2 Public visitor flow

- A visitor scan by anyone **without authorized site authority at the resolved site** —
  whether anonymous, authenticated with no SiteRole, an invited-but-not-yet-accepted
  (`pending`) member, or a manager/authorized user authorized at a _different_ site — always resolves to a
  **generic, neutral page**: "Need this restroom cleaned? Notify staff."
- This page **never reveals**: price, billing status, manager identity, request queue, or history.
- The visitor may optionally submit a **non-billable `PublicAlert`** — this never creates a PaymentIntent, a CleaningRequest, or any payment obligation.
- **Pre-activation privacy:** if a Site has not yet had a manager activate it, a scan still shows the same neutral page — it does not disclose that the site lacks a manager, which would otherwise leak operational state to an unauthenticated visitor.
- **Authorized callers see more, deliberately.** A caller who already holds an authorized `manager`/`authorized_user` SiteRole at the resolved site — the _only_ case this applies to — sees the price-confirmation flow (§9.3, §11.6) instead. This is not a weakening of the invariant above: it requires authority the matrix (§7) already grants independent of the QR, the same authority that already lets a manager replace the QR at their own site (§5). Nothing is revealed to anyone who lacks that authority.

### 11.3 Phase 0 HTTP surface (implementation)

The Phase 0 vertical slice realizes the flows above with these routes; all authorization is re-derived server-side through the deny-by-default capability matrix (§7), never from client input:

- `GET /admin` — Company Admin console. Requires an authenticated session whose `platform_role=company_admin` (checked via the matrix); an authenticated non-admin receives `403`, an unauthenticated caller is redirected to login.
- `POST /admin/sites` — create a Site with `name`, `address`, `timezone`, `currency`, and `fixed_price_cents` (gated on `site:create`).
- `POST /admin/sites/:siteId/bathrooms` — add a Bathroom to a Site (gated on `bathroom:create`).
- `POST /admin/sites/:siteId/bathrooms/:bathroomId/qr` — issue a fresh opaque QRToken, revoking any prior active token for that Bathroom (gated on `qr_token:issue`). The raw token is rendered once into an inline SVG QR encoding the public scan URL; only its one-way hash is persisted (§5).
- `POST /admin/sites/:siteId/managers` — invite the initial Site Manager by phone, creating a pending `role=manager` SiteRole (gated on `site_role:invite_initial_manager`; §3.3). Idempotent and reported as such (§11.4): re-inviting a phone that already holds a non-revoked SiteRole at the site inserts no row and signals "already a member".
- `POST /admin/sites/:siteId/roles/:roleId/revoke` — revoke a SiteRole (a Manager **or** an authorized user) at `:siteId`, setting `status=revoked` (gated on `site_role:revoke`, held by `company_admin` on the platform axis; §7). The target's `site_id` is re-derived from `:roleId` server-side and checked against `:siteId` before the gate. A revoked role confers no authority and cannot be redeemed by the bridge again (§3.3).
- `POST /admin/sites/:siteId/roles/:roleId/limit` — (Phase 7) change an authorized user's `max_authorization_cents` (gated on `site_role:set_limit`, held by `company_admin` on the platform axis; §7). Positive amount required; rejects a target that is not an `authorized_user` at `:siteId`. Mirrors the manager's own set-limit route (§11.4).
- `GET /s/:token` — public scan resolution. Rate-limited hash lookup (§5), then a neutral "see staff" page (§11.2) **for any caller without authorized site authority at the resolved site**. For that population the response is byte-for-byte identical whether the token is active, revoked, or unknown, whether or not the Site has an activated manager, and whether or not the caller is authenticated — no oracle. It creates no PaymentIntent and writes no data. (An authorized Manager or authorized user at the resolved site instead sees the price-confirmation flow — §9.3, §11.6; that population is the sole, deliberate exception, per §11.2.)

All onboarding `POST`s are state-changing and therefore require the existing session-bound CSRF token (§ CSRF guard); the Company Admin console submits them via a small progressive-enhancement ES module that echoes the token in the `x-csrf-token` header. The public scan page loads no such requirement and ships ~0 KB JS.

> **Deferred in this slice — public `PublicAlert` affordance.** The neutral page does not yet expose an interactive "notify staff" submission. The global CSRF guard requires an authenticated session for every state-changing request, and an anonymous state-changing endpoint would be a spam/CSRF surface (hardened rate limiting and duplicate protection are out of scope for MVP per §1.5). The `PublicAlert` entity and the non-billable alert flow remain specified (§4, §11.2) and will be added behind an appropriate anti-abuse control in a later phase; deferring it keeps complete mediation intact rather than shipping a weaker anonymous mutation.

### 11.4 Phase 1 HTTP surface — Site Manager invitation flow (implementation)

This slice generalizes the Company Admin's initial-manager invite (§11.1, §11.3) so an
authorized Site Manager can invite additional members — another manager or an authorized
user — to their own site, and (Phase 6) manage their authorized users. It reuses the
`invite_site_role` action / `site_role:invite` capability that the matrix (§7) already
grants to an authorized `role=manager` SiteRole at its own site; Company Admin authority
(`invite_initial_manager`) is unchanged and orthogonal.

- `GET /manager` — Site Manager console. Requires an authenticated session; lists every
  Site where the caller holds an `authorized` `role=manager` SiteRole, each with its
  members (managers and authorized users, by status), its pending over-limit approvals, and
  an invite form. This is a self-scoped read (filtered by the caller's own `user_id`), so
  an authenticated customer or authorized user simply sees an empty console — never another
  manager's sites.
- `POST /manager/sites/:siteId/invites` — invite a user by phone as `manager` or
  `authorized_user` at `:siteId`, creating a pending SiteRole (`user_id=null`,
  `status=pending`; gated on `site_role:invite`, scoped to `:siteId`). For an
  `authorized_user` an **authorization limit** (`max_authorization_cents`, a positive whole
  number of cents) is required and stored on the pending row; a `manager` invite stores
  `null` (unlimited). A repeat invite for the same phone at the same site is **idempotent
  and reported as such**: if any non-revoked SiteRole (pending _or_ accepted) already exists
  for that phone at the site, no row is inserted and the response signals "already a member"
  rather than "invited". Rate-limited per authenticated user. **This phase persists a DB
  record only — no SMS/OTP is sent.**
- `POST /manager/sites/:siteId/roles/:roleId/limit` — change an authorized user's
  `max_authorization_cents` (gated on `site_role:set_limit`; positive amount required).
  Rejects a target that is not an `authorized_user` at `:siteId`.
- `POST /manager/sites/:siteId/roles/:roleId/delete` — delete an authorized user, removing
  their SiteRole row (gated on `site_role:delete`). Works whether the invite is still
  pending or already accepted; rejects a target that is not an `authorized_user` at
  `:siteId` (a manager is revoked by a Company Admin, §11.1).
- `POST /manager/approvals/:id/approve` — grant a pending over-limit `RequestApproval`
  (gated on `request:approve`, resolved against the approval's own `site_id`), placing the
  hold per §10.

Every `POST` here is state-changing and requires the same session-bound CSRF token as the
Company Admin console (§11.3); the manager console submits them via the same
progressive-enhancement pattern (`x-csrf-token` header), inert without JS.

### 11.5 Phase 1 HTTP surface — passkey (WebAuthn) enrollment (implementation)

This slice adds the authenticated-session entry point that lets any signed-in identity
enroll a WebAuthn passkey with Cognito for fast repeat authentication (§6.2). It reuses the
Hosted UI redirect pattern of `GET /auth/login` (§6.1) and the factor-shared
`GET /auth/callback` verbatim — no new callback, session, or token path is introduced.

- `GET /auth/passkey/register` — initiates passkey enrollment. Reads the signed session
  cookie and fails closed with `401` when it is absent or invalid, so enrollment can only
  start from an already-authenticated session; returns `503` when Cognito is unconfigured,
  matching the rest of the auth surface. On success it mints a single-use `state` into the
  same short-lived HttpOnly `rs_oauth_state` cookie and `302`-redirects to the Cognito
  managed login authorize endpoint requesting the `openid` scope only (a passkey binds to
  identity, not a phone). Cognito runs the registration ceremony and redirects back to
  `GET /auth/callback` (§6.1), which re-issues the session unchanged.
- This is a safe (idempotent, `GET`) navigation that starts an OAuth redirect exactly like
  `GET /auth/login`, so it carries no request body and is not a CSRF surface. Enrollment is
  an **identity** action (§3, §6.2): it is gated solely by a valid session and is
  deliberately not routed through the capability matrix (§7), which governs site/platform
  authority; no role is branched on.

### 11.6 Phase 2 HTTP surface — cleaning request + payment authorization (implementation)

Realizes §9.1 steps 1-3 and §9.3's mocked gateway. All authorization is re-derived
server-side through the deny-by-default matrix (§7); the amount is always server-derived
(§8); nothing here is a new capability or role.

- `GET /s/:token` (amended) — as §11.3, with one addition: if the caller has a valid
  session **and** an authorized `manager`/`authorized_user` SiteRole at the resolved site,
  the response is a price-confirmation page (site name, exact fixed price, an authorize
  form) instead of the neutral page. For an authorized user whose limit is below the site
  price, the form is labeled "Request approval" (the hold is placed only after a manager
  approves, §10) rather than "Authorize hold". Anyone else gets the unchanged, byte-identical
  neutral page (§11.2).
- `POST /s/:token/authorize` — requires an authenticated session (`401` otherwise);
  re-resolves the token and the site's current price server-side, then gates on
  `create_cleaning_request` (siteId, bathroomId, that server-derived amount) via the
  matrix. On an allow, creates the hold via the gateway (§9.3) and, only once it succeeds,
  the `CleaningRequest` (`status=authorized`) and `PaymentAuthorization`
  (`status=requires_capture`) rows, then renders a confirmation page. **If the matrix denies
  solely because the amount exceeds an `authorized_user`'s limit (`exceeds_max_authorization`),
  the route instead records a pending `RequestApproval` (§10) and renders an "awaiting
  manager approval" page — no hold, no `CleaningRequest`.** Any other denial is the usual
  `403`. State-changing, so it requires the same session-bound CSRF token as every other
  console mutation (§11.3).
- `GET /admin/payments` — Company-Admin-only (`payment:view`-equivalent platform access;
  gated the same way onboarding is, on `platform_role=company_admin`) listing of every
  outstanding (`requires_capture`) `PaymentAuthorization` with its `CleaningRequest`.
- `POST /admin/payments/:id/capture`, `POST /admin/payments/:id/cancel` — gated on
  `capture_payment` / `cancel_payment` respectively, scoped to the target request's site
  (resolved server-side from `:id`, never a client-supplied site claim). Rejects with `409`
  if the authorization is not currently `requires_capture` (e.g. already captured/canceled)
  before ever calling the gateway. Both are state-changing and CSRF-protected like every
  other admin mutation.

`price_version` is recorded as `1` for every request created in this phase — there is no
price-history mechanism yet (`price:manage`, §7, remains specified but unwired to a route,
as already noted for other not-yet-built capabilities). Revisit once price editing ships.

### 11.7 Phase 3 HTTP surface — saved payment method, repeat request, step-up (implementation)

Realizes §9.4 and §6.4. All authorization is re-derived server-side through the
deny-by-default matrix (§7); nothing here is a new role.

- `GET /s/:token` (amended a third time) — for a caller who clears `create_cleaning_request`
  (§11.6's gate, unchanged), renders one of three states instead of always the authorize
  form: no saved method → the "Add a payment method (mock)" form; saved method and
  `sessionAuthenticatedWithin(session, 300)` holds (§6.4) → the authorize form, now showing
  the saved method's mock label; saved method and that check fails → a re-authenticate
  prompt linking to `GET /auth/login?next=/s/:token`, no authorize form rendered. Everyone
  without site authority still gets the byte-identical neutral page (§11.2, unchanged).
- `POST /s/:token/payment-method` — requires an authenticated session (`401` otherwise) and
  the session-bound CSRF token like every other console mutation (§11.3); re-resolves the
  token server-side, then gates on `save_payment_method` (siteId) via the matrix (`403` if
  denied). Creates the site's saved method (`409` if one already exists — no silent
  overwrite, no parallel create path). Renders whichever of the two saved-method `GET`
  states above now applies, so "add, then authorize" is two clicks without a full page
  navigation — without skipping the step-up check that immediately follows.
- `POST /s/:token/authorize` (amended again) — after the existing `create_cleaning_request`
  gate (§11.6, unchanged: session, token/price resolution, matrix check, all before any
  side effect), two new checks precede the gateway call: `409` if the site has no saved
  payment method yet, then `401` if `sessionAuthenticatedWithin(session, 300)` does not hold
  (§6.4). On success, calls `createCleaningRequest` as before; no duplicate-active-request
  mapping exists any more (§9.4, changelog #029).
- `GET /auth/login` (amended) — accepts an optional `next` query parameter honored only
  against the `^/s/[A-Za-z0-9_-]+$` allow-list (§6.4); stored in a new short-lived HttpOnly
  `rs_oauth_return_to` cookie. `GET /auth/callback` (unchanged/shared across every auth
  factor) redirects there instead of `/` once authentication completes, then clears the
  cookie. `GET /auth/passkey/register` is unaffected except that it now also clears
  `rs_oauth_return_to` on every call, so a value set by an earlier login attempt can never
  carry into an enrollment redirect.

## 12. Security invariants

| Invariant                      | Statement                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity ≠ authority           | Cognito authentication proves who a user is; only a manager-created SiteRole grants site authority, and only internal provisioning grants `platform_role=company_admin`. No self-service path elevates a customer to an authorized user, a manager, or a Company Admin.                                          |
| Authorize by capability matrix | Every state-changing endpoint validates against a capability matrix keyed by `(platform_role, SiteRole.role, SiteRole.status)`, scoped to the target site. Deny by default; never trust UI, QR contents, or client claims.                                                                                       |
| Fresh hold each time           | Every paid request creates a new PaymentIntent. A prior hold is never reused for another bathroom or request.                                                                                                                                                                                                    |
| No raw card data               | Card entry happens only in Stripe's UI. The system stores Stripe IDs and never logs card data or client secrets.                                                                                                                                                                                                 |
| Opaque, hashed QR              | Random, non-sequential tokens; only a one-way hash is stored; resolution is rate-limited; tags are revocable/replaceable.                                                                                                                                                                                        |
| Over-limit approval binding    | An authorized user's over-limit request approval is single-use and bound to site, bathroom, price version, amount, and requester; changing any bound value invalidates it (§10). A manager (no limit) grants it; the hold is placed only on grant.                                                               |
| Verified webhooks              | Stripe webhooks are signature-verified and processed idempotently to update payment status.                                                                                                                                                                                                                      |
| Managed secrets                | Stripe keys and Cognito/DB credentials live in AWS Secrets Manager; never hardcoded, never in logs or diffs.                                                                                                                                                                                                     |
| No card-shaped mock UI         | The only payment-method UI action is "Add a payment method (mock)" (§9.4); no free-text PAN/CVV/expiry field exists anywhere, even fake, to avoid a pattern that invites real card collection later.                                                                                                             |
| Step-up on reuse               | Reusing a saved (mock) payment method to place a new hold requires the session to have authenticated within the last 5 minutes (§6.4, §9.4); the server independently re-checks this on every `POST /s/:token/authorize`, not just in the UI.                                                                    |
| No concurrent duplicate holds  | At most one non-terminal `CleaningRequest` may exist per bathroom at a time, enforced by a read-check plus a partial unique index (§9.4); a race is a clean `409`, never an unhandled `500`.                                                                                                                     |
| Cookies always Secure          | Every cookie (session, OAuth state, demo double-submit CSRF) is marked `Secure` unconditionally, with no environment-based exception (§13, changelog #014). Local development therefore runs over real HTTPS via a locally-trusted cert (mkcert), not plain `http://localhost` — see README "Local development". |

## 13. Confirmed stack decisions

These decisions are locked pending final sign-off on the Blueprint (`art_RUHUe0PF`, v0.3) and are detailed in ARCHITECTURE.md:

- **Stack:** No-framework, no-bundler Lean SSR — TypeScript on Node.js, native `node:http` + a small typed router, server-rendered HTML via template literals, progressive-enhancement vanilla ES modules, hand-authored mobile-first CSS. Single-deployable modular monolith.
- **Deploy:** AWS via Terraform — App Runner (SSR), RDS/Aurora Serverless v2 PostgreSQL, Secrets Manager, ACM + Route 53, region `us-east-1`.
- **Auth:** Amazon Cognito managed passwordless — SMS OTP + passkeys, via Cognito managed login (Hosted UI). Cognito owns authentication; the application server owns authorization (SiteRole).
- **Identity vs. authority:** customer = no SiteRole; authorized_user/manager = manager-created SiteRole (pending until accepted, then authorized); Company Admin = platform-level `platform_role=company_admin`, provisioned internally/seeded (or granted by an existing Company Admin), never via self-service, QR, or Cognito login. No self-service elevation to any of these (§3).
- **Payments:** Stripe manual-capture PaymentIntents with idempotency keys; capture/cancel is Company-Admin/internal-backend only; server-derived price (§8, §9). **Phase 2/3/6 implement this against a mocked `PaymentGateway` (§9.3) — no Stripe SDK, no live keys, no real card collection or money movement — with the real Stripe integration tracked as a later, separate task behind the same interface.** Phase 3 adds a site-scoped mock saved payment method with no card-shaped UI and a step-up re-authentication gate on reusing it (§6.4, §9.4) — Phase 3 also originally added a duplicate-active-request guard, later removed by explicit product decision (§9.4, changelog #029). Phase 6 adds the two-tier site model (manager = unlimited; authorized user = manager-set limit with over-limit requests routed to a manager's approval, §10).
- **Database:** Aurora Serverless v2 PostgreSQL with Drizzle ORM for typed, parameterized queries and migrations.
- **Public alerts:** neutral "see staff" page only for MVP (§11).
- **Delivery:** build and host in the sandbox first; PR into `main` and AWS deploy only after human review, per the Blueprint's sandbox-first build plan.

Each new dependency (Drizzle, Stripe SDK, `qrcode`, AWS SDK) and each managed service (Cognito, RDS/Aurora, App Runner) is justified above and in ARCHITECTURE.md before adoption, per AGENTS.md's minimal-dependency rule.

## Changelog

Per AGENTS.md's binding spec-changelog rule, every change to this spec appends an entry
here. Format:

- **Entry number:** sequential, zero-padded to three digits (`#001`, `#002`, …).
- **Timestamp:** ISO-8601 date-time with UTC offset, in the America/New_York time zone.
- **Description:** a concise statement of what changed and why.

### #034 — 2026-08-25T00:00:00-04:00

**Bugfix (deployment, no product-facing change)**: #033's fix was necessary
but not sufficient. The user's next real `terraform apply` did force a fresh
instance replacement (confirmed: user-data actually ran on a new instance
this time), but `.env` still didn't exist and `docker-compose ps` failed the
same way. `/var/log/cloud-init-output.log` this time showed Certbot
succeeding as before, then:

    /var/lib/cloud/instance/scripts/part-001: line 71: crontab: command not found

Root cause: AL2023's minimal AMI does not install `cronie` (the package that
provides the `crontab` binary) by default -- only `docker` and `git` were
`dnf install`ed. #033's `crontab -l 2>/dev/null || true` fix correctly
absorbed the _first_ `crontab -l` invocation's failure inside its own
subshell, but the pipe's _second_ `crontab -` invocation (the one that
actually installs the new cron job) sits outside that subshell with no error
suppression at all -- "command not found" there is a real, unhandled
failure under this script's `set -euo pipefail`, aborting the script at the
same spot as #033's bug, just one step later.

Fix: `dnf install -y docker git cronie` plus `systemctl enable --now crond`,
added right after the initial `dnf update -y`. Verified via the same
`templatefile()`-plus-`bash -n` render process as #030/#033; `terraform fmt
-check -recursive` and `terraform validate` against both compositions.

Not yet confirmed end-to-end against a fresh apply/boot at the time of this
entry -- same caveat as #033 (another forced instance replacement, database
reset, and re-promotion to `company_admin` needed to prove this was actually
the last blocker).

### #033 — 2026-08-24T23:30:00-04:00

**Bugfix (deployment, no product-facing change)**: with #032's fix, the
instance finally replaced correctly and the security-group deadlock
resolved, but the site still showed `ERR_CONNECTION_REFUSED` on port 443.
Diagnosed over several rounds (an unrelated SSH red herring first: `ssh
ec2-user@<eip>` was unreachable because `allowed_ssh_cidr` had been
accidentally set to the instance's own Elastic IP instead of the user's
actual IP -- a copy-paste mix-up, fixed with a plain in-place `terraform
apply` of the correct CIDR, no instance impact). Once SSH access was
restored: `/opt/app/.env` did not exist at all, and `docker-compose ps` -- run
from the correct directory this time, ruling out the CWD/`.env`-auto-load
gotcha as a factor -- failed with every variable "not set" and `no port
specified: 443:<empty>`. `sudo certbot certificates` confirmed Certbot itself
had succeeded.

Root cause, confirmed by reading `user_data.sh.tpl` in light of where
execution actually stopped (right after the confirmed-successful Certbot
step, before `.env` or `docker-compose up` ever ran): the crontab-setup line

    (crontab -l 2>/dev/null; echo "...") | crontab -

fails on every fresh instance, where root has no crontab yet -- `crontab -l`
exits non-zero, and since it's not last in its `;`-joined subshell sequence,
the script's own `set -euo pipefail` aborted the whole script right there.
Confirmed by direct simulation (a standalone script reproducing the same
`set -euo pipefail` + a stubbed always-failing `crontab -l`) that the old
line aborts and the fixed one does not, rather than reasoning about bash
semantics alone -- this exact class of "reasoned but didn't verify" mistake
already cost real time earlier in this session (#019).

Fix: `crontab -l 2>/dev/null || true` absorbs the expected "no crontab yet"
failure. Verified via the same `templatefile()`-plus-`bash -n` process as
#030, plus the standalone simulation above.

Not yet confirmed end-to-end against a fresh apply/boot at the time of this
entry -- the user will need one more `terraform apply` (another forced
instance replacement per #032's `user_data_replace_on_change`, another
database reset, another re-promotion to `company_admin` afterward) to prove
this was the last blocker in the boot sequence.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`).
`npm test`/`lint`/`build` unaffected (no `src/` changes).

### #032 — 2026-08-24T23:00:00-04:00

**Bugfix (deployment, no product-facing change)**: with #031's apostrophe fix
in place, the user's next real `terraform apply` (#030's domain/SSL change)
hung for 10+ minutes on `module.ec2_host.aws_security_group.this: Still
destroying...`, never completing. Confirmed against a real deploy:
`aws ec2 describe-instances` showed the OLD instance still `running` the
entire time -- it was never being replaced, so its network interface never
released the security group AWS was refusing to let Terraform delete
("DependencyViolation," retried silently by the provider rather than
surfaced). The plan summary (`1 to add, 3 to change, 1 to destroy`) confirmed
only the security group was queued for replacement; the instance was merely
one of the 3 in-place changes.

Root cause, confirmed via research rather than assumed (this repo has no
record of ever setting it, and every prior changelog entry describing
`user_data` changes in this file -- #017, #021 through #030 -- assumed a
`user_data` change always forces a full instance replacement): the AWS
provider's actual default, without `user_data_replace_on_change = true` set
on `aws_instance`, is to treat a `user_data` change as an in-place update that
merely **stops and starts** the existing instance -- not a replacement. Worse,
even that stop/start would never have actually run the new Certbot/domain
setup: cloud-init only executes first-boot user-data once per instance ID, so
restarting the same instance does not re-trigger it. Every prior "this forces
replacement" claim in this file's history (going back to #017, before this
session's Certbot work even existed) was accurate only by accident, because
no change since the instance's creation had touched `user_data` without also
touching something else that independently forced replacement (e.g. the AMI,
before #026's `ignore_changes` fix) -- until this apply, which changed only
`user_data` content (domain name, Certbot script) with nothing else forcing
replacement, exposing the gap for the first time.

Fix: `user_data_replace_on_change = true` on `aws_instance.this`
(`infra/modules/ec2_host/main.tf`). This also resolves the immediate deadlock
as a side effect, not just the underlying gap: once the instance is correctly
queued for replacement too, Terraform's dependency graph destroys it (which
depends on the security group) before destroying the security group itself,
instead of leaving the still-running old instance holding the security
group's network interface open indefinitely.

The user was advised to interrupt the hung `apply` with Ctrl-C (Terraform
handles this gracefully -- finishes its current state write, then stops
cleanly) rather than let it continue retrying indefinitely, since the
dependency-ordering problem this exposed could not have resolved on its own
no matter how long it kept retrying.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`). Not
yet confirmed end-to-end against a fresh `terraform plan`/`apply` showing the
corrected replacement/destroy-ordering behavior at the time of this entry.
`npm test`/`lint`/`build` unaffected (no `src/` changes).

### #031 — 2026-08-24T22:30:00-04:00

**Bugfix (deployment, no product-facing change)**: #030's `terraform apply`
(the second, real apply, after the Elastic-IP-only first apply and a
confirmed-resolving DNS record) failed immediately with:
`"ingress.0.description" doesn't comply with restrictions
("^[0-9A-Za-z_ .:/()#,@\[\]+=&;{}!$*-]*$"): "App (real HTTPS via Let's
Encrypt)"` (and the same for the port-80 rule's description). Confirmed
against a real deploy: an `aws_security_group` ingress/egress rule's own
`description` field is validated against a stricter character set than the
security group's own top-level `description` (which allows apostrophes
fine, per the same plan output showing no error on it) -- ingress/egress
rule descriptions do not allow apostrophes at all.

Fix: reworded "Let's Encrypt" to "Lets Encrypt" in the two ingress rule
descriptions this composition added in #030 (`infra/modules/ec2_host/
main.tf`). Cosmetic only, no functional change. Checked the rest of this
composition's Terraform string literals for the same risk (grep for `'`
across `ec2_host/main.tf`, `lean/main.tf`, `modules/cognito/main.tf`) --
every remaining apostrophe is inside a `#` comment, never reaching AWS, so
this is the only fix needed.

The plan output the user pasted alongside this error is otherwise
reassuring: both Cognito resource changes showed as `~ update in-place`
(not replacement), confirming the domain switch doesn't force-recreate the
user pool or its client. Whether `aws_instance.this` itself will show as an
in-place update or a replacement (expected either way per #030, since
`user_data` genuinely changed) wasn't yet visible -- the plan aborted at the
security group validation error before reaching that resource. Still
unconfirmed at the time of this entry.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`), plus
a manual grep sweep for any other apostrophe in an AWS-facing field value
(not a comment). `npm test`/`lint`/`build` unaffected (no `src/` changes).

### #030 — 2026-08-24T22:00:00-04:00

**Feature (deployment)**: the lean EC2 deployment now serves over a real
domain with a real, browser-trusted TLS certificate (Let's Encrypt via
Certbot), instead of a bare Elastic IP with a self-signed cert the browser
warns about on every visit. As a direct consequence, WebAuthn/passkey
enrollment -- previously an explicitly documented limitation of this
deployment, since WebAuthn requires a real registrable domain and can't work
against a bare IP -- now works here too, not just SMS OTP.

- New required variable `domain_name` (`infra/lean/variables.tf`): the real
  domain/subdomain the user points at this deployment's Elastic IP. DNS is
  at GoDaddy for this user's domain -- not managed by Terraform (no GoDaddy
  provider added for one `A` record); documented as a manual step with an
  explicit two-apply sequencing (`-target=aws_eip.app` first to get a stable
  IP before DNS can be pointed at it, confirm resolution with `dig`, then
  apply everything else) since Let's Encrypt's HTTP-01 challenge at first
  boot needs the domain to already resolve there.
- `infra/lean/main.tf`: `relying_party_id` switched from the `"localhost"`
  placeholder to `var.domain_name`; `callback_urls`/`logout_urls` switched
  from the Elastic IP to the domain.
- `infra/modules/ec2_host/main.tf`: security group now opens 443 (was the
  app's own port, previously 3000) instead of the raw app port, plus 80
  (Let's Encrypt's HTTP-01 challenge -- nothing else ever listens there,
  safe to leave open indefinitely for renewals too). New `domain_name`
  variable threaded into `user_data.sh.tpl`. Removed the now-unused
  `public_ip` module variable entirely (nothing reads it any more; every
  URL uses `domain_name` instead) rather than leave it as dead-but-declared.
- `infra/modules/ec2_host/user_data.sh.tpl`: replaced the self-signed
  `openssl req` cert generation with Certbot, installed via the AWS-
  documented venv+pip method (AL2023 has no `dnf` package for it) --
  confirmed via WebSearch before implementing, not guessed, given this
  session's repeated cost of guessing at AWS/AL2023 specifics wrong the
  first time. `certbot certonly --standalone -d "${domain_name}"` with
  `--deploy-hook` pointed at a small script that copies the fresh cert
  into `/opt/app/certs/` (where docker-compose's bind mount expects it) and
  restarts just the app container -- Certbot persists a `--deploy-hook`
  given at issuance time into its renewal config, so it also fires
  automatically on every future renewal with no repetition needed in the
  cron job. A twice-daily `certbot renew` cron entry follows Certbot's own
  documented safe cadence (it only actually renews within ~30 days of
  expiry).
- `docker-compose.yml`: host port changed from `${APP_PORT}:${APP_PORT}` to
  `443:${APP_PORT}` -- the container still just listens on its usual
  internal port; only Docker's host-side port mapping changed, no
  container-level privileged-port handling needed. Every URL
  (`PUBLIC_BASE_URL`, `COGNITO_REDIRECT_URI`, `COGNITO_LOGOUT_REDIRECT_URI`)
  switched from `https://${PUBLIC_IP}:${APP_PORT}` to
  `https://${DOMAIN_NAME}` -- no more `:3000` in the URL a user actually
  visits.
- `infra/lean/outputs.tf`: `app_url` now `https://${var.domain_name}` (no
  port suffix); `public_ip`'s description updated to describe its new,
  narrower purpose (pointing DNS at it before applying) now that nothing
  else depends on it.
- `infra/README.md`: rewrote the "Lean test deployment" section's
  Prerequisites/Deploy/visit instructions for the new domain+Certbot flow,
  including the two-apply DNS-sequencing requirement and a `dig` check
  before the second apply; dropped the "known limitation: WebAuthn doesn't
  work" note since it's no longer true.

Every template-interpolation and shell-syntax detail was verified rather
than assumed, given this same file's history of exactly this class of bug
during its original authoring (#017) -- a literal `${...}` inside a comment
being misparsed as Terraform interpolation, caught and fixed before that
entry was ever committed, so it left no changelog entry of its own to cite
by number: rendered `user_data.sh.tpl` with
`templatefile()` directly (an isolated scratch Terraform config, dummy
values, real `terraform apply` to force output evaluation) and confirmed
every `${...}` resolved to the expected literal value, including inside the
nested single-quoted heredoc for the deploy-hook script; then `bash -n`
syntax-checked both the full rendered script and the extracted embedded
hook script independently. Not yet confirmed end-to-end against a real AWS
apply + DNS + a live Let's Encrypt issuance at the time of this entry --
that first real apply will also force-replace the current instance (`ami`
drift is ignored per #026, but `user_data` genuinely changed here), wiping
the database once more; the user will need to re-promote their account to
company_admin afterward, same as every prior instance replacement this
session.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`).
`npm test`/`lint`/`build` unaffected (no `src/` changes).

### #029 — 2026-08-24T21:00:00-04:00

**Feature (product-facing)**: a bathroom may now have any number of
simultaneous non-terminal `CleaningRequest`s, instead of at most one. Removed
by explicit product decision -- confirmed with the user (who was hitting it
while testing) that the specific behavior to remove was the same-bathroom
duplicate guard, not the (unaffected, unrelated) per-site multi-bathroom
concurrency that already worked before this change.

This guard was a real, deliberately-documented Phase 3 feature (SDD §9.4,
originally added per changelog #005-era entries), not a bug -- removing it
means removing a genuine anti-duplicate-charge safeguard, so this was
confirmed via `AskUserQuestion` before any code changed, along with a
follow-up question on whether the manager console's capture/cancel list
needed anything added to distinguish multiple simultaneous requests for one
bathroom (explicit answer: no, leave it as request-id/timestamp for now).

- `src/db/schema.ts`: dropped the `cleaning_requests_bathroom_active_key`
  partial unique index from `cleaningRequests`.
- `drizzle/0005_light_dragon_lord.sql`: generated via `npm run db:generate`
  (not hand-written) -- a single `DROP INDEX`.
- `src/payments/service.ts`: removed `createCleaningRequest`'s pre-check
  query, the unique-violation-to-`DuplicateActiveRequestError` mapping on
  insert, and the `DuplicateActiveRequestError` class itself (nothing can
  throw it any more). Reworded the still-live `saveSitePaymentMethod`
  docstring, which had compared its own backstop to "the duplicate-active-
  request guard above" -- that comparison point no longer exists in this
  file.
- `src/manager/routes.ts` / `src/public/routes.ts`: removed the now-dead
  `instanceof DuplicateActiveRequestError` -> `409` handling in both (the
  approval-grant path and the direct scan-and-authorize path, respectively);
  the `public/routes.ts` site collapsed to a plain `await` since the
  try/catch existed solely for this one error type.
- Tests: `test/payments.test.ts`'s guard-rejection test replaced with one
  asserting the new behavior (two concurrent requests for one bathroom both
  reach the gateway and persist as independent rows); its unrelated
  `listPendingCaptures` test had a now-stale comment justifying a two-
  bathroom setup by the old guard, corrected (the two-bathroom setup itself
  was incidental, not required, so it was left as-is). `test/public-
authorize.test.ts`'s HTTP-level double-tap-race test similarly replaced:
  it asserted exactly one `200`/one `409` and one persisted row; now asserts
  both attempts succeed as two independent persisted rows.
  `test/unique-violation.test.ts`'s doc comment listing `isUniqueViolation`'s
  consumers dropped the removed one, kept the two that still exist (the §3.3
  invite bridge, the one-payment-method-per-site guard).
- `SDD.md`: updated every live spec-body reference to this guard (§3.3's
  `isUniqueViolation` consumer list, the §4 entity/referential-notes table,
  §9.4's own description, §10's cross-reference, §11.7's HTTP-surface
  description, §13's stack-decision summary) to describe its removal rather
  than describe it as present. Historical entries describing Phase 3 as it
  was originally documented (the "Last edited" blockquote near the top, and
  changelog entries #005-era and #011) were deliberately left untouched --
  they were accurate records of what was true when written, not live spec.

Validated with `npx tsc --noEmit` (only the same 3 pre-existing, unrelated
errors), `npm run lint`, `npm test` (full suite, 218/218 passing -- 214
pre-existing + 2 rewritten tests, net test count unchanged since both
replacements are 1:1 swaps of the old assertion for the new one, not
additions), `npm run test:coverage` (83.28% lines / 82.62% branches / 90.91%
functions -- comfortably above the 73/81/77 floor, no regression), and a
real `npm run db:generate` producing exactly the expected single-line `DROP
INDEX` migration (confirmed by running the full suite against PGlite with
migrations freshly applied, not just eyeballing the generated SQL).

### #028 — 2026-08-24T20:00:00-04:00

**Feature (product-facing)**: after signing in, a user previously always
landed on `/` -- the generic "SSR scaffold" placeholder -- regardless of
role. Now the post-login redirect matches the user's own authority: a
company_admin lands on `/admin`, an authorized manager on `/manager`, an
authorized_user on a new `/start` page ("Tap the NFC tag or scan the QR code
in the bathroom to request service"), and only someone with no role at all
still lands on `/` -- which itself now distinguishes a signed-in no-role
visitor ("You don't have access to any site yet. Contact your
administrator.") from an anonymous one (a sign-in prompt), rather than
showing the same placeholder copy to both.

- `src/db/access.ts`: `resolvePostLoginDestination(db, userId)` -- read-only,
  picks the highest-authority destination when a user holds more than one
  role simultaneously (platform_role and SiteRole are independent, so this is
  a real case, not hypothetical -- see this session's own "test admin and
  manager with one number" guidance). Never itself an authorization decision;
  every destination still re-derives its own authorization independently on
  load (§7).
- `src/auth/routes.ts` (`handleCallback`): calls it as the fallback when
  there's no safe `returnTo` cookie -- the existing step-up re-authentication
  return-to-caller behavior (§6.4) still takes priority over the role-based
  destination, confirmed by a new test asserting a company_admin's callback
  still honors a pending `returnTo` rather than landing on `/admin`.
- `src/render/templates/home.ts`: `renderHomePage` now takes a required
  `{ signedIn: boolean }` and switches copy accordingly.
- `src/render/templates/start.ts`: new, the authorized_user landing page.
  Purely instructional -- an authorized_user's actual role is exercised by
  scanning a QR code (`GET /s/:token`, `src/public/routes.ts`), not anything
  on this page itself.
- `src/server/app.ts`: `/` now checks the session (`readSession`, no DB call)
  to pick which `renderHomePage` copy to show; new `GET /start` registered,
  ungated (nothing sensitive on it, same as `/`).
- Manager's destination (`/manager`) and the signed-in-no-role copy were both
  explicit product choices, confirmed with the user via AskUserQuestion
  rather than assumed, alongside their explicitly-stated admin -> `/admin`
  and authorized_user -> `/start`-style page.

Validated with `npx tsc --noEmit` (only the same 3 pre-existing, unrelated
errors), `npm run lint`, `npm test` (full suite, 218/218 passing -- 214
pre-existing + 4 new tests in `test/sms-otp.test.ts` covering all three
role-based destinations plus the returnTo-still-wins case; the existing
`renderHomePage` test in `test/render.test.ts` was updated in place for the
new required `signedIn` param rather than added as a new test), and `npm run
test:coverage` (83.23% lines / 82.54% branches / 91.00% functions --
comfortably above the 73/81/77 floor, no regression).

### #027 — 2026-08-24T19:00:00-04:00

**Docs (deployment, no product-facing change)**: with the invite SMS (#025)
and the AMI-drift fix (#026) both confirmed working, the user hit one more
real-deploy gotcha: Cognito's sign-in OTP never arrived at a Google Voice
number, while this app's own invite SMS (a plain informational text, sent
moments earlier to the same number) delivered fine. Isolated to the number,
not a regression: a real mobile carrier number worked immediately.

Confirmed via external reports, not just inference: many providers,
including AWS, deliberately restrict OTP/verification-code delivery to VoIP
numbers like Google Voice as an anti-fraud policy -- they can't be tied to a
verified phone-ownership history the way a carrier SIM can (Amazon is one
concretely-named example of a service that outright blocks Google Voice for
this reason). This is not a bug in this app's Terraform/Cognito config; it
fails the same way for any Cognito deployment sending to a Google Voice
number.

Added a "test with a real mobile carrier number" note to
`infra/README.md`'s lean-deployment prerequisites, alongside the existing
sandbox/origination-identity caveats, so the next person testing this
doesn't lose time attributing it to a config problem.

No `terraform`/`src/` changes -- documentation only. `npm run lint` run
(prettier covers `infra/README.md` and `SDD.md`); `npm test`/`build`
unaffected.

### #026 — 2026-08-24T18:30:00-04:00

**Bugfix (deployment, no product-facing change)**: the user reported the lean
EC2 instance's database being destroyed on repeated `terraform plan`/`apply`
runs -- unexpected, since a plan never mutates anything and an apply should
only replace a resource for a real config change.

Root cause, confirmed against a real deploy: `infra/modules/ec2_host/main.tf`'s
`data "aws_ami" "al2023"` uses `most_recent = true` with no pinning, so it
re-resolves on every plan. AWS publishes new Amazon Linux 2023 AMIs often
enough (sometimes every few days) that a later plan/apply can see the AMI ID
drift from what the instance was actually created with -- and `ami` is a
replace-forcing attribute on `aws_instance`, so Terraform destroys and
recreates the whole instance. Since this deployment's Postgres data lives in a
Docker volume on that same instance's local (ephemeral) disk, not anywhere
durable, every such replacement silently wiped the database.

Fix: `lifecycle { ignore_changes = [ami] }` on `aws_instance.this`. The AMI
lookup still picks the latest AL2023 image the first time the instance is
created (unchanged, no pinning to a specific pre-known AMI ID needed); later
plans just stop drift-replacing the instance over a subsequent AMI release.
`user_data` changes (e.g. #021-#025's infra edits) are deliberately still not
ignored -- those are real, intended config changes that should still take
effect; only the AMI's incidental "most recent" drift is silenced.

Validated with `terraform fmt -check -recursive` and `terraform validate`
(`infra/lean`, real `terraform` binary, `-backend=false`). `npm
test`/`lint`/`build` unaffected (no `src/` changes).

### #025 — 2026-08-24T13:00:00-04:00

**Feature (product-facing)**: inviting a manager or authorized user (SDD
§11.1, §11.4) now sends a real text message to the invited phone, instead of
only writing a pending `SiteRole` row ("mocked delivery" per the original
§3.3/§11.1 design). No secret token in the link -- the invite bridge already
links a pending `SiteRole` to a Cognito identity purely by the invitee's own
**verified** phone at sign-in (§3.3), so the SMS just needs to point them at
`/auth/login`; Cognito's real SMS OTP challenge is the actual security gate,
not anything in the link.

- `src/sms/gateway.ts`: `SmsGateway` seam (mirrors `src/payments/gateway.ts`'s
  `PaymentGateway`/`MockPaymentGateway` pattern) + `MockSmsGateway` (records
  sends, always succeeds; used for tests and DEMO_MODE) + `buildInviteMessage`
  (shared wording: `"<Site Name> invited you to Restroom Hero. Sign in at
<base-url>/auth/login to get started."`).
- `src/sms/sns-gateway.ts`: `SnsSmsGateway`, the real implementation, via
  `@aws-sdk/client-sns` (new dependency) -- the same SNS mechanism Cognito's
  own SMS OTP already sends through in this account/region. `send()` never
  throws: any SDK/network failure is caught and reported as `{sent: false}`,
  per explicit product decision -- a delivery failure must never block or roll
  back the already-persisted invite, and must be visible to the inviter (not
  silently swallowed) so they can follow up another way.
- `src/admin/service.ts` (`inviteInitialManager`) / `src/manager/service.ts`
  (`inviteSiteMember`): `InviteOutcome` now also carries `siteName` (one extra
  selected column, no extra query) so the route layer can personalize the
  message without a second lookup.
- `src/admin/routes.ts` / `src/manager/routes.ts`: after a real (non-idempotent-
  noop) invite, send the SMS and branch the response text: "Invitation sent."
  on success, "Invite created, but the text message failed to send. Let them
  know another way." on failure -- gated on `!isDemoMode()` (DEMO_MODE keeps
  using the existing accept-code loop instead, unchanged, and never attempts a
  real AWS call). No new rate limit was added on top of the existing per-user
  invite budget (`manager/routes.ts`) -- explicit product decision; that
  limiter's own comment about being sized loose "since no SMS cost gates it
  yet" is now slightly stale (SMS cost does exist now) but was left as-is
  rather than tightened speculatively.
- `src/server/base-url.ts`: extracted from `src/admin/routes.ts`'s
  previously-private `scanBaseUrl`/`isEncryptedConnection` (renamed
  `publicBaseUrl`) since `manager/routes.ts` now needs the same base-URL
  derivation for its own invite links; QR issuance (`admin/routes.ts`) updated
  to the shared import, unchanged in behavior.
- `src/server/app.ts`: real-vs-mock gateway selection was **not** put in
  `buildRouter` where it was first written -- that would have made every
  existing HTTP-level route test (`admin-console-routes.test.ts`,
  `manager-console-routes.test.ts`, `csrf-enforcement.test.ts`), none of which
  set `DEMO_MODE`, attempt a real AWS SNS call on every invite POST through
  `createHttpServer(runtime)`, breaking their existing assertions and adding
  real network I/O to the test suite. Caught before landing. Fixed by
  threading `smsGateway` as an explicit optional parameter through
  `createAppForRuntime`/`createHttpServer`, defaulting to `MockSmsGateway`
  (never real) exactly like the existing `runtime` override already works for
  tests; only `createApp()` (the environment-sourced, zero-arg production
  entry point) makes the `isDemoMode()`-based real-vs-mock choice.
- Infra, both compositions: `modules/ec2_host` gained its **first** IAM role +
  instance profile (none existed before), granting `sns:Publish`; also added
  `metadata_options { http_tokens = "required", http_put_response_hop_limit =
2 }` on the instance -- the default hop limit of 1 only reaches IMDS from the
  instance's own network namespace, not from inside the Docker container one
  bridge-network hop further out, which would have made the AWS SDK's
  instance-role credential lookup silently fail for every SMS send.
  `modules/app_runner`'s existing `instance` role gained the same
  `sns:Publish` policy. Region is read from `APP_AWS_REGION` (not `AWS_REGION`,
  to stay unambiguous against any AWS-reserved/platform-injected variable of
  that bare name) -- production's App Runner composition already had this
  wired into `runtime_environment_variables` before this change, unused until
  now; the lean deployment's `user_data.sh.tpl`/`docker-compose.yml` gained it
  fresh, sourced from a new `data "aws_region" "current"`.
- `infra/README.md`: new "Invite SMS delivery" section cross-referencing the
  existing SNS sandbox/origination-identity prerequisites (#024) -- they apply
  here too, since this is the same underlying SNS mechanism.

Not yet re-confirmed end-to-end against a fresh `terraform apply` (the IAM/
IMDS/region changes need a real instance to prove the credential path actually
resolves inside the container) at the time of this entry.

Validated with `npx tsc --noEmit` (only 3 pre-existing, unrelated errors --
confirmed via `git stash` against the same baseline), `npm run lint`,
`npm test` (full suite, 208 pre-existing tests + this feature's new ones, all
passing, no real network calls), `npm run test:coverage` (83.29% lines /
82.42% branches / 91.50% functions -- comfortably above the 73/81/77 floor,
no regression), and `terraform fmt -check -recursive` / `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`).
`SnsSmsGateway` itself is deliberately not unit-tested against a real/mocked
AWS SDK call (this sandbox has proxy-injected placeholder AWS credentials
that would behave inconsistently between here and CI, risking flakiness) --
mirrors `payments/gateway.ts`'s existing philosophy of only ever testing the
mock implementation; correctness of the thin AWS-wrapper class rests on
review plus the user's own real-world SMS deliveries earlier this session.

### #024 — 2026-08-24T11:00:00-04:00

**Docs (deployment, no product-facing change)**: with sign-in reaching the
real SMS OTP choice screen (#023), the OTP itself never arrived. The lean
deployment's `infra/README.md` prerequisites section only warned about the
SNS SMS sandbox (`IsInSandbox`) -- but the user's account already showed
`IsInSandbox: false`, so that check alone was insufficient and gave false
confidence. Confirmed against a real deploy: even outside the sandbox, AWS
requires a registered origination identity (toll-free number or 10DLC long
code) for any application-to-person SMS to US destinations -- without one,
sends fail silently with no error surfaced anywhere in Cognito, SNS, or the
app.

Expanded the "Prerequisites" section with the actual check (`describe-phone-
numbers` / `describe-sender-ids` via `pinpoint-sms-voice-v2`) and the fix
(request + register a toll-free number). Deliberately did not attempt to
script the registration submission itself via CLI: it requires a guided,
use-case-specific form (sample message text, opt-in/opt-out language,
sometimes business verification), and getting a field wrong risks an outright
rejection -- costing a full re-review cycle. Also corrected an initial,
wrong estimate given verbally (~1 business day) with AWS's actual documented
timeline: **up to 15 business days** for toll-free registration approval.
Per explicit user choice (asked via AskUserQuestion, 3 options: start
registration and wait / use SMS-sandbox-verified testing instead / stop
here for now), proceeding with registration and accepting the wait rather
than working around it.

No `terraform`/`src/` changes -- documentation only. `npm run lint` run
(prettier covers `infra/README.md` and `SDD.md`); `npm test`/`build`
unaffected.

### #023 — 2026-08-24T10:15:00-04:00

**Bugfix (deployment, no product-facing change)**: #022's fix was wrong. It
switched the lean deployment to `managed_login_version = 1` (classic Hosted
UI) to dodge the "Login pages unavailable" error, and that did make `/login`
serve a page -- but the page it serves is a plain username+password form, not
the choice-based SMS OTP picker this app depends on. Confirmed via AWS's own
docs: classic Hosted UI never supports choice-based authentication
(`allowed_first_auth_factors` with `SMS_OTP`/`WEB_AUTHN`) at all, regardless
of how the user pool client is configured -- that UI is exclusively a
Managed Login (`managed_login_version = 2`) feature. #022 traded one real
problem (login pages don't serve) for a worse one (login pages serve the
wrong flow entirely).

Reverted `infra/lean/main.tf` to `managed_login_version = 2` and fixed the
_actual_ root cause instead: version 2's pages don't serve until the pool's
managed-login branding/style exists (confirmed above in #022's diagnosis, the
one part of it that was correct). Terraform can only manage that via
`aws_cognito_managed_login_branding`, added in AWS provider **v6.12+** --
this repo pins `~> 5.0` across all of `infra/`, shared by every module
(network, database, secrets, app_runner, dns), not just cognito. A major
provider bump to unblock one resource is a separate decision with its own
migration risk, so -- per explicit user choice among three options (document
as a manual step / bump the provider to `~> 6.0` / leave it undocumented) --
this is now a documented one-time manual step instead: run
`aws cognito-idp create-managed-login-branding --use-cognito-provided-values`
once per fresh pool (`infra/README.md`, both the lean and production
sections). Added `cognito_user_pool_client_id` to `infra/lean/outputs.tf` (was
missing; production already exposed both IDs) so the documented command is
directly copy-pasteable from `terraform output`.

Production (`infra/main.tf`) had the identical latent bug -- it also defaults
to `managed_login_version = 2` with no branding resource -- and would have
hit the same "Login pages unavailable" error on its first real apply; this
fix (module comment + README step) covers both compositions, not just lean.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary, `-backend=false`).
`npm test`/`lint`/`build` unaffected (no `src/` changes).

### #022 — 2026-08-24T09:30:00-04:00

**Bugfix (deployment, no product-facing change)**: with the container running
(#021) and a real Cognito pool created (#020), visiting `/auth/login` on the
lean EC2 deployment redirected to the Hosted UI domain but Cognito served
"Login pages unavailable. Please contact an administrator." instead of the
sign-in page.

Root cause: `infra/lean/main.tf` set the Cognito user pool domain's
`managed_login_version = 2` -- AWS's newer "Managed Login" experience. That
version requires branding/style to be explicitly saved at least once (via the
console, or a separate `aws_cognito_managed_login_branding` resource) before
its pages actually serve content; nothing in this repo creates that resource.
The classic Hosted UI (`managed_login_version = 1`) has no such requirement
and serves immediately from a bare `aws_cognito_user_pool_domain`, which is
what the lean deployment actually needs -- it exists to exercise real Cognito
SMS OTP quickly, not to exercise the managed-login branding surface. Fix:
switched the lean composition to `managed_login_version = 1`. The production
composition (`infra/main.tf`) is untouched -- it still defaults to version 2
via `var.cognito_managed_login_version`, which is the right call for a real
deploy where branding would actually be configured out of band.

Not yet re-confirmed end-to-end against a fresh `terraform apply` + real
Hosted UI sign-in at the time of this entry; the user was mid-troubleshooting
against a live pool when the root cause was identified from the domain
resource's `managed_login_version` argument and Cognito's documented
behavior for that value.

Validated with `terraform fmt` and `terraform validate` (`infra/lean`,
real `terraform` binary, `-backend=false`). `npm test`/`lint`/`build`
unaffected (no `src/` changes).

### #021 — 2026-08-24T09:00:00-04:00

**Bugfix (deployment, no product-facing change)**: after #020 got the Cognito
pool creating successfully, the lean EC2 deployment's own app container never
started. `docker-compose ps` on the instance showed no containers at all, and
`cloud-init-output.log` showed why: `postgres:16` pulled fine (a pull, not a
build), but building the app image failed with `compose build requires
buildx 0.17.0 or later`, so `docker-compose up -d --build` errored out mid
first-boot and cloud-init logged the `scripts-user` module as failed and moved
on -- silently, with no containers ever created.

Root cause: `infra/modules/ec2_host/user_data.sh.tpl` installs the standalone
`docker-compose` binary (Compose V2, now versioned independently of the
`docker-compose`/`docker compose` distinction -- confirmed on the instance as
`v5.5.0`) directly from GitHub releases, but never installs a `buildx` CLI
plugin of its own. AL2023's `dnf install docker` pulls in an older bundled
`buildx` below the floor this Compose build requires, and Compose V2's build
path has no legacy fallback -- it errors rather than falling back to the
daemon's classic non-buildx builder.

Fix: install a pinned, known-good `buildx` release (`v0.19.3`) into
`/usr/libexec/docker/cli-plugins/docker-buildx` (the standard system-wide
Docker CLI plugin directory on RPM-based distros, so it's picked up
automatically and takes precedence regardless of where AL2023's bundled
version, if any, actually lives) before the `git clone`/`docker-compose up`
steps in `user_data.sh.tpl`. Pinned rather than resolved via GitHub's API at
boot time, to avoid an extra network round-trip and rate-limit risk during
first boot for a value that only needs to clear a fixed version floor.

Not yet re-confirmed end-to-end against a fresh `terraform apply` (the
already-running instance from #020 was fixed manually in place, matching this
same plugin install, to unblock testing without tearing down and losing the
already-verified Elastic IP/DNS-adjacent state); the template fix mirrors
exactly what was verified working by hand on that instance.

Validated with `terraform fmt -check -recursive` and `terraform validate`
(real `terraform` binary, `-backend=false`). `npm test`/`lint`/`build`
unaffected (no `src/` changes).

### #020 — 2026-08-23T20:15:00-04:00

**Bugfix (deployment, no product-facing change)**: #019's fix did not actually
resolve the problem -- the very next real `terraform apply` retry hit the
identical `SetUserPoolMfaConfig ... "can't turn off MFA and configure an MFA
together"` error, against a newly-created pool. #019's theory (that omitting
`mfa_configuration` avoids the follow-up call) was wrong: the Terraform AWS
provider's schema defaults that argument to `"OFF"` regardless of whether it's
written explicitly, so omitting it changed nothing about the actual API call
made.

Root cause, confirmed this time against Cognito's real behavior (via a matching,
previously-fixed bug in another IaC tool targeting the same API -- see
sst/sst#5029): `SetUserPoolMfaConfig` rejects `MfaConfiguration: OFF` whenever
_any_ MFA-adjacent sub-config is present in the same call -- not only an
explicitly-enabled SMS/software-token block, but `WebAuthnConfiguration` too
(Cognito's own model treats WebAuthn passkeys as capable of satisfying MFA, so
its mere presence counts as "configuring an MFA"). This pool has both
`sms_configuration` and `web_authn_configuration` set (both required for the
first-factor choices in `sign_in_policy`), so `OFF` was never going to be
compatible with this pool's shape, however it's spelled in Terraform. Fix:
`mfa_configuration = "OPTIONAL"` instead -- Cognito's own docs describe `OPTIONAL`
as the value that expects `sms_configuration`/software-token config to be
present (unlike `OFF`), and since nothing in this app ever lets a user set an
MFA preference (no self-service path, no UI for it), Cognito never actually
prompts anyone for a second factor under `OPTIONAL` -- functionally a no-op for
every real user of this app, not an actual MFA requirement.

**Confirmed** by the user's real `terraform apply` against AWS: the Cognito user
pool now creates successfully end-to-end. This fix could not be validated
against a real `CreateUserPool`/`SetUserPoolMfaConfig` call in this environment
(no AWS credentials) when it was written -- it rested on Cognito's documented
API behavior and a confirmed matching bug/fix in another tool against the same
underlying API, not a direct reproduction here -- but a real deploy now bears
it out. The lean deployment (#017) is confirmed working end-to-end for its
intended purpose: real Cognito SMS OTP sign-in.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary). `npm test`/`lint`/`build`
unaffected (no `src/` changes).

### #019 — 2026-08-23T15:20:00-04:00

**Bugfix (deployment, no product-facing change)**: follow-on to #018, found on the
next real `terraform apply` retry against the same AWS account. Progressed past
Cognito user pool creation this time, then failed on the provider's follow-up
call: `SetUserPoolMfaConfig ... InvalidParameterException: Invalid MFA
configuration given, can't turn off MFA and configure an MFA together`. Root
cause: `modules/cognito/main.tf` explicitly set `mfa_configuration = "OFF"`
alongside a populated `sms_configuration` block. `sms_configuration` here exists
for the SMS OTP _first-factor_ delivery role (`sign_in_policy`), not legacy MFA,
but the `hashicorp/aws` provider (`~> 5.0`) derives SMS-MFA details from that same
block whenever present and includes them in its follow-up
`SetUserPoolMfaConfig` call regardless of `mfa_configuration`'s value --
submitting SMS-MFA config while also saying MFA is off is what Cognito's API
rejects. Fix: removed the explicit `mfa_configuration = "OFF"` argument;
Cognito's own create-time default is already off when the argument is
unset, and omitting it stops the provider from issuing that follow-up call
at all. No behavior change intended -- this app never used the legacy MFA
system either way.

Since the previous apply had already created the user pool itself (the failure
was on the follow-up call, not `CreateUserPool`), no manual Terraform state
surgery is expected to be needed on retry -- Terraform should reconcile the
difference on the next `terraform apply`.

Validated with `terraform fmt -check -recursive` and `terraform validate`
against both compositions (real `terraform` binary; the actual
`SetUserPoolMfaConfig` behavior itself could not be re-verified here, no AWS
credentials in this environment). `npm test`/`lint`/`build` unaffected (no
`src/` changes).

### #018 — 2026-08-22T21:40:00-04:00

**Bugfix (deployment, no product-facing change)**: found while actually running the
#017 lean deployment's `terraform apply` for the first time -- `terraform apply`
failed with `InvalidParameterException: Password should be configured as one of
the allowed first auth factors` when creating the Cognito user pool. Root cause:
Cognito's `CreateUserPool` API rejects a pool whose `sign_in_policy.
allowed_first_auth_factors` omits `PASSWORD`, even though this pool is meant to be
passwordless-only (SMS OTP + WebAuthn) -- a real AWS API constraint neither this
module nor its authoring session had ever exercised against a real account before
(CI's `terraform validate` never calls the AWS API). Fix: `modules/cognito/main.tf`
now includes `PASSWORD` in that list. No user of this app is ever given a
password -- there is no self-service sign-up and the app's own auth routes only
ever redirect to Cognito's managed login, never construct a password-flow URL --
so this is a dormant capability Cognito requires be nominally allowed, not one
this app offers or uses. Affects both the production composition (`infra/main.tf`)
and the lean one (`infra/lean/`), since both use this shared module.

Validated with `terraform fmt -check -recursive` and `terraform validate` against
both compositions (real `terraform` binary, no AWS credentials available in this
environment, so the actual `CreateUserPool` call itself could not be re-verified
here). `npm test`/`lint`/`build` unaffected (no `src/` changes).

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
