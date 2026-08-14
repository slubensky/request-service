/**
 * Deploy-step migration runner. Applies pending migrations to DATABASE_URL
 * (injected from Secrets Manager). Not part of the built server image -- run via
 * `npm run db:migrate` during release.
 */
import { requireEnv } from '../src/config/env.js';
import { migrateToLatest } from '../src/db/migrate.js';

await migrateToLatest(requireEnv('DATABASE_URL'));
