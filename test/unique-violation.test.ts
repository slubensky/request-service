/**
 * `isUniqueViolation` (src/db/access.ts) is the shared detector behind every
 * "conditional write + defensive catch" idiom in this codebase (the §3.3 invite
 * bridge's `activateWinner`, and the one-saved-payment-method-per-site guard in
 * src/payments/service.ts, SDD §9.4) -- each promises a genuine Postgres unique
 * violation is caught and treated as a graceful no-op, never an unhandled 500.
 *
 * Regression: this drizzle-orm version wraps the driver's raw error (which carries
 * `.code`) in a `DrizzleQueryError`, attaching the original as `.cause` rather than
 * spreading its properties onto the top level. A detector that only inspects the
 * top-level object never sees `.code` on the wrapper and always returns false --
 * so every one of the three call sites' "never surfaces as a 500" guarantee silently
 * stopped working. Confirmed against a real Postgres 16 instance (not PGlite): a
 * genuine `23505` on `site_roles_site_user_key` propagated as an unhandled request
 * error instead of being caught by `activateWinner`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUniqueViolation } from '../src/db/access.js';

/** Shapes a `DrizzleQueryError`-like wrapper: a plain Error with `.cause` set to the
 * raw driver error, mirroring what drizzle-orm's node-postgres session actually throws. */
function wrappedPgError(code: string): Error {
  const raw = new Error('duplicate key value violates unique constraint') as Error & {
    code: string;
  };
  raw.code = code;
  const wrapper = new Error('Failed query: ...', { cause: raw });
  return wrapper;
}

test('detects a unique violation on the raw driver error (top-level .code)', () => {
  const raw = new Error('duplicate key') as Error & { code: string };
  raw.code = '23505';
  assert.equal(isUniqueViolation(raw), true);
});

test('detects a unique violation wrapped one level deep in .cause (the actual drizzle-orm shape)', () => {
  assert.equal(isUniqueViolation(wrappedPgError('23505')), true);
});

test('detects a unique violation wrapped multiple levels deep in nested .cause chains', () => {
  const raw = new Error('duplicate key') as Error & { code: string };
  raw.code = '23505';
  const level1 = new Error('inner', { cause: raw });
  const level2 = new Error('middle', { cause: level1 });
  const level3 = new Error('outer', { cause: level2 });
  assert.equal(isUniqueViolation(level3), true);
});

test('does not false-positive on an unrelated error code, wrapped or not', () => {
  assert.equal(isUniqueViolation(wrappedPgError('23503')), false); // foreign_key_violation
  const raw = new Error('not a conflict') as Error & { code: string };
  raw.code = '42601';
  assert.equal(isUniqueViolation(raw), false);
});

test('handles non-error inputs safely: null, undefined, primitives, plain objects with no code', () => {
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
  assert.equal(isUniqueViolation('some string'), false);
  assert.equal(isUniqueViolation(42), false);
  assert.equal(isUniqueViolation({}), false);
  assert.equal(isUniqueViolation({ message: 'no code here' }), false);
});

test('does not loop forever on a self-referential .cause chain', () => {
  const cyclic: { code?: string; cause?: unknown } = { code: '42601' };
  cyclic.cause = cyclic;
  assert.equal(isUniqueViolation(cyclic), false);
});
