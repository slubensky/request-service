import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for generating SQL migrations from the schema.
 *
 * Generation is a pure schema->SQL diff and needs no database connection or
 * credentials (`npm run db:generate`). Migrations are applied at runtime via
 * the driver migrator; tests apply them against an in-process PGlite instance.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
