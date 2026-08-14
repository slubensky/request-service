/**
 * Minimal HTTP text response helper shared by every route module.
 */
import type { ServerResponse } from 'node:http';

/** Writes a plain-text response body with the given status. */
export function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}
