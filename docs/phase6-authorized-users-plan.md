# Phase 6 — Authorized Users + Per-Request Manager Approval — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document
> first"). Builds on Phase 1 (invitation bridge), Phase 2/3 (payment authorization,
> saved method, step-up). **Still mock-only — no Stripe SDK, no live keys, no real
> card collection.**

## Goal (from the product owner's five requests + two clarifications)

1. **Idempotent invite with a distinct message.** Inviting the same phone again at a
   site must not create a duplicate `site_roles` record, and the console must show a
   *different* message ("already invited / already a member") than a fresh invite.
2. **Admin can revoke a manager.** A Company Admin can revoke a manager's SiteRole at a
   site from the admin console.
3. **One-step invite.** A manager invites a member in a single action — no separate
   "promote pending → authorized" step after they join. Once the invitee accepts
   (authenticates, which binds their identity — unavoidable, SDD §3.3), the role is
   active.
4. **Visibility.** The admin console shows who the manager(s) are for each site; the
   manager console shows who they invited and who is authorized to request service.
5. **Rename `assistant` → `authorized user`, everywhere.** The concept "assistant" is
   removed. A manager can assign multiple **authorized users** who can request service.

   **Clarification (product owner):** an authorized user *can request service, but the
   manager must approve each request.* And **the manager sets each authorized user's
   authorization limit at invite time.**

## Resulting two-tier site model

| Role | Request a cleaning? | Place the hold? | Invite / revoke / approve? |
| --- | --- | --- | --- |
| **manager** | Yes | Self-authorizes directly, up to their limit | Yes |
| **authorized_user** | Yes — *initiates* a request | Only after a **manager approves that specific request** | No |

- `manager` is unchanged in spirit: full site authority, self-authorizes holds.
- `authorized_user` (renamed from `assistant`) is *active immediately on accepting the
  invite* (no promote step — that is request #3), but each hold it wants placed goes
  through a manager approval (that is request #5's clarification). This is the existing
  SDD §10 "assistant one-time approval" lifecycle, **renamed and re-keyed on role**
  (an `authorized_user` always routes through approval) rather than on `status=pending`.

## Design decisions

### D1 — `assistant` → `authorized_user` is a true rename, not an alias

The `site_role_name` enum value `assistant` is renamed to `authorized_user`. Drizzle-kit
cannot infer an enum-value rename from a schema diff (it would drop/recreate the value,
which fails while a column uses it), so this is the **one** place we author the migration
SQL explicitly:

```sql
ALTER TYPE "site_role_name" RENAME VALUE 'assistant' TO 'authorized_user';
```

This is safe and non-destructive: it preserves every existing row. Documented here per
AGENTS.md ("document non-obvious tradeoffs"). Everything else in the migration is
drizzle-kit-generated from the schema diff.

### D2 — One-step invite: the bridge activates *both* roles on accept

Today `bridgePendingSiteRoles` (§3.3) activates a `manager` invite to `authorized` on
authentication but leaves an `assistant` invite `pending` (awaiting a manager promote).
Under the new model there is no promote step, so the bridge activates **both**
`manager` and `authorized_user` to `authorized` on accept. `status` semantics collapse to:

- `pending` — invited, **not yet accepted/linked** to an authenticated identity (confers
  nothing; the invitee is still a customer until they accept).
- `authorized` — accepted and active.
- `revoked` — revoked (confers nothing, cannot be redeemed again).

There is no longer any "linked-but-still-pending" state. The demo accept-result page and
the resolution table (§3.2) are updated to match. The idempotency/supersession machinery
of the resilient bridge contract (§3.3) is otherwise unchanged.

### D3 — Manager sets the authorization limit at invite time

The invite form (both the admin's initial-manager invite and the manager's member invite)
gains a required **authorization limit** field (whole cents, `1..=9` digits, > 0). It is
stored on the pending `site_roles` row as `max_authorization_cents` and carried through
activation by the bridge (which never touches that column). This closes the pre-existing
gap the Phase 3 smoke test flagged (invited roles had `null` limit and so could authorize
nothing). `bathroom_scope` stays `null` (all bathrooms) — per-bathroom scoping is not in
scope for this phase.

Rationale for "manager sets it" over "default to the site price": the product owner chose
it explicitly; it is strictly more flexible and the validation surface is small (a bounded
integer, same shape as `fixed_price_cents`).

### D4 — Per-request approval flow (generalized §10)

An `authorized_user`'s `POST /s/:token/authorize` does **not** place a hold. Instead it
records a **pending approval request** bound to `(site_id, bathroom_id, price_version,
amount_cents, requester_user_id)`, single-use, expiring 15 minutes after creation. A
manager for that site approves it from the manager console; approval **re-validates** the
binding (price unchanged, not expired, still the site's current fixed price) and *then*
places the hold via the existing `createCleaningRequest` path (same duplicate-active-
request guard, same mock gateway). A `manager`'s own authorize is unchanged — it places
the hold directly.

Reuse the existing `assistant_approval_requests` table, **renamed** to `request_approvals`
with `requester_user_id` (dropping the `assistant` name). The table has never been written
by any runtime code (Phase 4 was never built), so a drizzle drop/recreate loses no data in
any environment. The `assistant_request:approve` capability/action are renamed to
`request:approve` / `approve_request`, kept on the `manager` site matrix, and a new
`request:initiate`-style path is **not** needed — an authorized_user already holds
`cleaning_request:create`; the route branches on the caller's role to decide "place hold
now" (manager) vs "record approval request" (authorized_user), both already gated by the
same `create_cleaning_request` capability + limit check.

> **Scope guard:** the approval flow keeps §10's single-use + expiry + price-binding
> invalidation, because the table already carries those columns and they are the security
> point of the feature. It does **not** add email/SMS notification of a pending approval
> (out of scope, no delivery channel exists yet — same posture as invites).

### D5 — Admin revoke = one capability on two axes

`site_role:revoke` already exists as a *site-scoped manager* capability (a manager revokes
members at their own site). Add it to the `company_admin` **platform** matrix as well — so
a Company Admin can revoke any SiteRole cross-site — exactly as `qr_token:replace` already
sits on both axes. One capability, one `revoke_site_role` action; no new authorize()
branch. New admin route `POST /admin/sites/:siteId/roles/:roleId/revoke`; the target
role's `site_id` is re-derived server-side from `:roleId` and checked against `:siteId`
before the gate, never trusted from the client.

### D6 — Idempotent invite + distinct outcome

`inviteSiteMember` / `inviteInitialManager` currently dedupe only against *unlinked*
(`user_id IS NULL`) non-revoked rows, so re-inviting a phone that is already an **accepted**
member (linked, `user_id` set — its `invited_phone` is retained) inserts a second row. Fix:
dedupe against **any non-revoked** SiteRole at the site whose `invited_phone` matches
(covers pending *and* accepted). The service returns a discriminated result
`{ created: boolean; role: SiteRoleRow }`; the route returns **200** with a small text body
(`invited` vs `already a member`) instead of a bare `204`, and the console JS surfaces that
message instead of a blind reload.

## Schema changes (`src/db/schema.ts`)

- `site_role_name` enum: `assistant` → `authorized_user` (migration via `RENAME VALUE`, D1).
- `assistant_approval_requests` table → `request_approvals`; column `assistant_id` →
  `requester_user_id`; drop the now-unused `assistant_approval_status` enum name in favor
  of a role-neutral `request_approval_status` (`pending`/`granted`/`used`/`expired`,
  unchanged values). Drizzle-generated (empty table, safe recreate).
- No new columns on `site_roles`; `max_authorization_cents` already exists (now populated
  at invite time).

## Capability matrix changes (`src/auth/authorize.ts`)

- `Role` type: `'manager' | 'authorized_user'`.
- `company_admin` platform set gains `site_role:revoke` (D5).
- Rename capability `assistant_request:approve` → `request:approve`; action
  `approve_assistant_request` → `approve_request`. Stays on the `manager` site set.
- `authorized_user` site set: `cleaning_request:create` + `payment_method:save` (same as
  the old `assistant`). The route, not the matrix, routes an authorized_user's request
  into the approval flow.

## Routes

- **`src/admin/routes.ts`**: invite-manager form now parses a limit; add
  `POST /admin/sites/:siteId/roles/:roleId/revoke`; console lists each site's managers
  (accepted + pending) with a Revoke button.
- **`src/manager/routes.ts`**: invite form parses role + phone + limit; invite returns the
  distinct `created` message; add `POST /manager/sites/:siteId/roles/:roleId/revoke` (reuse
  the existing manager `revoke_site_role` capability) and
  `POST /manager/approvals/:id/approve`; console lists members (managers + authorized users,
  by status) and a **pending approvals** section.
- **`src/public/routes.ts`**: `POST /s/:token/authorize` branches on the caller's resolved
  role — `manager` → place hold now (unchanged); `authorized_user` → create/refresh a
  pending `request_approval` and render an "awaiting manager approval" state. `GET /s/:token`
  reflects the pending-approval state for an authorized user who already has one.

## Templates / client JS

- `render/templates/admin.ts`, `manager.ts`: member lists (role + status), Revoke buttons,
  limit input on invite forms, pending-approvals list, "already a member" messaging hook.
- `render/templates/demo-invite.ts`: accept-result copy updated for the collapsed status
  model (no "linked but pending" wording); reflect actual resolved authority (fixes the
  bug the owner hit where an already-authorized identity saw "still pending").
- `public/js/admin.js`, `manager.js`: surface the 200 text message from an invite instead
  of an unconditional reload; keep the existing CSRF-header behavior.

## Tests (test-first, per AGENTS.md)

Service-layer (PGlite) + real-HTTP (`createAppForRuntime`) mirroring existing
`test/manager.test.ts`, `test/admin*.test.ts`, `test/authorize.test.ts`,
`test/public-authorize.test.ts`, `test/activation.test.ts`:

- authorize matrix: `authorized_user` holds `cleaning_request:create`; `request:approve`
  is manager-only; `company_admin` holds `site_role:revoke`.
- bridge: `authorized_user` invite activates to `authorized` on accept (no pending state).
- invite idempotency: re-invite of an accepted phone inserts no row and reports
  `created:false`.
- limit-at-invite: invited role carries the manager-set `max_authorization_cents`.
- admin revoke + manager revoke: role → `revoked`; a revoked user is denied.
- approval flow: authorized_user authorize creates a pending approval (no hold, no
  CleaningRequest); manager approve places the hold; price-change / expiry invalidates;
  single-use; a non-manager cannot approve; duplicate-active-request guard still holds.
- visibility reads: admin console lists managers; manager console lists members +
  pending approvals.

## Migration & rollback

- Two migrations: (a) hand-authored enum `RENAME VALUE` (D1); (b) drizzle-generated table
  rename/recreate for `request_approvals` (D4). Both non-destructive in practice (rename
  preserves rows; approvals table is empty everywhere). Rollback = revert the branch; no
  data migration to undo since no production deploy exists yet (ARCHITECTURE.md §8).

## Explicitly out of scope

- Real Stripe SDK/keys/webhooks (unchanged mock-only posture).
- Notifications (SMS/email) of a pending approval or an invite.
- Per-bathroom `bathroom_scope` on invites (stays `null` = all bathrooms).
- Editing an existing member's limit after invite (re-invite path only for now).
- NFC tags, AWS/real-Cognito deployment, promotion/revocation-driven deploy (Phase 5).
