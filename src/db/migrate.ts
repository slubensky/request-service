/**
 * Applies pending SQL migrations to the target database.
 *
 * Uses the node-postgres migrator against the generated `drizzle/` folder.
 * Intended for a deploy/release step (`npm run db:migrate`); the connection
 * string comes from DATABASE_URL (Secrets Manager) and is never hardcoded.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export async function migrateToLatest(
  connectionString: string,
  migrationsFolder = './drizzle',
): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
