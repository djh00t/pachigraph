import { Pool } from 'pg';

const name = process.env.PACHIGRAPH_TEST_DATABASE_NAME ?? '';
const url = process.env.PACHIGRAPH_TEST_DATABASE_URL ?? '';

if (!/^pachigraph_test_(?:[a-f0-9]{32}|ci)$/.test(name)) {
  throw new Error('refusing to use a non-test PostgreSQL database');
}
if (!url || new URL(url).pathname !== `/${name}`) {
  throw new Error(
    'test database URL does not match the isolated test database',
  );
}

export function testPool() {
  return new Pool({ connectionString: url, max: 2 });
}

export async function clearStorage(pool: Pool) {
  await pool.query(
    'TRUNCATE pachigraph.history_records, pachigraph.thread_tombstones, pachigraph.api_keys',
  );
}
