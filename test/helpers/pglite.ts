/**
 * In-process PGlite database for tests: applies the generated migrations to a
 * fresh WASM Postgres instance so the suite runs in CI with no external
 * database and no credentials. Returns the Drizzle handle plus the raw client
 * for teardown.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { AppDatabase } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';

export interface TestDatabase {
  db: AppDatabase;
  client: PGlite;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return { db: db as unknown as AppDatabase, client };
}
