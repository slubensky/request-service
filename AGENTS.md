# Request Service — Agent Guide

## Purpose
This repository is maintained with a spec-first, test-first, security-conscious workflow. Keep solutions simple, reviewable, and aligned with the current spec.

## Core rules
- Always update the spec before changing behavior. Include the date and the time of the latest edit.
- Always write or update tests before or alongside code changes.
- Always run the required tests before proposing completion.
- Never merge or recommend merge when any required test is failing.
- Prefer the simplest architecture that satisfies the current spec.
- Never mass edit more than 3 files without showing me the plan first.
- If a task takes more than 5 steps, create a plan document first.
- For any complex task (more than 3 files, or more than 5 steps), presenting the plan is not enough: stop and wait for my explicit approval before executing it. Do not implement, edit, or run anything beyond investigation until I approve.

## Architecture
- Keep architecture minimal and easy to understand.
- Prefer a modular monolith unless the spec explicitly requires otherwise.
- Minimize dependencies, abstractions, background workers, and operational complexity.
- Do not introduce new frameworks, services, or patterns without documenting the need in the spec.
- Optimize for maintainability and reviewability over cleverness.

## Security
- Treat all changes as security-relevant unless clearly proven otherwise.
- Follow OWASP secure coding practices and use OWASP ASVS as the verification baseline.
- Apply secure defaults, least privilege, defense in depth, fail-safe behavior, and complete mediation.
- Validate and sanitize all untrusted input.
- Use parameterized queries and safe APIs for database access.
- Enforce authentication and authorization on every sensitive path.
- Never hardcode secrets, tokens, or credentials.
- Never expose secrets or sensitive data in code, logs, tests, fixtures, or diffs.
- Use approved cryptographic libraries only; never invent crypto.
- Avoid unsafe deserialization, shell execution, dynamic code execution, and unnecessary outbound network access.
- Log security-relevant events without leaking sensitive data.
- Add or update security tests when auth, access control, input validation, data handling, or external interfaces are affected.
- Never store data in the code, such as email addresses, user names, passwords

## Required workflow
For every task, follow this order:
1. Update the spec.
2. Write or update tests.
3. Implement the code.
4. Run relevant tests.
5. Confirm all tests pass.
6. Only then consider the change ready for review or merge.

### Spec changelog (binding)
Step 1 is not complete until the changelog is updated. Every change to the spec
(`SDD.md`) MUST append an entry to the `## Changelog` section at the bottom of
`SDD.md`. Each entry MUST carry:
- A sequential change number, zero-padded to three digits (`#001`, `#002`, …).
- An ISO-8601 date-time including UTC offset, in the America/New_York time zone
  (e.g. `2026-08-14T16:40:56-04:00`).
- A concise description of what changed and why.
A spec edit without a corresponding changelog entry is not merge-ready.

## Spec policy
- The spec is the source of truth.
- Every behavior change must be reflected in the spec.
- Update assumptions, acceptance criteria, architecture notes, and security impact in the spec.
- If the request is ambiguous or conflicts with the current spec, stop and resolve the spec first.
- Do not leave undocumented behavior changes.

## Testing policy
- Add unit tests for logic changes.
- Add integration tests for boundary behavior and cross-component behavior.
- Add regression tests for bug fixes.
- Add security-oriented tests when the change touches risky areas.
- Run fast scoped tests during iteration, then run the required full test suite before completion.
- Do not treat skipped, missing, or failing tests as acceptable without explicit justification in the spec.

## Reviewability requirements
Every change must be easy for a human reviewer to inspect. Include the following in every PR or handoff:
- Spec diff: what changed and why.
- Test diff: which tests were added or updated.
- Risk notes: security, migration, operational, and rollback considerations.
- Test evidence: exact commands run and results.
- Scope statement: what is intentionally not included.

When making changes:
- Prefer small, focused diffs.
- Avoid mixing refactors with feature changes unless required.
- Keep naming explicit and consistent.
- Remove dead code created by the change.
- Document non-obvious tradeoffs briefly in the spec or PR notes.

## Merge gate
A change is merge-ready only if all of the following are true:
- The spec is updated.
- Tests were added or updated appropriately.
- The implementation matches the spec.
- All required tests pass.
- No critical or high-severity security issue is introduced.
- Risks, limitations, and follow-ups are documented.

## Failure handling
- If tests fail, do not merge.
- If the spec is outdated, update it before proceeding.
- If a secure implementation is not feasible, stop and document the risk instead of shipping a weaker workaround.

## Response format for Claude
When completing a coding task, respond with:
1. Spec changes
2. Tests added or updated
3. Code changes
4. Test commands executed
5. Test results
6. Risks or follow-ups

## Performance targets

> **Last edited:** 2026-08-14 — replaced the prior LLM-app targets (time to first token, time to segment annotation render, full response time) and the generic `< 100 ms` cold page load figure with mobile-first Web Vitals appropriate to the QR Bathroom Cleaning Service Request App. The no-framework / no-bundler architectural rule is unchanged; see ARCHITECTURE.md §5 for the full rationale.

| Requirement | Target |
| --- | --- |
| FCP (First Contentful Paint) | < 1.5 s (mid-tier mobile, 4G) |
| LCP (Largest Contentful Paint) | < 2.5 s (mid-tier mobile, 4G) |
| INP (Interaction to Next Paint) | < 200 ms |
| CLS (Cumulative Layout Shift) | < 0.1 |
| TTFB (SSR) | < 200 ms (p95) |
| Client JS budget | < 50 KB gzipped (public visitor page ≈ 0 KB — no framework, no bundler) |
| Concurrent users | 50 simultaneous (single process; scale horizontally if needed) |
| HTTPS | Required in production (terminate at reverse proxy or platform) |

## Branch

> **Last edited:** 2026-08-19 — changed merge authority: an agent (Claude) may
> now merge its own pull request once CI is green, without waiting for a
> human to click merge. Everything else about the branch/PR workflow is
> unchanged — a PR is still required, direct commits to `main` are still
> disallowed, and CI must still be green. See "Merge authority" below.

`main` is the canonical source of truth. Develop on a short-lived feature branch and open a pull request into `main` — do not commit directly to `main`. CI (tests + `terraform validate`) must pass before merge.

### Merge authority

CI green is sufficient authorization to merge — a human does not need to click merge for every PR. An agent that opened a PR may merge it itself once CI passes and the Merge gate criteria below are met, without waiting for further sign-off, *unless*:

- CI is failing (see Failure handling — do not merge),
- a human has left unresolved review comments or an unaddressed change request on that PR, or
- the human explicitly asked to review this specific change before it merges.

A human can still review, comment, or block any PR at any time — this changes the *default* (no blocking wait for a merge click), not the ability to intervene. This applies to PRs opened by an agent; it does not change how humans merge their own PRs.

