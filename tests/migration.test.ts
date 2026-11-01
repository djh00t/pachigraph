import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';

import { migrate } from '../db/migrate.ts';
import { clearStorage, testPool } from './storage-support.ts';

const pool = testPool();
const TENANT_ID = /^t-[0-9a-f]{16}$/;
const THREAD = '018f47a8-4af3-7b83-bf0e-6f2b4e955c12';
const SOURCE = 'b'.repeat(64);
const REVISION = 'c'.repeat(64);

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function migrationSql() {
  return readFile(
    new URL('../db/migrations/0002_tenancy.sql', import.meta.url),
    'utf8',
  );
}

async function apply0001() {
  await pool.query('DROP SCHEMA IF EXISTS pachigraph CASCADE');
  await pool.query('CREATE SCHEMA pachigraph');
  const sql = await readFile(
    new URL('../db/migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  await pool.query(sql);
  await pool.query(`
    CREATE TABLE pachigraph.schema_migrations (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(
    'INSERT INTO pachigraph.schema_migrations (filename, sha256) VALUES ($1, $2)',
    ['0001_initial.sql', createHash('sha256').update(sql).digest('hex')],
  );
}

async function seedOwner(
  owner: string,
  options: { records?: number; tombstone?: boolean; key?: boolean } = {},
) {
  const records = options.records ?? 0;
  for (let index = 0; index < records; index += 1) {
    const textBytes = 40 + index;
    await pool.query(
      `INSERT INTO pachigraph.history_records
         (owner_id, thread_id, source_id, revision_id, id, source_timestamp,
          source_text, text_bytes, object_key, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        owner,
        THREAD,
        SOURCE,
        `${REVISION.slice(0, 62)}${index.toString(16).padStart(2, '0')}`,
        `legacy-${owner}-${index}`,
        '2026-01-02T03:04:05.000Z',
        `synthetic passage ${index}`,
        textBytes,
        `${sha256(owner)}/${THREAD}/${SOURCE}/rev-${index}`,
        '2026-01-02T03:04:05.000Z',
      ],
    );
  }
  if (options.tombstone) {
    await pool.query(
      `INSERT INTO pachigraph.thread_tombstones (owner_id, thread_id)
       VALUES ($1, $2)`,
      [owner, THREAD],
    );
  }
  if (options.key) {
    await pool.query(
      `INSERT INTO pachigraph.api_keys
         (id, owner_id, digest, scope, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'read', $3)`,
      [owner, sha256(`key-${owner}`), Date.now() + 86_400_000],
    );
  }
}

async function filenames() {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM pachigraph.schema_migrations ORDER BY filename',
  );
  return result.rows.map((row) => row.filename);
}

async function columnExists(table: string, column: string) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'pachigraph' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (result.rowCount ?? 0) > 0;
}

test('an empty database migrates and rejects a non-random tenant id', async () => {
  await pool.query('DROP SCHEMA IF EXISTS pachigraph CASCADE');
  await migrate(pool);
  assert.deepEqual(await filenames(), ['0001_initial.sql', '0002_tenancy.sql']);
  for (const table of [
    'tenants',
    'tenant_members',
    'tenant_usage',
    'pending_deletes',
  ]) {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'pachigraph' AND table_name = $1`,
      [table],
    );
    assert.equal(result.rowCount, 1, table);
  }
  await assert.rejects(
    pool.query(
      `INSERT INTO pachigraph.tenants (id, max_records, max_bytes)
       VALUES ('acct-A', 1, 1)`,
    ),
    /tenants_id_format|check constraint/i,
  );
  const sql = await migrationSql();
  assert.match(sql, /1000000/);
  assert.match(sql, /10737418240/);
  assert.ok(
    sql.indexOf('encode(sha256(convert_to(owner_id') <
      sql.indexOf('DROP COLUMN owner_id'),
    'pending_deletes seed must run before owner_id is dropped',
  );
});

test('two owners with data give two random tenants and a 1:1 binding', async () => {
  const first = await migratedOwners();
  const second = await migratedOwners();
  assert.notDeepEqual(
    [first.get('subject-a'), first.get('subject-b'), first.get('subject-key')],
    [
      second.get('subject-a'),
      second.get('subject-b'),
      second.get('subject-key'),
    ],
  );
  for (const ids of [first, second]) {
    const values = [...ids.values()];
    assert.equal(new Set(values).size, values.length);
    for (const id of values) assert.match(id, TENANT_ID);
    for (const [subject, id] of ids) {
      assert.notEqual(id, `t-${sha256(subject).slice(0, 16)}`);
    }
  }
  const members = await pool.query<{ tenant_id: string; subjects: string }>(
    `SELECT tenant_id, count(*)::text AS subjects
     FROM pachigraph.tenant_members GROUP BY tenant_id`,
  );
  assert.ok(members.rows.every((row) => row.subjects === '1'));
  assert.equal(members.rowCount, 3);
});

test('every record, tombstone and key receives its owner tenant', async () => {
  await migratedOwners();
  const records = await pool.query<{ id: string; subject: string }>(`
    SELECT r.id, m.subject
    FROM pachigraph.history_records r
    JOIN pachigraph.tenant_members m ON m.tenant_id = r.tenant_id
  `);
  assert.equal(records.rowCount, 3);
  for (const row of records.rows) {
    assert.ok(row.id.startsWith(`legacy-${row.subject}-`), row.id);
  }
  const keys = await pool.query<{
    owner_id: string;
    digest: string;
    same: boolean;
  }>(`
    SELECT k.owner_id, k.digest, k.tenant_id = m.tenant_id AS same
    FROM pachigraph.api_keys k
    JOIN pachigraph.tenant_members m ON m.subject = k.owner_id
  `);
  assert.equal(keys.rowCount, 2);
  for (const row of keys.rows) {
    assert.equal(row.same, true);
    assert.equal(row.digest, sha256(`key-${row.owner_id}`));
  }
  const tombstones = await pool.query<{ subject: string; prefix: string }>(`
    SELECT m.subject, p.prefix
    FROM pachigraph.thread_tombstones s
    JOIN pachigraph.tenant_members m ON m.tenant_id = s.tenant_id
    JOIN pachigraph.pending_deletes p
      ON p.tenant_id = s.tenant_id AND p.thread_id = s.thread_id
  `);
  assert.equal(tombstones.rowCount, 2);
  for (const row of tombstones.rows) {
    assert.equal(row.prefix, `${sha256(row.subject)}/${THREAD}/`);
  }
  const keyOnly = await pool.query(
    `SELECT 1 FROM pachigraph.tenant_members WHERE subject = 'subject-key'`,
  );
  assert.equal(keyOnly.rowCount, 1);
});

test('legacy stored_bytes, usage and pending delete prefixes match the seed', async () => {
  await migratedOwners();
  const bytes = await pool.query<{ stored_bytes: string; text_bytes: string }>(
    `SELECT stored_bytes::text, text_bytes::text FROM pachigraph.history_records`,
  );
  assert.ok(bytes.rows.length > 0);
  assert.ok(bytes.rows.every((row) => row.stored_bytes === row.text_bytes));
  const usage = await pool.query<{
    subject: string;
    records: string;
    bytes: string;
    expected_records: string;
    expected_bytes: string;
  }>(`
    SELECT m.subject,
           u.records::text,
           u.bytes::text,
           COALESCE(c.records, 0)::text AS expected_records,
           COALESCE(c.bytes, 0)::text AS expected_bytes
    FROM pachigraph.tenant_usage u
    JOIN pachigraph.tenant_members m ON m.tenant_id = u.tenant_id
    LEFT JOIN (
      SELECT tenant_id, count(*) AS records, sum(stored_bytes) AS bytes
      FROM pachigraph.history_records GROUP BY tenant_id
    ) c ON c.tenant_id = u.tenant_id
  `);
  assert.equal(usage.rowCount, 3);
  for (const row of usage.rows) {
    assert.equal(row.records, row.expected_records, row.subject);
    assert.equal(row.bytes, row.expected_bytes, row.subject);
  }
  const pending = await pool.query<{
    subject: string;
    thread_id: string;
    prefix: string;
  }>(`
    SELECT m.subject, p.thread_id, p.prefix
    FROM pachigraph.pending_deletes p
    JOIN pachigraph.tenant_members m ON m.tenant_id = p.tenant_id
    ORDER BY m.subject
  `);
  assert.deepEqual(
    pending.rows.map((row) => row.prefix),
    ['subject-a', 'subject-b'].map(
      (subject) => `${sha256(subject)}/${THREAD}/`,
    ),
  );
  assert.ok(pending.rows.every((row) => row.thread_id === THREAD));
});

test('constraints are tenant scoped and legacy ids and object keys survive', async () => {
  await migratedOwners();
  assert.equal(await columnExists('history_records', 'owner_id'), false);
  assert.equal(await columnExists('thread_tombstones', 'owner_id'), false);
  assert.equal(await columnExists('api_keys', 'owner_id'), true);
  const kept = await pool.query<{ id: string; object_key: string }>(
    `SELECT id, object_key FROM pachigraph.history_records
     WHERE id = 'legacy-subject-a-0'`,
  );
  assert.equal(kept.rows[0].id, 'legacy-subject-a-0');
  assert.equal(
    kept.rows[0].object_key,
    `${sha256('subject-a')}/${THREAD}/${SOURCE}/rev-0`,
  );
  const tenants = await pool.query<{ subject: string; tenant_id: string }>(
    `SELECT subject, tenant_id FROM pachigraph.tenant_members
     WHERE subject IN ('subject-a', 'subject-b') ORDER BY subject`,
  );
  for (const tenant of tenants.rows) {
    await pool.query(
      `INSERT INTO pachigraph.history_records
         (tenant_id, thread_id, source_id, revision_id, id, source_timestamp,
          source_text, text_bytes, stored_bytes, object_key, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'synthetic', 9, 9, 't/key', $6)`,
      [
        tenant.tenant_id,
        THREAD,
        'd'.repeat(64),
        'e'.repeat(64),
        `shared-${tenant.subject}`,
        '2026-01-02T03:04:05.000Z',
      ],
    );
  }
  const shared = await pool.query(
    `SELECT count(*)::int AS count FROM pachigraph.history_records
     WHERE source_id = $1`,
    ['d'.repeat(64)],
  );
  assert.equal(shared.rows[0].count, 2);
  const indexes = await pool.query<{ indexdef: string; indexname: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'pachigraph'
       AND tablename IN ('history_records', 'api_keys', 'thread_tombstones')`,
  );
  const defs = indexes.rows.map((row) => `${row.indexname} ${row.indexdef}`);
  assert.ok(defs.some((def) => def.includes('(tenant_id, thread_id)')));
  assert.ok(
    defs.some((def) => def.includes('api_keys') && def.includes('tenant_id')),
  );
  assert.equal(
    defs.some((def) => def.includes('api_keys_owner_expires')),
    false,
  );
  const tombstone = await pool.query<{ definition: string }>(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'pachigraph.thread_tombstones'::regclass AND contype = 'p'
  `);
  assert.match(tombstone.rows[0].definition, /tenant_id/);
  assert.doesNotMatch(tombstone.rows[0].definition, /owner_id/);
});

test('a forced failure leaves the database at 0001', async () => {
  await apply0001();
  await seedOwner('subject-a', { records: 1 });
  await pool.query('CREATE TABLE pachigraph.tenants (blocker integer)');
  try {
    await assert.rejects(migrate(pool));
    assert.deepEqual(await filenames(), ['0001_initial.sql']);
    assert.equal(await columnExists('history_records', 'owner_id'), true);
  } finally {
    await pool.query('DROP TABLE IF EXISTS pachigraph.tenants');
  }
});

test('an allowlisted subject with no data stays unbound', async () => {
  await apply0001();
  await seedOwner('subject-a', { records: 1 });
  await migrate(pool);
  const unbound = await pool.query(
    `SELECT 1 FROM pachigraph.tenant_members WHERE subject = 'subject-allowlisted'`,
  );
  assert.equal(unbound.rowCount, 0);
  await clearStorage(pool);
  const left = await pool.query(
    'SELECT count(*)::int AS count FROM pachigraph.tenants',
  );
  assert.equal(left.rows[0].count, 0);
});

async function migratedOwners() {
  await apply0001();
  await seedOwner('subject-a', { records: 2, tombstone: true, key: true });
  await seedOwner('subject-b', { records: 1, tombstone: true });
  await seedOwner('subject-key', { key: true });
  await migrate(pool);
  const result = await pool.query<{ subject: string; tenant_id: string }>(
    'SELECT subject, tenant_id FROM pachigraph.tenant_members ORDER BY subject',
  );
  return new Map(result.rows.map((row) => [row.subject, row.tenant_id]));
}

after(async () => {
  await pool.query('DROP SCHEMA IF EXISTS pachigraph CASCADE');
  await migrate(pool);
  await pool.end();
});
