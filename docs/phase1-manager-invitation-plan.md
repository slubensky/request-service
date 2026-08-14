# Phase 1 — Site Manager Invitation Flow — Plan

> Required by AGENTS.md ("If a task takes more than 5 steps, create a plan document first").
> Scope: an authorized Site Manager invites a user (manager or assistant) to their own
> site by phone, creating a pending SiteRole. Human-gated merge. Board task 15.

## Goal

Generalize the existing Company-Admin-only `inviteInitialManager` (Phase 0) so an
authorized Site Manager can invite additional members -- another manager or an assistant
-- to their own site, the same way a Company Admin invites the first one:

1. **Manager console** (`GET /manager`) lists the sites where the caller holds an
   `authorized` `role=manager` SiteRole, each with its pending invites and an invite form.
2. **Invite** (`POST /manager/sites/:siteId/invites`) creates a pending SiteRole
   (`user_id=null`, `status=pending`) for the chosen role (`manager` or `assistant`) at
   that site, keyed by the invited phone. No SMS is sent -- this phase is a DB record only
   (mocked delivery); OTP/SMS delivery is a separate task (16).

## Non-negotiable constraints

- **Reuse** the deny-by-default matrix in `src/auth/authorize.ts`. It already defines
  `invite_site_role` / `site_role:invite`, granted to an authorized `role=manager` SiteRole
  at its own site (see `test/authorize.test.ts`). This slice **wires it up** -- it does not
  add a new capability, and it does not touch the Company Admin's `invite_initial_manager`
  authority, which is orthogonal (platform axis) and unchanged.
- No hardcoded role branches, no parallel authz path: every mutation re-derives authority
  through `authorizeAction` before any DB write, exactly like `src/admin/routes.ts`.
- Use the merged Drizzle schema **as-is**. No migration -- `site_roles.role` already has
  `manager`/`assistant`, `status` already has `pending`, and `invited_phone` already exists.
- No framework, no bundler. Mobile-first SSR, session + session-bound CSRF, body-size caps.
- Spec-first, test-first, no secrets in code, no real SMS delivery.

## Design

### Shared HTTP-layer helpers (new, extracted from `src/admin/routes.ts`)

The Company Admin console's `authorizeOrReject` gate (resolve session -> ensure DB ->
`authorizeAction` -> 401/503/403) and its `sendText` helper are generic -- nothing in them
is admin-specific. Extracting them avoids a second, parallel copy of the same gate:

- `src/server/respond.ts` -- `sendText(res, status, message)`.
- `src/auth/gate.ts` -- `authorizeOrReject(runtime, ctx, action)`, the single seam every
  console route (admin and manager) uses to reach the matrix.
- `src/server/validation.ts` -- `requireField` and `parsePhone`, previously private to
  `src/admin/routes.ts`, now shared with the manager routes.

`src/admin/routes.ts` is updated to import these instead of defining its own copies;
its behavior is unchanged (covered by the existing `test/admin.test.ts`).

### Manager service (`src/manager/service.ts`)

- `listManagedSites(db, userId)` -- sites where the caller holds an authorized
  `role=manager` SiteRole, each with its site's pending invites. Scoped to the caller's own
  `userId` throughout -- never a client-supplied site list.
- `inviteSiteMember(db, siteId, role, invitedPhone)` -- creates a pending SiteRole for
  `role` (`manager` | `assistant`) at `siteId`, `user_id=null`. Idempotent: a repeat invite
  for the same not-yet-linked phone at the same site returns the existing pending/
  authorized record instead of inserting a duplicate row (the `site_id`/`user_id` unique
  index cannot catch this because `user_id` is null for every pending invite). Reuses
  `SiteNotFoundError` from `src/admin/service.ts` rather than a second error type.

### Routes (`src/manager/routes.ts`)

- `GET /manager` -- requires a session (redirect to `/auth/login` otherwise); lists the
  caller's managed sites via `listManagedSites`. This is a self-scoped read (filtered by
  the caller's own `userId`), so it needs no separate capability -- a customer session
  simply sees an empty state, never another manager's data.
- `POST /manager/sites/:siteId/invites` -- gated on `authorizeOrReject(..., { type:
'invite_site_role', siteId })` before parsing the body. Validates `phone` (reuses the
  admin console's phone shape check) and `role` (`manager` | `assistant` only -- anything
  else is a 400, not a silent fallback). Rate-limited per authenticated user (in-memory
  fixed window, same primitive as the public scan route) to bound spam invite rows, since
  no SMS cost gates it in this phase.

### Template (`src/render/templates/manager.ts`) + `public/js/manager.js`

Mirrors the admin console's pattern: real `<form>`s enhanced by a small vanilla ES module
(`data-manager-form`) that replays submissions via `fetch` with the `x-csrf-token` header;
inert without JS. No new CSS framework -- reuses the existing `card`/`stack-form`/list
primitives in `public/css/base.css` plus a small `select` rule and an `invites` list style.

## Tests (node:test)

- `test/manager.test.ts` -- `authorizeAction` denies `invite_site_role` for a plain member,
  for an assistant, for a manager at a _different_ site, and for a _pending_ (not yet
  authorized) manager; allows it for an authorized manager at their own site.
  `inviteSiteMember` persists a pending SiteRole with `user_id=null` for both `manager` and
  `assistant`, is idempotent for a repeat invite of the same phone, and rejects an unknown
  site. `listManagedSites` returns only the caller's own authorized-manager sites plus
  their pending invites.

## Out of scope (intentionally deferred)

- Real SMS/OTP delivery of the invite (task 16) -- this phase only persists the pending
  SiteRole row.
- The invite-bridge linking a pending SiteRole to a Cognito identity on first login
  (task 18, staged behind this one).
- Promote/revoke of an existing SiteRole -- the matrix already defines
  `promote_site_role`/`revoke_site_role` capabilities but wiring their routes is a
  separate task.
