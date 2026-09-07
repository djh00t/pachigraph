import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pachigraph:migrations', 0))",
    );
    await client.query('CREATE SCHEMA IF NOT EXISTS pachigraph');
    await client.query(`
      CREATE TABLE IF NOT EXISTS pachigraph.schema_migrations (
        filename TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const directory = join(process.cwd(), 'db', 'migrations');
    const filenames = (await readdir(directory))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    for (const filename of filenames) {
      const sql = await readFile(join(directory, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM pachigraph.schema_migrations WHERE filename = $1',
        [filename],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].sha256 !== sha256) {
          throw new Error(`migration ${filename} changed after it was applied`);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO pachigraph.schema_migrations (filename, sha256) VALUES ($1, $2)',
        [filename, sha256],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
