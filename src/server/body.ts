/**
 * Reads and parses an `application/x-www-form-urlencoded` request body.
 *
 * Security: the body is size-capped (default 16 KB) and the stream is destroyed
 * the moment the cap is exceeded, so a malicious client cannot exhaust memory
 * with an unbounded upload. Values are parsed with the standard
 * URLSearchParams -- no eval, no unsafe deserialization (AGENTS.md).
 */
import type { IncomingMessage } from 'node:http';

const DEFAULT_MAX_BYTES = 16 * 1024;

/** Thrown when a request body exceeds the configured byte cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the permitted size');
    this.name = 'BodyTooLargeError';
  }
}

/** Collects the raw request body as a string, enforcing a hard byte cap. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Parses a urlencoded form body into a plain field map. The last value wins for
 * repeated keys, which is sufficient for the simple onboarding forms; nothing
 * here trusts the values -- callers validate every field before use.
 */
export async function readFormBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Record<string, string>> {
  const raw = await readRawBody(req, maxBytes);
  const params = new URLSearchParams(raw);
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    fields[key] = value;
  }
  return fields;
}
