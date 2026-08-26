# Phase 7 — Restroom Hero UI + Admin Authorized-User Management — Plan

> Required by AGENTS.md (plan before a >5-step task). Four product-owner tasks; only
> Task 1 touches authorization (SDD §7), the rest are UI/UX. Still mock-only.

## Tasks

1. **Admin manages authorized users too.** The Company-Admin console lists, per site, both
   **managers and authorized users** with each authorized user's **approval limit**; the
   admin can **revoke an authorized user** (not just managers) and **change an authorized
   user's approval limit**.
2. **Manager accept → Continue goes to `/manager`.** After a manager accepts their invite,
   the result page's Continue link points to the manager console.
3. **Authorized-user accept → no Continue link.** An authorized user has no console; the
   result page shows no Continue link.
4. **Restyle the web app to mimic the Restroom Hero mobile app** in the attached video.

## Extracted design system (from the video)

A clean iOS-style mobile design:

| Token   | Value                                   | Use                         |
| ------- | --------------------------------------- | --------------------------- |
| page bg | `#ECECEE` (dark `#121316`)              | neutral gray behind cards   |
| surface | `#FFFFFF` (dark `#1E1F25`)              | rounded white cards         |
| fg      | `#1A1B1E` (dark `#F3F4F6`)              | bold near-black headings    |
| muted   | `#8A8D95`                               | section labels + meta text  |
| primary | `#1C1C1E` (dark `#F3F4F6`)              | **black pill** buttons      |
| accent  | `#12B2C4` teal                          | brand "HERO", links         |
| success | `#2FBF71` green                         | status pills                |
| border  | `#E6E7EA` (dark `#2C2E36`)              | hairline card/input borders |
| radius  | card 16px · input 12px · **pill 999px** | rounded everything          |

Components observed: a top app bar with the **RESTROOM HERO** wordmark (teal "HERO");
white rounded cards grouped under small gray **section labels**; list rows = circular icon

- bold title + gray sub + right-aligned value; **black pill** primary buttons, **white
  outline pill** secondaries, **gray pill** disabled; green **status/badge pills**; rounded
  white inputs; bold right-aligned prices.

## Design decisions

### D1 — Admin authority over authorized users (Task 1)

- **Revoke** already works for the admin: `revokeSiteRole` is role-agnostic and the admin
  route `POST /admin/sites/:siteId/roles/:roleId/revoke` gates on `site_role:revoke` (held
  by `company_admin` on the platform axis). Only the **UI** needs to surface authorized
  users with a Revoke control — no matrix change for revoke.
- **Set limit**: `site_role:set_limit` is currently a **manager-only** site capability. Add
  it to the `company_admin` **platform** matrix (same one-capability-two-axes pattern as
  `site_role:revoke`), and add `POST /admin/sites/:siteId/roles/:roleId/limit` reusing the
  existing `setAuthorizedUserLimit` service (which already rejects a non-authorized-user
  target). SDD §7 + §11.1/§11.3 + changelog #009.
- **Listing**: extend `listSitesWithBathrooms` to return all non-revoked site roles
  (managers + authorized users) instead of only managers; the console shows managers with
  Revoke, and authorized users with their limit + Revoke + a set-limit form.

### D2 — Accept-result Continue link is role-aware (Tasks 2 & 3)

`renderAcceptResult` takes the role; the Continue link renders **only** for an activated
`manager`, pointing at `/manager`. An activated `authorized_user` gets no link (no console).
The inactive branch keeps no link. Demo-only copy (SDD §6.3), no spec change.

### D3 — Restyle keeps the existing class vocabulary (Task 4)

The overhaul is **CSS-first**: rewrite `public/css/base.css` to the design system above and
keep every existing class name so server templates and tests are unaffected. Additive
markup only where it clearly helps: a brand app-bar in the shared layout, `.section-label`
spans, and button-variant classes (`.button-secondary`, destructive `.button-danger` for
Revoke/Delete). Light/dark themes both defined via tokens. No framework, no bundler
(ARCHITECTURE.md §2 unchanged) — one hand-authored stylesheet.

Pages restyled (all existing templates): home, public scan (neutral page stays ~0 KB JS),
confirm/add-method/reauth/approval, admin console, manager console, demo accept form +
result, payments console, QR issued.

## Files

- **Auth**: `src/auth/authorize.ts` (+`site_role:set_limit` on company_admin platform set).
- **Admin**: `src/admin/service.ts` (`listSitesWithBathrooms` → all non-revoked roles;
  reuse `revokeSiteRole`), `src/admin/routes.ts` (+set-limit route), `render/templates/admin.ts`
  (managers + authorized users w/ limit, revoke, set-limit).
- **Demo**: `render/templates/demo-invite.ts` (role-aware Continue link).
- **UI**: `public/css/base.css` (full restyle), `src/render/templates/layout.ts` (brand app
  bar), minor class/section-label additions across templates.

## Tests

- authorize: `company_admin` holds `site_role:set_limit`; still not `cleaning_request:create`.
- admin service: `listSitesWithBathrooms` returns authorized users with limits; admin
  set-limit via HTTP updates the limit and rejects a manager target; admin revoke of an
  authorized user sets `revoked`.
- demo: `renderAcceptResult` — manager has a `/manager` Continue link; authorized_user has
  **no** link.
- Keep all existing markup assertions passing (class names unchanged).
- Full gate: `npm test`, `test:coverage` (floors), `lint`, `build`.

## Verification

After the gate, launch the SSR app (Playwright/Chromium available) and screenshot the admin
console, manager console, and a scan/confirm page to confirm the look matches the video; send
those to the product owner.

## Out of scope

Real map/geolocation, profile photos, push/SMS, the native "cleaner's side" job flow, and any
non-cosmetic behavior change beyond Task 1's admin authority. No migration.
