import { defineConfig } from 'drizzle-kit';

// Only used by `pnpm db:generate` to produce SQL migrations from the schema.
// Migrations are applied by the application itself at startup (see src/db/client.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
