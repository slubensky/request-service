# Architecture Decision Record — No-Framework, No-Bundler Lean SSR on AWS

> **Last edited:** 2026-08-14
>
> **Status:** Decided, pending final human sign-off on the Blueprint (`art_RUHUe0PF`, v0.3). Companion to SDD.md, which is the functional source of truth; this document is the technical/deployment source of truth.

## 1. Decision

The QR Bathroom Cleaning Service Request App is built as a **single-deployable modular monolith**, with **no client framework and no bundler**, deployed on **AWS managed services via Terraform**. One server-side trust boundary owns authorization, price, Stripe, and QR resolution; identity and SMS OTP are delegated to Amazon Cognito.

This satisfies two constraints that are both binding, not optional:

1. **AGENTS.md's no-framework / no-bundler rule** ("Do not introduce new frameworks, services, or patterns without documenting the need in the spec" and the project's minimal-monolith mandate).
2. **Minimizing code we own** by using managed AWS services (Cognito, RDS/Aurora, App Runner, Secrets Manager) in place of hand-rolled auth, ops, and infrastructure code.

## 2. Stack & module map

| Layer                    | Choice                                                                                                                                                                                        | Notes                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server**               | TypeScript on Node.js LTS, no bundler. Native `node:http` + a small hand-written typed router.                                                                                                | No Express, no Fastify, no Next.js, no other server framework.                                                                                                                                                                            |
| **UI (server-rendered)** | Server-rendered HTML via template literals.                                                                                                                                                   | No JSX, no server-side templating framework (e.g. EJS/Handlebars) beyond plain template literals with explicit escaping.                                                                                                                  |
| **UI (client)**          | Progressive-enhancement vanilla ES modules (`<script type="module">`), loaded directly by the browser. Islands only where needed (e.g. Stripe Payment Element mount, passkey WebAuthn calls). | No bundler (no webpack/vite/esbuild bundling step for shipped code). No React/Vue/etc.                                                                                                                                                    |
| **Styling**              | Hand-authored, mobile-first CSS with design tokens (CSS custom properties).                                                                                                                   | No CSS framework (no Tailwind, no Bootstrap).                                                                                                                                                                                             |
| **Data**                 | Amazon RDS / Aurora Serverless v2 **PostgreSQL**, accessed through **Drizzle ORM**.                                                                                                           | Drizzle is a typed query builder/migration library, not a framework — it does not dictate application structure or routing. Typed, parameterized queries only (AGENTS.md: "Use parameterized queries and safe APIs for database access"). |
| **Auth**                 | **Amazon Cognito** managed passwordless: SMS OTP + WebAuthn passkeys, via **Cognito managed login (Hosted UI)**.                                                                              | Cognito owns _authentication_. The application server owns _authorization_ (SiteRole) — see SDD.md §3 and §7. Hosted UI is chosen over a custom SSR auth UI for lowest implementation cost; see §6 for the tradeoff.                      |
| **Payments**             | Stripe Node SDK, server-side only, plus the Payment Element loaded from Stripe's CDN client-side.                                                                                             | Manual-capture PaymentIntents, signed/verified webhooks, idempotency keys on every creation call. See SDD.md §9.                                                                                                                          |
| **Deploy**               | **Terraform** provisions AWS App Runner (managed SSR container), RDS/Aurora Serverless v2, Cognito, Secrets Manager, ACM + Route 53. Region: `us-east-1`.                                     | Infrastructure as code; `terraform validate` runs in CI on every change.                                                                                                                                                                  |
| **QR / tests / CI**      | `qrcode` (server-side generation library), `node:test` (built-in test runner), CI runs lint · test · build · `terraform validate`.                                                            | `qrcode` is a small, single-purpose library, not a framework.                                                                                                                                                                             |

### 2.1 What "no framework, no bundler" means in practice

- **Allowed:** focused libraries that do one job and don't dictate application structure — Drizzle (typed SQL), the Stripe SDK (typed API client), `qrcode` (image generation), the AWS SDK (service clients), Cognito's client libraries for token verification.
- **Not allowed:** anything that imposes an application framework (Express/Fastify/Next/Remix/etc.), a client UI framework (React/Vue/Svelte/etc.), or a build/bundle step to produce the shipped client JS (webpack/vite/esbuild/rollup as a bundler for browser code).
- **Rationale for the distinction:** a framework or bundler changes how the codebase is structured and how much of it we must reason about ourselves; a well-scoped library is a typed API surface we call into. The former violates AGENTS.md's minimal-dependency and no-framework rules; the latter does not, provided each is justified in SDD.md §13 before adoption.
- Each dependency in the table above is justified in SDD.md §13 and this document; none is a client framework or requires a bundler.

## 3. Trust boundary

The **server is the single authorization point**. Cognito handles authentication (identity only); card data flows from the browser to Stripe directly via the Payment Element and never passes through our server. Every state-changing decision — SiteRole checks, price derivation, PaymentIntent creation/capture, QR resolution — happens inside this one server-side boundary. See SDD.md §3, §7, §8, §9 for the specific invariants this boundary enforces.

## 4. Deployment topology (AWS via Terraform)

- **App Runner** runs the SSR Node.js container as the single deployable service (the modular monolith).
- **RDS / Aurora Serverless v2 (PostgreSQL)** is the sole datastore, accessed only from the App Runner service through Drizzle.
- **Amazon Cognito** provides the user pool, Hosted UI, SMS OTP, and WebAuthn passkey support.
- **Secrets Manager** holds Stripe API keys and Cognito/DB credentials — never hardcoded, never logged, never committed (AGENTS.md security rules).
- **ACM + Route 53** provide TLS certificates and DNS; HTTPS is required in production (see §5 performance/ops targets).
- **Terraform** is the only path to provisioning any of the above. `terraform validate` runs in CI on every change to `infra/`; actual `apply`/deploy happens only after explicit human approval, per the Blueprint's sandbox-first build plan — this repository's CI never applies infrastructure changes automatically.

## 5. Mobile-first performance & operational targets

These replace the AGENTS.md "Performance targets" section (see the corresponding AGENTS.md edit in this same change) with numbers appropriate to a server-rendered mobile web app, rather than the prior LLM-app-specific targets.

| Metric                          | Target                                    | Condition                                              |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| FCP (First Contentful Paint)    | < 1.5s                                    | mid-tier mobile, 4G                                    |
| LCP (Largest Contentful Paint)  | < 2.5s                                    | mid-tier mobile, 4G                                    |
| INP (Interaction to Next Paint) | < 200ms                                   | interaction responsiveness                             |
| CLS (Cumulative Layout Shift)   | < 0.1                                     | layout stability                                       |
| TTFB (SSR)                      | < 200ms p95                               | server response                                        |
| Client JS budget                | < 50KB gzipped (public visitor page ~0KB) | direct benefit of the no-framework/no-bundler decision |
| Concurrency                     | 50 concurrent users                       | MVP; single process, scale horizontally if needed      |
| HTTPS                           | Required in production                    | terminated via ACM at App Runner / Route 53            |

The near-zero client JS on the public visitor page is a direct, measurable consequence of §2's decision: that page ships no framework runtime and no bundled dependency graph, only the minimal HTML/CSS needed for the neutral "notify staff" experience (SDD.md §11).

## 6. Alternative considered and rejected

**React Server Components + a bundler, with shadcn/ui.**

- **Strength:** batteries-included component ecosystem; fast to assemble a polished UI.
- **Tradeoff / why rejected:** directly violates the binding AGENTS.md "no framework / no bundler" requirement. The project's architectural constraint was reaffirmed, not the framework's convenience — rejected per the locked decision to keep the no-framework rule (Blueprint `art_RUHUe0PF` v0.3, "Locked decisions").

## 7. Open questions (safe defaults assumed, pending sign-off)

- **Cognito login UI:** assumed **Cognito managed login (Hosted UI)** for lowest implementation cost, accepting lighter/less-customizable branding versus a fully custom SSR auth UI built against the Cognito API.
- **Database tier:** assumed **Aurora Serverless v2 PostgreSQL** (scales down to low cost at MVP traffic) over a fixed-size single RDS Postgres instance.
- **AWS region:** assumed `us-east-1` unless a different region is specified.

These are documented as assumptions per AGENTS.md's spec policy ("If the request is ambiguous ... stop and resolve the spec first" — here, resolved with an explicit, reversible default rather than blocking).

## 8. Relationship to the build plan

This architecture is built incrementally per the Blueprint's sandbox-first build plan: the application is built and hosted in the sandbox against local Postgres, and the Terraform in `infra/` is authored and `terraform validate`-checked in CI, but no AWS deploy happens until a human explicitly approves it. This document and SDD.md are both authored in Phase 0 ("Record SDD.md ... record ARCHITECTURE.md") ahead of any application scaffolding.
