# Phase 9 — Fix: "Forbidden" on authorize-hold, and demo accept-link CSRF collision — Plan

> Required by AGENTS.md (plan before a >5-step task). Two bugfixes, no product-facing
> feature change.

## Bug A: manager gets "Forbidden" clicking "Authorize hold" right after adding a payment method

Reported: a manager scans a QR with no saved payment method yet, clicks "Add a payment
method (mock)", then immediately clicks "Authorize hold for $X" on the page that follows —
and gets a bare 403 "Forbidden".

Root cause (confirmed by a real-browser reproduction, not a server-side/API-level test --
`POST /s/:token/authorize` end-to-end already had passing coverage against a raw HTTP
client, which is exactly why this was invisible to the test suite): `public/js/confirm.js`
renders each successful mutation's next-state page via `document.open(); document.write(html);
document.close();`. `document.write()` after the initial page load does not reliably
re-execute `<script type="module">` in the newly-written document (a long-standing browser
inconsistency, not spec-guaranteed behavior) -- confirmed directly: intercepting the
network request for the _second_ form submit (the "Authorize hold" click, right after the
"Add a payment method" `document.write`) shows a plain navigation-style POST with no
`x-csrf-token` header and `accept: text/html,...` / `upgrade-insecure-requests: 1` --
proof the browser fell back to the form's native submission because `confirm.js`'s
`submit` listener was never re-attached to the new DOM. The global CSRF gate
(`passesCsrf`, SDD's CSRF policy) then correctly, but unhelpfully, rejects the un-enhanced
POST as 403 Forbidden. A genuine fresh `GET /s/:token` page load (verified in the same
repro) authorizes correctly with the identical account and role -- the defect is purely in
the client-side script re-attachment after a `document.write`-rendered intermediate page,
not in `authorize.ts`/`enforce.ts`/`csrf.ts`.

### Fix

Replace `document.write()` in `public/js/confirm.js` with an in-place DOM swap that keeps
the _same_ script execution context alive, so no re-execution of the module script is
needed: parse the returned HTML with `DOMParser`, replace `document.body` with the parsed
body, update `document.title`, and re-run the _same_ attachment function (`enhance`) against
the new body. This is a client-side-only change; no server route or the authorize matrix
changes.

## Bug B: opening a second invite accept link (or copying it to a different context) breaks the first one with "Invalid or missing form token"

Reported: copying the "Accept link" and opening it in a different browser fails
acceptance with "Invalid or missing form token".

Root cause (confirmed by reproduction): `src/demo/routes.ts`'s pre-session double-submit
CSRF protection uses a single, fixed cookie name (`rs_demo_csrf`) for _every_
`GET /invite/accept` response, regardless of which invite code the page is for. Loading a
second accept link (a second invite, or the same one refreshed) overwrites the _same_
cookie in that browser/profile. Submitting an earlier-loaded accept page's form afterward
sends its (now-stale) hidden `demo_csrf` field against the browser's _current_ cookie value
(minted for the later page), which no longer matches -- exactly "Invalid or missing form
token", reproduced directly via two concurrent accept tabs in one context.

### Fix

Scope the double-submit cookie per accept-page load instead of a single fixed name: mint a
random nonce alongside the existing token, name the cookie `rs_demo_csrf_<nonce>`, and add a
second hidden field carrying the nonce. On submit, build the expected cookie name from the
_submitted_ nonce and compare against that specific cookie's value. Concurrent
accept-page loads (different invites, or the same one reloaded) each get an independently-named
cookie and no longer collide. The security property is unchanged: the browser must still
present a cookie only it could have received from the server's `Set-Cookie` on the matching
GET (the nonce is public, exactly like the code is; only the _token_ value is checked).

## Files

- `public/js/confirm.js` -- DOM-swap instead of `document.write` (Bug A).
- `src/demo/routes.ts` -- per-request nonce-scoped CSRF cookie name (Bug B).
- `src/render/templates/demo-invite.ts` -- second hidden field for the nonce (Bug B).
- `SDD.md` -- changelog entry + §6.3/§9.4 note.

## Tests

- Bug A is a client-side browser-execution defect invisible to server-side/API tests by
  construction (the existing `POST /s/:token/authorize` end-to-end test already covers the
  server side correctly and continues to pass unchanged). No new automated test can exercise
  real `<script type="module">` re-execution semantics without a browser test runner this
  repo does not have; documented here instead, and verified manually via a Playwright
  reproduction against a real local Postgres + dev server (not committed).
- Bug B: `test/demo-invite.test.ts` gets a new test asserting two concurrent
  `GET /invite/accept` responses mint independently-matching cookie+nonce+token triples, and
  that submitting the _first_ one after the second has been loaded still succeeds (the exact
  regression scenario). Existing single-flow accept tests continue to pass unchanged.
- Full gate: `npm test`, `test:coverage` (floors), `lint`, `build`.

## Out of scope

Any product-facing change beyond correcting these two defects. No new capability, role, or
route.
