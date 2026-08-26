# Plan — DEMO_MODE invitation-code acceptance flow (PR-A)

## Goal

Let the FULL invite → accept → activation loop be walked in a browser without live
SMS/Cognito, gated entirely behind a `DEMO_MODE` environment flag. Production
activation stays phone-verified via SMS OTP + the §3.3 bridge and is untouched.

## Locked design (from the task brief)

- **Gated:** the whole flow sits behind `DEMO_MODE`. OFF (production default) → no
  code is generated or displayed and the accept routes are not registered (404).
- **Invite code:** creating an invite in DEMO_MODE mints a single-use code tied to
  that specific pending SiteRole and persists it; the manager console shows the code
  plus a copyable accept link.
- **Accept URL:** `GET /invite/accept` (form) + `POST /invite/accept` (validate). A
  valid, unused code mints a demo session standing in for SMS-OTP verification of the
  invited phone, then runs the EXISTING `bridgePendingSiteRoles` (§3.3) UNCHANGED, so
  activation is identical to production (manager → authorized, assistant → linked but
  pending). Result page reflects the outcome. Code is marked used; reuse rejected.
- **No parallel activation path:** reuse `bridgePendingSiteRoles`.

## Steps

1. Spec first: SDD §6.3 + Changelog entry #002.
2. Schema: `demo_invite_codes` table (single-use code → pending SiteRole) + migration.
3. `src/demo/config.ts` — `isDemoMode()`.
4. `src/demo/service.ts` — code generation/issue/lookup, claim-once accept that reuses
   `findOrCreateUserByCognitoSub` + `bridgePendingSiteRoles`.
5. `src/render/templates/demo-invite.ts` — accept form, result, rejection pages.
6. `src/demo/routes.ts` — GET/POST `/invite/accept`, registered only in DEMO_MODE,
   with a double-submit CSRF token for the pre-session POST.
7. Wire `registerDemoRoutes` + the DEMO_MODE-only CSRF exemption in `server/app.ts`.
8. Manager routes/template: issue + display the code in DEMO_MODE only.
9. Tests: `test/demo-invite.test.ts` — happy manager, assistant pending, invalid,
   already-used, DEMO_MODE OFF disables codes + routes.

## Security notes

- Deny-by-default matrix unchanged; activation authority is conferred solely by the
  §3.3 bridge setting `status=authorized` for a manager — no hardcoded elevation.
- Pre-session POST is protected by an origin-bound double-submit token; the exemption
  from the session-bound CSRF gate is DEMO_MODE-gated and inert in production.
- No AWS/SMS; tests run fully mocked against PGlite.
