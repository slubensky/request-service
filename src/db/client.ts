/**
 * Database client wiring for Drizzle over PostgreSQL.
 *
 * Production uses node-postgres against the RDS/Aurora instance; the connection
 * string arrives via DATABASE_URL from Secrets Manager (never hardcoded). Tests
 * use an in-process PGlite instance so the suite runs in CI with no external
 * database and no credentials (see test/db.test.ts).
 *
 * `AppDatabase` is the driver-agnostic type every data-access function accepts,
 * so the same query code runs against node-postgres and PGlite.
 */
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PgConnection {
  db: AppDatabase;
  pool: Pool;
}

/** Opens a pooled node-postgres connection and binds the Drizzle schema. */
export function createPgConnection(connectionString: string): PgConnection {
  const pool = new Pool({ connectionString });
  const db = drizzleNodePg(pool, { schema }) as unknown as AppDatabase;
  return { db, pool };
}
