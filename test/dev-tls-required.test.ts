/**
 * `src/index.ts` refuses to start over plain HTTP in local development (no
 * `NODE_ENV=production`) unless `TLS_CERT_FILE`/`TLS_KEY_FILE` are both set -- cookies are
 * unconditionally `Secure` (SDD §12), which a non-Chromium browser silently drops without
 * real TLS (SDD changelog #014). Drives the actual entry point as a child process since the
 * fail-closed check runs at module load, before any exported function is reachable from an
 * in-process test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..');
const tsxBin = path.join(rootDir, 'node_modules/.bin/tsx');
const indexEntry = path.join(rootDir, 'src/index.ts');
const certFile = path.join(rootDir, 'test/fixtures/tls/test-cert.pem');
const keyFile = path.join(rootDir, 'test/fixtures/tls/test-key.pem');

type Outcome =
  { kind: 'exited'; code: number | null; stderr: string } | { kind: 'listening'; stdout: string };

/** Races the child exiting (the fail-closed path) against it printing its startup log (the
 * success path), since a successfully started server never exits on its own. */
async function runIndex(env: Record<string, string | undefined>): Promise<Outcome> {
  const childEnv: Record<string, string> = { ...process.env, PORT: '0' };
  delete childEnv.NODE_ENV;
  delete childEnv.TLS_CERT_FILE;
  delete childEnv.TLS_KEY_FILE;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const child = spawn(tsxBin, [indexEntry], {
    cwd: rootDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    return await new Promise<Outcome>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve({ kind: 'exited', code, stderr }));
      const poll = setInterval(() => {
        if (/listening on/.test(stdout)) {
          clearInterval(poll);
          resolve({ kind: 'listening', stdout });
        }
      }, 20);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for exit or startup log. stderr:\n${stderr}`));
      }, 3000).unref();
    });
  } finally {
    if (!child.killed) {
      child.kill();
    }
  }
}

test('refuses to start over plain HTTP in dev when TLS_CERT_FILE/TLS_KEY_FILE are unset', async () => {
  const outcome = await runIndex({
    NODE_ENV: undefined,
    TLS_CERT_FILE: undefined,
    TLS_KEY_FILE: undefined,
  });
  assert.equal(outcome.kind, 'exited');
  assert.equal((outcome as { code: number | null }).code, 1);
  assert.match((outcome as { stderr: string }).stderr, /Refusing to start over plain HTTP/);
});

test('starts over HTTPS in dev when TLS_CERT_FILE/TLS_KEY_FILE are both set', async () => {
  const outcome = await runIndex({
    NODE_ENV: undefined,
    TLS_CERT_FILE: certFile,
    TLS_KEY_FILE: keyFile,
  });
  assert.equal(outcome.kind, 'listening');
  assert.match((outcome as { stdout: string }).stdout, /listening on https:/);
});

test('skips the check in production even without TLS_CERT_FILE/TLS_KEY_FILE', async () => {
  const outcome = await runIndex({
    NODE_ENV: 'production',
    TLS_CERT_FILE: undefined,
    TLS_KEY_FILE: undefined,
  });
  assert.equal(outcome.kind, 'listening');
  assert.match((outcome as { stdout: string }).stdout, /listening on http:/);
});
