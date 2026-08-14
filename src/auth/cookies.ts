/**
 * Minimal, dependency-free HTTP cookie helpers.
 *
 * Parsing tolerates the standard `name=value; name2=value2` request header
 * format. Serialization always emits secure-by-default attributes for session
 * cookies (HttpOnly, Secure, SameSite) -- see `serializeCookie`.
 */

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  path?: string;
  /** Max age in seconds. Omit for a session cookie. */
  maxAge?: number;
}

/** Parses a `Cookie` request header into a name->value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) {
      continue;
    }
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Serializes a single `Set-Cookie` value with the given attributes. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.httpOnly ?? true) {
    segments.push('HttpOnly');
  }
  if (options.secure ?? true) {
    segments.push('Secure');
  }
  segments.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return segments.join('; ');
}

/** Serializes an expired cookie that clears `name` on the client. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}
