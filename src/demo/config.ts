/**
 * DEMO_MODE flag (SDD §6.3).
 *
 * The entire demo invitation-code acceptance flow is gated behind this single
 * environment flag. When it is off (the production default) no code is minted or
 * shown and the accept routes are never registered -- the feature is inert. The
 * check reads `process.env` live (via `getEnv`) so tests can flip it per case.
 */
import { getEnv } from '../config/env.js';

// Accept the usual truthy spellings; anything else (including unset) is off.
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/** True only when DEMO_MODE is explicitly set to a recognized truthy value. */
export function isDemoMode(): boolean {
  const value = getEnv('DEMO_MODE');
  return value !== undefined && TRUTHY.has(value.toLowerCase());
}
