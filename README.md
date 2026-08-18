# request-service

QR Bathroom Cleaning Service Request App -- a mobile-first, server-rendered web
app that lets authorized site staff request a fixed-price bathroom cleaning by
scanning a QR code, while a public scan can never create a payment
obligation. See `SDD.md` for the full spec and `ARCHITECTURE.md` for the
stack decision (no-framework, no-bundler Lean SSR on Node.js, AWS via
Terraform).

## Local development

Requires Node.js >= 20 and a local PostgreSQL instance.

1. **Start Postgres.** Easiest with Docker:

   ```sh
   docker run --name request-service-db -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=request_service -p 5432:5432 -d postgres:16
   ```

   (Already have Postgres installed natively? Just create a `request_service`
   database and point `DATABASE_URL` at it instead.)

2. **Install dependencies and configure the environment.**

   ```sh
   npm install
   cp .env.example .env
   ```

   `.env.example` documents every variable; the defaults work as-is against
   the Docker command above. Load it into your shell before running any
   script below, e.g. `export $(grep -v '^#' .env | xargs)`, or use a tool
   like [direnv](https://direnv.net/) or `dotenvx` to do it automatically.

3. **Run migrations.**

   ```sh
   npm run db:migrate
   ```

4. **Start the dev server** (hot-reloads on change):

   ```sh
   npm run dev
   ```

   Visit `http://localhost:3000`.

5. **Bootstrap a Company Admin session.** Company Admin is never self-service
   (SDD §3) -- it's provisioned as an ops action against the database. For a
   laptop sandbox, do that with:

   ```sh
   npm run dev:login
   ```

   This finds-or-creates a `company_admin` user and prints a browser-console
   snippet (and a `curl` example) to set the session cookie, so you can reach
   `/admin` without deploying a real Cognito user pool.

6. **Walk the full flow without live SMS/Cognito.** With `DEMO_MODE=1` (the
   `.env.example` default), inviting a manager or assistant from the Admin or
   Manager console surfaces a single-use accept code and link (SDD §6.3) that
   stands in for SMS-OTP verification -- click through it in a private/
   incognito window to activate that identity, no real phone or AWS involved.
   `DEMO_MODE` is off by default in production.

7. **Run tests / lint / build:**

   ```sh
   npm test              # fast, no coverage
   npm run test:coverage # what CI runs -- gated on a coverage floor
   npm run lint
   npm run build
   ```

Real Amazon Cognito (SMS OTP + passkeys) and Stripe are optional for local
work: Cognito's env vars are commented out in `.env.example` and every auth
route fails closed (503) rather than run half-configured when they're unset,
and the payment lifecycle currently runs against an in-process mock gateway
(SDD §9.3) -- no Stripe SDK, no live keys, no real card collection, in every
environment.
