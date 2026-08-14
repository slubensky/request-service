import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serves a single static file from `rootDir` for the given URL pathname.
 *
 * Security: resolves the requested path and rejects anything that escapes
 * `rootDir` (path traversal via `..`, absolute paths, or symlink tricks that
 * resolve outside the root) before ever touching the filesystem. Only
 * extensions in the allow-list above are served; everything else 404s.
 */
export async function serveStaticFile(
  rootDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  const ext = path.extname(pathname);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return false;
  }

  const resolvedRoot = path.resolve(rootDir);
  const requestedPath = path.resolve(resolvedRoot, `.${pathname}`);

  const isWithinRoot =
    requestedPath === resolvedRoot || requestedPath.startsWith(resolvedRoot + path.sep);
  if (!isWithinRoot) {
    return false;
  }

  let size: number;
  try {
    const stats = await stat(requestedPath);
    if (!stats.isFile()) {
      return false;
    }
    size = stats.size;
  } catch {
    return false;
  }

  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(size) });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(requestedPath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}
