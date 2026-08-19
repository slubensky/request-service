import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signSession, verifySession, type SessionPayload } from '../src/auth/session.js';
import { sessionAuthenticatedWithin } from '../src/auth/guard.js';

const SECRET = 'unit-test-signing-key-not-a-real-secret';
const MAX_AGE = 3600;

test('a signed session round-trips through verification', () => {
  const token = signSession({ userId: 'user-1', sub: 'sub-1' }, SECRET, 1000);
  const payload = verifySession(token, SECRET, MAX_AGE, 1000);
  assert.deepEqual(payload, { userId: 'user-1', sub: 'sub-1', iat: 1000 });
});

test('a tampered payload fails verification', () => {
  const token = signSession({ userId: 'user-1', sub: 'sub-1' }, SECRET, 1000);
  const [, signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ userId: 'attacker', sub: 'sub-1', iat: 1000 }),
  ).toString('base64url');
  const forged = `${forgedPayload}.${signature ?? ''}`;
  assert.equal(verifySession(forged, SECRET, MAX_AGE, 1000), null);
});

test('a different secret fails verification', () => {
  const token = signSession({ userId: 'user-1', sub: 'sub-1' }, SECRET, 1000);
  assert.equal(verifySession(token, 'other-secret', MAX_AGE, 1000), null);
});

test('an expired session is rejected', () => {
  const token = signSession({ userId: 'user-1', sub: 'sub-1' }, SECRET, 1000);
  assert.equal(verifySession(token, SECRET, MAX_AGE, 1000 + MAX_AGE + 1), null);
});

test('a session issued in the future is rejected', () => {
  const token = signSession({ userId: 'user-1', sub: 'sub-1' }, SECRET, 2000);
  assert.equal(verifySession(token, SECRET, MAX_AGE, 1000), null);
});

test('malformed tokens are rejected without throwing', () => {
  assert.equal(verifySession('not-a-token', SECRET, MAX_AGE, 1000), null);
  assert.equal(verifySession('', SECRET, MAX_AGE, 1000), null);
});

// Step-up re-authentication (SDD §6.4): sessionAuthenticatedWithin is a pure predicate over
// a session's iat, keyed off the same "time since last authentication" idea the signed
// session already carries -- exercised directly here rather than only indirectly via the
// higher-level payment-reuse routes (test/public-authorize.test.ts).
function sessionAt(iat: number): SessionPayload {
  return { userId: 'user-1', sub: 'sub-1', iat };
}

test('sessionAuthenticatedWithin holds within the window', () => {
  assert.equal(sessionAuthenticatedWithin(sessionAt(1000), 300, 1000), true);
  assert.equal(sessionAuthenticatedWithin(sessionAt(1000), 300, 1299), true);
  assert.equal(sessionAuthenticatedWithin(sessionAt(1000), 300, 1300), true, 'inclusive boundary');
});

test('sessionAuthenticatedWithin fails once the window has elapsed', () => {
  assert.equal(sessionAuthenticatedWithin(sessionAt(1000), 300, 1301), false);
  assert.equal(sessionAuthenticatedWithin(sessionAt(1000), 300, 5000), false);
});

test('sessionAuthenticatedWithin fails closed for an iat in the future', () => {
  assert.equal(sessionAuthenticatedWithin(sessionAt(2000), 300, 1000), false);
});
