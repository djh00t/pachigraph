import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const TENANT_ID = /^t-[0-9a-f]{16}$/;
const DEFAULT_MAX_RECORDS = 1_000_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function usage(): never {
  fail(
    'usage: node scripts/tenant.ts <create|list|quota|deactivate|bind|rebind|unbind> [args]',
  );
}

async function withTransaction(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await operation(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function create(pool: Pool, args: string[]) {
  if (args.length !== 0) fail('create does not accept an id');
  const id = `t-${randomBytes(8).toString('hex')}`;
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO pachigraph.tenants (id, max_records, max_bytes)
       VALUES ($1, $2, $3)`,
      [id, DEFAULT_MAX_RECORDS, DEFAULT_MAX_BYTES],
    );
    await client.query(
      `INSERT INTO pachigraph.tenant_usage (tenant_id, records, bytes)
       VALUES ($1, 0, 0)`,
      [id],
    );
  });
  console.log(id);
}

async function list(pool: Pool, args: string[]) {
  const showSubjects = args.includes('--subjects');
  if (args.some((arg) => arg !== '--subjects')) usage();
  const result = await pool.query<{
    id: string;
    active: boolean;
    members: string;
    records: string;
    bytes: string;
    max_records: string;
    max_bytes: string;
    subjects: string | null;
  }>(`
    SELECT t.id, t.active,
           (SELECT count(*) FROM pachigraph.tenant_members m
             WHERE m.tenant_id = t.id)::text AS members,
           COALESCE(u.records, 0)::text AS records,
           COALESCE(u.bytes, 0)::text AS bytes,
           t.max_records::text,
           t.max_bytes::text,
           (SELECT string_agg(m.subject, ',' ORDER BY m.subject)
             FROM pachigraph.tenant_members m
             WHERE m.tenant_id = t.id) AS subjects
    FROM pachigraph.tenants t
    LEFT JOIN pachigraph.tenant_usage u ON u.tenant_id = t.id
    ORDER BY t.id
  `);
  for (const row of result.rows) {
    const fields = [
      row.id,
      `active=${row.active}`,
      `members=${row.members}`,
      `records=${row.records}`,
      `bytes=${row.bytes}`,
      `max_records=${row.max_records}`,
      `max_bytes=${row.max_bytes}`,
    ];
    if (showSubjects) fields.push(`subjects=${row.subjects ?? ''}`);
    console.log(fields.join('\t'));
  }
}

async function requireTenant(pool: Pool, id: string) {
  if (!TENANT_ID.test(id)) fail('tenant id is invalid');
  const result = await pool.query(
    'SELECT 1 FROM pachigraph.tenants WHERE id = $1',
    [id],
  );
  if (!result.rowCount) fail('tenant not found');
}

async function quota(pool: Pool, args: string[]) {
  if (args.length !== 3) usage();
  const [id, recordsText, bytesText] = args;
  await requireTenant(pool, id);
  if (!/^\d+$/.test(recordsText) || !/^\d+$/.test(bytesText))
    fail('quota values must be non-negative integers');
  const maxRecords = Number(recordsText);
  const maxBytes = Number(bytesText);
  if (!Number.isSafeInteger(maxRecords) || !Number.isSafeInteger(maxBytes))
    fail('quota values must be non-negative integers');
  await pool.query(
    `UPDATE pachigraph.tenants SET max_records = $2, max_bytes = $3 WHERE id = $1`,
    [id, maxRecords, maxBytes],
  );
  console.log(`${id}\tmax_records=${maxRecords}\tmax_bytes=${maxBytes}`);
}

async function deactivate(pool: Pool, args: string[]) {
  if (args.length !== 1) usage();
  await requireTenant(pool, args[0]);
  await pool.query(
    'UPDATE pachigraph.tenants SET active = false WHERE id = $1',
    [args[0]],
  );
  console.log(`${args[0]}\tactive=false`);
}

async function bind(pool: Pool, args: string[]) {
  if (args.length !== 2) usage();
  const [subject, tenant] = args;
  if (!subject.trim()) fail('subject is required');
  await requireTenant(pool, tenant);
  const existing = await pool.query(
    'SELECT 1 FROM pachigraph.tenant_members WHERE subject = $1',
    [subject],
  );
  if (existing.rowCount) fail('subject is already bound; use rebind');
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id)
     VALUES ($1, $2)`,
    [subject, tenant],
  );
  console.log(`${subject}\t${tenant}`);
}

async function rebind(pool: Pool, args: string[]) {
  if (args.length !== 2) usage();
  const [subject, tenant] = args;
  if (!subject.trim()) fail('subject is required');
  await requireTenant(pool, tenant);
  const existing = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM pachigraph.tenant_members WHERE subject = $1',
    [subject],
  );
  const current = existing.rows[0]?.tenant_id;
  if (!current) fail('subject is not bound');
  if (current === tenant) fail('subject is already bound to that tenant');
  await pool.query(
    'UPDATE pachigraph.tenant_members SET tenant_id = $2 WHERE subject = $1',
    [subject, tenant],
  );
  console.log(`${subject}\t${tenant}`);
}

async function unbind(pool: Pool, args: string[]) {
  if (args.length !== 1) usage();
  const subject = args[0];
  let removed = false;
  await withTransaction(pool, async (client) => {
    const member = await client.query(
      'SELECT 1 FROM pachigraph.tenant_members WHERE subject = $1 FOR UPDATE',
      [subject],
    );
    if (!member.rowCount) return;
    await client.query('DELETE FROM pachigraph.api_keys WHERE owner_id = $1', [
      subject,
    ]);
    const result = await client.query(
      'DELETE FROM pachigraph.tenant_members WHERE subject = $1',
      [subject],
    );
    removed = (result.rowCount ?? 0) > 0;
  });
  if (!removed) fail('subject is not bound');
  console.log(`${subject}\tunbound`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (command === 'create') await create(pool, args);
    else if (command === 'list') await list(pool, args);
    else if (command === 'quota') await quota(pool, args);
    else if (command === 'deactivate') await deactivate(pool, args);
    else if (command === 'bind') await bind(pool, args);
    else if (command === 'rebind') await rebind(pool, args);
    else if (command === 'unbind') await unbind(pool, args);
    else usage();
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'command failed');
  process.exit(1);
});
