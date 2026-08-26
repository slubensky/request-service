# Phase 8 — Fix: revoke permanently blocks re-invitation — Plan

> Required by AGENTS.md (plan before a >5-step task). Bugfix, no product-facing feature.

## Bug

Reported: after a Company Admin invites a manager and the manager accepts, the manager
sees _"Your invitation was recorded, but you do not currently hold active authority at
this site. Ask a manager to re-invite you."_ — even on a fresh, single invite.

Root cause (confirmed by reproduction against PGlite, not a data artifact): **once any
SiteRole is revoked, that identity can never be re-invited and reactivated at the same
site again**, and the demo copy's suggested fix ("ask a manager to re-invite you") is
exactly the action that silently fails:

1. `site_roles_site_user_key` is a **plain** unique index on `(site_id, user_id)` — a
   `revoked` row permanently occupies that slot forever.
2. `bridgeSiteGroup`'s `existingRole` guard (`src/db/access.ts`) checks for **any** row
   matching `(site_id, user_id)`, regardless of status. A revoked row is caught by this
   guard exactly like an active one, so the bridge treats "was revoked" as "already has a
   role here" and **no-ops** — it never activates the fresh pending invite. The new
   invite's row is instead superseded to `revoked` (SDD §3.3's duplicate-handling path),
   and the accepter is left with no authority.

Reproduction (against PGlite): invite phone X as manager → accept → activates. Revoke.
Re-invite the same phone X at the same site → a genuinely fresh `pending` row is created
(invite-idempotency correctly treats a revoked phone as available). Accept again →
`bridgePendingSiteRoles` returns `[]`; the fresh row ends up `revoked`, never `authorized`.

This surfaces now because revoke became a real, exercised feature in Phase 6/7 (Company
Admin revoking a manager or authorized user); it was latent since Phase 1.

## Fix

### D1 — Partial unique index: a revoked row no longer occupies the uniqueness slot

Change `site_roles_site_user_key` to a **partial** unique index excluding revoked rows —
the same pattern already used for `cleaning_requests_bathroom_active_key`:

```ts
uniqueIndex('site_roles_site_user_key')
  .on(table.siteId, table.userId)
  .where(sql`${table.status} <> 'revoked'`);
```

This still enforces "at most one **active** (authorized) role per user per site" — the
actual invariant that matters — while allowing a historical revoked row and a later fresh
authorized row to coexist for the same `(site_id, user_id)` pair. Drizzle-kit can generate
this migration normally (an index redefinition, not a rename).

### D2 — The bridge's existing-role guard ignores revoked rows

`bridgeSiteGroup` (`src/db/access.ts`) must treat "only ever had a revoked role here" the
same as "no role here" for the purpose of allowing a fresh activation: add
`ne(siteRoles.status, 'revoked')` to the `existingRole` lookup. Combined with D1, the
subsequent `UPDATE ... SET user_id = ?` on the winning pending row now succeeds instead of
being blocked, and no longer violates the (now-partial) unique index.

### D3 — Callers that read "the" SiteRole for (site, user) must prefer the active one

Once D1 permits **two** rows for the same `(site_id, user_id)` (one historical `revoked`,
at most one current non-revoked), every read keyed on `(site_id, user_id)` with an
unordered `LIMIT 1` becomes ambiguous and must be made deterministic:

- **`resolveSiteRole`** (`src/db/access.ts`) — the production authorization read used by
  `authorizeAction` on **every** request. Order so a non-revoked row is preferred over a
  revoked one (`ORDER BY (status = 'revoked') ASC, id`); at most one non-revoked row can
  exist (D1's index), so this is deterministic. If only revoked history exists, the
  revoked row is still returned (preserving the specific `role_revoked` deny reason over a
  blanket `no_site_role`).
- **`acceptDemoInviteCode`**'s post-bridge "what's my actual authority now" read
  (`src/demo/service.ts`) — same ordering, so the result page reflects a just-reactivated
  role rather than accidentally reading stale revoked history.

No other read is affected: `listManagedSites` and the admin/manager membership listings
already filter or don't assume single-row-per-(site,user) semantics.

## Files

- `src/db/schema.ts` — partial unique index (D1).
- `src/db/access.ts` — `resolveSiteRole` ordering (D3), `bridgeSiteGroup` existingRole
  guard (D2).
- `src/demo/service.ts` — `acceptDemoInviteCode` ordering (D3).
- New migration `drizzle/0004_...` (drizzle-kit generated).
- `SDD.md` §3.3 / §4.1 note + changelog entry.

## Tests

- `db/access.ts`: revoke a manager, re-invite the same phone at the same site, accept via
  `bridgePendingSiteRoles` → activates (`status=authorized`, correct `userId`); the old
  revoked row is untouched; `resolveSiteRole` returns the active row, not the revoked one.
- `authorizeAction` reflects restored authority after reactivation.
- `demo/service.ts`: `acceptDemoInviteCode` on a re-invite-after-revoke reports
  `activated:true`, not the false "no active authority" outcome.
- Regression: the existing revoke/duplicate-bridge tests (`invite-bridge-duplicates.test.ts`)
  still pass unchanged (no behavior change for the non-revoked paths).
- Full gate: `npm test`, `test:coverage` (floors), `lint`, `build`.

## Out of scope

Any product-facing change beyond correcting this defect. No new capability, role, or route.
