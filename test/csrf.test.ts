import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csrfTokenForSession, requiresCsrf, verifyCsrfToken } from '../src/auth/csrf.js';

const SECRET = 'unit-test-csrf-key-not-a-real-secret';
const SESSION = 'session-token-abc';

test('safe methods do not require a CSRF token', () => {
  assert.equal(requiresCsrf('GET'), false);
  assert.equal(requiresCsrf('HEAD'), false);
  assert.equal(requiresCsrf('OPTIONS'), false);
});

test('state-changing methods require a CSRF token', () => {
  assert.equal(requiresCsrf('POST'), true);
  assert.equal(requiresCsrf('put'), true);
  assert.equal(requiresCsrf('DELETE'), true);
});

test('a token derived from the session verifies', () => {
  const token = csrfTokenForSession(SESSION, SECRET);
  assert.equal(verifyCsrfToken(SESSION, token, SECRET), true);
});

test('a token from a different session is rejected', () => {
  const token = csrfTokenForSession('another-session', SECRET);
  assert.equal(verifyCsrfToken(SESSION, token, SECRET), false);
});

test('a missing token is rejected', () => {
  assert.equal(verifyCsrfToken(SESSION, undefined, SECRET), false);
});

test('a token under a different secret is rejected', () => {
  const token = csrfTokenForSession(SESSION, 'other-secret');
  assert.equal(verifyCsrfToken(SESSION, token, SECRET), false);
});
