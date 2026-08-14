import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router } from '../src/server/router.js';

test('matches a registered static route', () => {
  const router = new Router();
  const handler = () => {};
  router.get('/healthz', handler);

  const match = router.match('GET', '/healthz');

  assert.ok(match);
  assert.equal(match.handler, handler);
  assert.deepEqual(match.params, {});
});

test('captures :param path segments', () => {
  const router = new Router();
  const handler = () => {};
  router.get('/bathrooms/:id', handler);

  const match = router.match('GET', '/bathrooms/abc-123');

  assert.ok(match);
  assert.deepEqual(match.params, { id: 'abc-123' });
});

test('returns undefined when the method does not match', () => {
  const router = new Router();
  router.get('/healthz', () => {});

  assert.equal(router.match('POST', '/healthz'), undefined);
});

test('returns undefined when the path does not match', () => {
  const router = new Router();
  router.get('/healthz', () => {});

  assert.equal(router.match('GET', '/nope'), undefined);
});

test('does not match routes with a different segment count', () => {
  const router = new Router();
  router.get('/bathrooms/:id', () => {});

  assert.equal(router.match('GET', '/bathrooms/abc/extra'), undefined);
});
