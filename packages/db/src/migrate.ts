/**
 * Lightweight migration runner. Applies SQL files in lexical order from
 * the migrations/ directory and records them in a _migrations table.
 *
 * Idempotent: re-running skips already-applied files.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const rows = (await sql`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE name = ${file}
      `) as Array<{ count: number }>;
      const count = rows[0]?.count ?? 0;
      if (count > 0) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`[migrate] apply ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
    }
    console.log('[migrate] done');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
