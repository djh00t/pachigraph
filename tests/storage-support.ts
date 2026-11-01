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

export async function seedTenant(
  pool: Pool,
  tenant: string,
  subject: string,
  options: { active?: boolean; maxRecords?: number; maxBytes?: number } = {},
) {
  await pool.query(
    `INSERT INTO pachigraph.tenants (id, active, max_records, max_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET active = EXCLUDED.active,
           max_records = EXCLUDED.max_records,
           max_bytes = EXCLUDED.max_bytes`,
    [
      tenant,
      options.active ?? true,
      options.maxRecords ?? 1_000_000,
      options.maxBytes ?? 10 * 1024 * 1024 * 1024,
    ],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id)
     VALUES ($1, $2)
     ON CONFLICT (subject) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
    [subject, tenant],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_usage (tenant_id, records, bytes)
     VALUES ($1, 0, 0)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant],
  );
}

export async function clearStorage(pool: Pool) {
  await pool.query(`TRUNCATE
    pachigraph.pending_deletes,
    pachigraph.history_records,
    pachigraph.thread_tombstones,
    pachigraph.api_keys,
    pachigraph.tenant_members,
    pachigraph.tenant_usage,
    pachigraph.tenants`);
}
