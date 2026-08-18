/**
 * Reads and parses an `application/x-www-form-urlencoded` request body.
 *
 * Security: the body is size-capped (default 16 KB). Once the cap is exceeded,
 * further chunks are dropped instead of buffered, so a malicious client cannot
 * exhaust memory with an unbounded upload -- but the underlying socket is
 * deliberately left open (not `req.destroy()`ed) so the caller can still write
 * a clean 413 response. Destroying the request also destroys the socket the
 * response would be written on, turning the size cap into an unexplained
 * connection reset instead of an actionable error for the client. Values are
 * parsed with the standard URLSearchParams -- no eval, no unsafe
 * deserialization (AGENTS.md).
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
    let overLimit = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Bounded memory: stop buffering, but let the stream keep draining on
        // the same socket so the caller can still write a response (413) --
        // destroying the request here would destroy that socket too.
        if (!overLimit) {
          overLimit = true;
          reject(new BodyTooLargeError());
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overLimit) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!overLimit) {
        reject(error);
      }
    });
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
