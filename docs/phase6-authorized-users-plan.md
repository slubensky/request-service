# Phase 6 — Authorized Users + Over-Limit Manager Approval — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document
> first"). Builds on Phase 1 (invitation bridge), Phase 2/3 (payment authorization,
> saved method, step-up). **Still mock-only — no Stripe SDK, no live keys, no real
> card collection.**

## Goal (product owner's five requests + clarifications)

1. **Idempotent invite with a distinct message.** Re-inviting the same phone at a site
   must not create a duplicate `site_roles` record, and the console shows a _different_
   message ("already a member") than a fresh invite.
2. **Admin can revoke a manager.** A Company Admin can revoke a manager's SiteRole at a
   site from the admin console (soft revoke, `status=revoked`).
3. **One-step invite.** No separate "promote pending → authorized" step; the invite is
   active the moment the invitee accepts (authenticates — that binding is unavoidable,
   SDD §3.3).
4. **Visibility.** Admin console shows each site's managers; manager console shows the
   members they invited and who can request service.
5. **Rename `assistant` → `authorized_user`, everywhere**, and the refined authority rules
   below.

### Final authority rules (product owner)

- **manager**: requests service, **self-authorizes any amount, no limit**; invites,
  approves over-limit requests, sets limits, deletes authorized users.
- **authorized_user**: initiates a request and **self-authorizes up to their limit**; a
  request **above their limit** requires a **manager to approve** it before the hold is
  placed.
- **manager can change an authorized_user's authorization limit**, and **delete an
  authorized_user**.

| Role                | Request? | Places hold directly  | Over-limit path      | Manage members                        |
| ------------------- | -------- | --------------------- | -------------------- | ------------------------------------- |
| **manager**         | yes      | any amount (no limit) | n/a                  | invite / set-limit / delete / approve |
| **authorized_user** | yes      | up to their limit     | manager must approve | —                                     |

Because a Site is fixed-price (SDD §8), the server knows before rendering whether a given
authorized user is over limit for this site, so the scan page shows the correct affordance
("Authorize hold" vs "Request approval") deterministically — the server still re-derives
and re-checks on the POST, never trusting the rendered state (SDD §7).

## Design decisions

### D1 — `assistant` → `authorized_user` is a true rename

The `site_role_name` enum value `assistant` becomes `authorized_user`. Drizzle-kit cannot
infer an enum-value rename, so this is the **one** place we hand-author migration SQL:

```sql
ALTER TYPE "site_role_name" RENAME VALUE 'assistant' TO 'authorized_user';
```

Safe, non-destructive, preserves every row. Documented per AGENTS.md.

### D2 — One-step invite: the bridge activates _both_ roles on accept

`bridgePendingSiteRoles` (§3.3) currently activates `manager` → `authorized` but leaves
`assistant` `pending`. Now it activates **both** `manager` and `authorized_user` →
`authorized` on accept. `status` collapses to: `pending` = invited-not-yet-accepted
(confers nothing), `authorized` = active, `revoked` = revoked. No "linked-but-pending"
state remains. The resilient-bridge idempotency/supersession logic is otherwise unchanged.

### D3 — Limits: manager unlimited, authorized_user manager-set

- **manager**: `max_authorization_cents = null` meaning **unlimited** — the paid-request
  check skips the ceiling for managers entirely (bathroom scope still applies). The
  manager invite form has no limit field.
- **authorized_user**: the invite form has a **required** authorization-limit field (whole
  cents, `> 0`), stored on the pending `site_roles` row and carried through activation. A
  `null` limit for an `authorized_user` is treated as "no self-authorization" (fail
  closed) — but the required field prevents that in practice.

`authorizePaidRequest` becomes role-aware:

```
if !bathroomInScope        -> deny(bathroom_out_of_scope)
if role == manager         -> ALLOW                     (unlimited)
if max == null             -> deny(no_authorization_limit)
if amount > max            -> deny(exceeds_max_authorization)   // -> approval path
ALLOW
```

### D4 — Over-limit approval flow (conditional)

Only an `authorized_user` request **above their limit** routes to approval. The route
(`POST /s/:token/authorize`) calls `authorize(...)`; if it denies solely with
`exceeds_max_authorization` **and** the caller is an `authorized_user`, the route records a
**pending approval** bound to `(site_id, bathroom_id, price_version, amount_cents,
requester_user_id)`, single-use, expiring 15 min after creation, and renders "awaiting
manager approval." Otherwise (`allowed`) it places the hold directly (manager any amount;
authorized_user within limit).

A manager approves from the manager console (`request:approve`). Approval **re-validates**
the binding (not expired, `price_version` still the site's current fixed price) and then
places the hold via the existing `createCleaningRequest` path — same duplicate-active
guard, same mock gateway. The money-movement gates (saved method exists → else 409; the
acting session's step-up recency → else 401, SDD §6.4/§9.4) are enforced **at hold
placement** exactly as in Phase 3: initiating an approval moves no money and needs neither.

Reuse the dormant `assistant_approval_requests` table, **renamed** `request_approvals`
(`assistant_id` → `requester_user_id`; enum `assistant_approval_status` →
`request_approval_status`, same values). It has never been written by runtime code, so a
drizzle drop/recreate loses no data anywhere.

### D5 — Admin revoke = one capability on two axes

`site_role:revoke` (a site-scoped manager capability today) is **also** added to the
`company_admin` platform matrix, so an admin can revoke any SiteRole cross-site — exactly
as `qr_token:replace` already lives on both axes. One capability, one `revoke_site_role`
action. New admin route `POST /admin/sites/:siteId/roles/:roleId/revoke`; the target's
`site_id` is re-derived from `:roleId` server-side and checked against `:siteId` before the
gate.

### D6 — Manager manages authorized_users: set-limit + delete

Two new manager site capabilities and actions:

- `site_role:set_limit` / `set_site_role_limit` — `POST /manager/sites/:siteId/roles/:roleId/limit`
  updates an `authorized_user`'s `max_authorization_cents` (validated `> 0`). Rejects if the
  target is not an `authorized_user` at the manager's site.
- `site_role:delete` / `delete_site_role` — `POST /manager/sites/:siteId/roles/:roleId/delete`
  hard-deletes an `authorized_user`'s `site_roles` row (FK-safe: cleaning_requests /
  request_approvals reference `users`, not `site_roles`; demo_invite_codes cascade). Works
  for a pending invite or an accepted user. Rejects a non-`authorized_user` target (managers
  are revoked by an admin, D5).

Manager keeps `site_role:invite` (may still invite a co-manager or an authorized_user).
`site_role:promote` is **retired** (no promote step exists any more).

### D7 — Idempotent invite + distinct outcome

`inviteSiteMember` / `inviteInitialManager` dedupe against **any non-revoked** SiteRole at
the site whose `invited_phone` matches (covers pending _and_ accepted — the accepted row
keeps its `invited_phone`). They return `{ created: boolean; role: SiteRoleRow }`; the route
returns **200** with a short body (`invited` vs `already a member`) instead of a bare `204`,
and the console JS shows that message instead of a blind reload.

## Schema changes (`src/db/schema.ts`)

- `site_role_name`: `assistant` → `authorized_user` (D1, hand-authored `RENAME VALUE`).
- `assistant_approval_requests` → `request_approvals`; `assistant_id` →
  `requester_user_id`; `assistant_approval_status` → `request_approval_status`
  (drizzle-generated, empty table).
- No new `site_roles` columns; `max_authorization_cents` now populated at invite.

## Capability matrix (`src/auth/authorize.ts`)

- `Role = 'manager' | 'authorized_user'`.
- `company_admin` platform set **+`site_role:revoke`**.
- `manager` site set: `cleaning_request:create`, `payment_method:save`, `request:approve`
  (renamed from `assistant_request:approve`), `site_role:invite`, `site_role:set_limit`,
  `site_role:delete`, `payment:view`, `qr_token:replace`. (Drop `site_role:promote`; drop
  `site_role:revoke` from the manager set — managers _delete_ authorized_users, admins
  _revoke_ managers.)
- `authorized_user` site set: `cleaning_request:create`, `payment_method:save` (unchanged
  from old `assistant`). Route decides self-authorize vs approval by amount-vs-limit.
- `authorizePaidRequest` becomes role-aware (D3).

## Routes / templates / client JS

- `admin/routes.ts` + `render/templates/admin.ts` + `public/js/admin.js`: limit-less
  manager invite (200 message), managers-per-site list with Revoke, distinct-message UX.
- `manager/routes.ts` + `render/templates/manager.ts` + `public/js/manager.js`: invite
  (role + phone + conditional limit, 200 message), members list by status, set-limit &
  delete controls, pending-approvals list with Approve.
- `public/routes.ts` + `render/templates/confirm.ts`: `GET /s/:token` renders
  "Authorize hold" vs "Request approval (over your limit)" vs "awaiting approval";
  `POST /s/:token/authorize` branches self-authorize vs create-approval.
- `render/templates/demo-invite.ts`: accept-result copy reflects the collapsed status model
  and the resolved user's actual authority (fixes the earlier "still pending" bug).

## Tests (test-first)

Service (PGlite) + real-HTTP (`createAppForRuntime`), mirroring existing suites:

- matrix: authorized_user within limit allowed; over limit → `exceeds_max_authorization`;
  manager unlimited; `request:approve` manager-only; `company_admin` holds `site_role:revoke`;
  manager holds `site_role:set_limit`/`site_role:delete` not `site_role:promote`.
- bridge: authorized_user activates to `authorized` on accept.
- invite idempotency (re-invite accepted phone → `created:false`, no new row); limit stored
  at invite; manager invite stores `null` (unlimited).
- admin revoke manager; manager set-limit (rejects non-authorized_user); manager delete
  (row gone; rejects non-authorized_user; works on pending invite).
- approval flow: over-limit authorize creates pending approval (no hold/CleaningRequest);
  manager approve places hold; price-change/expiry invalidates; single-use; non-manager
  cannot approve; within-limit authorize places hold directly with no approval row.
- visibility reads: admin lists managers; manager lists members + pending approvals.

## Migration & rollback

Two migrations: (a) hand-authored enum `RENAME VALUE` (D1); (b) drizzle-generated
`request_approvals` rename/recreate (D4). Non-destructive (rename preserves rows; approvals
table empty everywhere). Rollback = revert the branch; no production deploy exists
(ARCHITECTURE.md §8).

## Explicitly out of scope

- Real Stripe SDK/keys/webhooks (mock-only unchanged).
- Notifications (SMS/email) of an invite or pending approval.
- Per-bathroom `bathroom_scope` on invites (stays `null` = all bathrooms).
- NFC tags, AWS/real-Cognito deployment, Phase 5 deploy work.
