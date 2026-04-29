import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    prepare: false,
  });
  return drizzle(client, { schema });
}

export { schema };
export * from './schema.js';
