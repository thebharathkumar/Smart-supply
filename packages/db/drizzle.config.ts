import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/smartsupply',
  },
} satisfies Config;
