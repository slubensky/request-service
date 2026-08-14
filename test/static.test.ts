import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { serveStaticFile } from '../src/server/static.js';

const publicDir = new URL('../public', import.meta.url).pathname;

// These branches all return `false` before ever touching `res`, so a stub
// that throws on any use is a valid double: it proves the guard short-circuits.
// (The happy path -- serving an existing allow-listed file -- is covered by
// the real HTTP integration test in test/server.test.ts. A hand-rolled
// Writable-stream double for `res` here would only re-implement Node's
// stream contract poorly; a real ServerResponse is the honest test double.)
const unusedRes = new Proxy(
  {},
  {
    get(): never {
      throw new Error('res should not be used when serveStaticFile rejects the request');
    },
  },
) as ServerResponse;

test('rejects extensions outside the allow-list without touching the filesystem or response', async () => {
  const served = await serveStaticFile(publicDir, '/css/base.css.map', unusedRes);
  assert.equal(served, false);
});

test('rejects a literal path-traversal attempt that escapes the public root', async () => {
  const served = await serveStaticFile(publicDir, '/../package.json', unusedRes);
  assert.equal(served, false);
});

test('rejects a deep traversal attempt through a nested prefix', async () => {
  const served = await serveStaticFile(publicDir, '/css/../../../etc/passwd.css', unusedRes);
  assert.equal(served, false);
});

test('rejects a request for a file that does not exist', async () => {
  const served = await serveStaticFile(publicDir, '/css/does-not-exist.css', unusedRes);
  assert.equal(served, false);
});
