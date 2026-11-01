import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import { resolveTenant, type TenantId } from '../server/auth.ts';
import { createHistory } from '../server/history.ts';
import { clearStorage, seedTenant, testPool } from './storage-support.ts';

class MemoryObjects {
  readonly objects = new Map<string, string>();
  failNextPut = false;
  failNextDelete = false;

  async putImmutable(key: string, value: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected object failure');
    }
    if (!this.objects.has(key)) this.objects.set(key, value);
  }

  async getText(key: string) {
    return this.objects.get(key) ?? null;
  }

  async deletePrefix(prefix: string) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('injected cleanup failure');
    }
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

const pool = testPool();
const TENANT_A = 't-aaaaaaaaaaaaaaaa';
const TENANT_B = 't-bbbbbbbbbbbbbbbb';
const THREAD = '018f47a8-4af3-7b83-bf0e-6f2b4e955c12';
const SOURCE = 'a'.repeat(64);
let tenantA: TenantId;
let tenantB: TenantId;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function input(
  text = 'The quick brown fox remembers orbital passage.',
  record: object = { z: 2, a: 1 },
) {
  return {
    thread_id: THREAD,
    records: [
      { id: SOURCE, timestamp: '2026-09-05T01:02:03.000Z', text, record },
    ],
  };
}

function setup() {
  const objects = new MemoryObjects();
  return { objects, history: createHistory(pool, objects) };
}

before(async () => {
  let migration: typeof import('../db/migrate.ts');
  try {
    migration = await import('../db/migrate.ts');
  } catch (error) {
    assert.fail(`migration module must exist: ${String(error)}`);
  }
  await migration.migrate(pool);
});
beforeEach(async () => {
  await clearStorage(pool);
  await seedTenant(pool, TENANT_A, 'subject-a');
  await seedTenant(pool, TENANT_B, 'subject-b');
  const resolvedA = await resolveTenant(pool, 'subject-a');
  const resolvedB = await resolveTenant(pool, 'subject-b');
  if (!resolvedA || !resolvedB) throw new Error('tenant binding missing');
  tenantA = resolvedA;
  tenantB = resolvedB;
});
after(async () => pool.end());

test('migration is repeatable and rejects changed applied SQL', async () => {
  const { migrate } = await import('../db/migrate.ts');
  await migrate(pool);
  const result = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM pachigraph.schema_migrations',
  );
  assert.deepEqual(result.rows.map((row) => row.filename).sort(), [
    '0001_initial.sql',
    '0002_tenancy.sql',
  ]);
  const original = result.rows.find(
    (row) => row.filename === '0001_initial.sql',
  )?.sha256;
  assert.ok(original);
  await pool.query(
    "UPDATE pachigraph.schema_migrations SET sha256 = repeat('0', 64) WHERE filename = '0001_initial.sql'",
  );
  await assert.rejects(migrate(pool), /changed after it was applied/);
  await pool.query(
    'UPDATE pachigraph.schema_migrations SET sha256 = $1 WHERE filename = $2',
    [original, '0001_initial.sql'],
  );
});

test('duplicate replay stores one immutable revision', async () => {
  const { history, objects } = setup();
  assert.deepEqual(await history.ingest(tenantA, input()), {
    stored: 1,
    duplicate: 0,
  });
  assert.deepEqual(await history.ingest(tenantA, input()), {
    stored: 0,
    duplicate: 1,
  });
  assert.equal(objects.objects.size, 1);
  assert.equal((await history.status(tenantA)).records, 1);
});

test('changed and backfilled source events append deterministic revisions', async () => {
  const { history, objects } = setup();
  await history.ingest(tenantA, input('newer', { b: 2, a: 1 }));
  assert.equal([...objects.objects.values()][0], '{"a":1,"b":2}');
  await history.ingest(tenantA, input('older', { original: true }));
  assert.deepEqual(
    await history.ingest(tenantA, input('newer', { a: 1, b: 2 })),
    { stored: 0, duplicate: 1 },
  );
  assert.equal((await history.status(tenantA)).records, 2);
});

test('object and database failures remain retryable', async () => {
  const { history, objects } = setup();
  objects.failNextPut = true;
  await assert.rejects(history.ingest(tenantA, input()), /injected object/);
  assert.equal((await history.status(tenantA)).records, 0);

  await pool.query(`
    CREATE FUNCTION pachigraph.reject_history_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$;
    CREATE TRIGGER reject_history_insert BEFORE INSERT ON pachigraph.history_records
    FOR EACH ROW EXECUTE FUNCTION pachigraph.reject_history_insert()
  `);
  await assert.rejects(history.ingest(tenantA, input()), /injected database/);
  assert.equal(objects.objects.size, 1);
  assert.equal((await history.status(tenantA)).records, 0);
  await pool.query(`
    DROP TRIGGER reject_history_insert ON pachigraph.history_records;
    DROP FUNCTION pachigraph.reject_history_insert()
  `);
  assert.deepEqual(await history.ingest(tenantA, input()), {
    stored: 1,
    duplicate: 0,
  });
});

test('deletion commits its tombstone before retryable object cleanup', async () => {
  const { history, objects } = setup();
  await history.ingest(tenantA, input());
  objects.failNextDelete = true;
  await assert.rejects(history.deleteThread(tenantA, THREAD), /cleanup/);
  await assert.rejects(history.ingest(tenantA, input()), { status: 410 });
  assert.equal(
    Number(
      (
        await pool.query(
          'SELECT count(*) AS count FROM pachigraph.thread_tombstones',
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.deepEqual(await history.deleteThread(tenantA, THREAD), {
    deleted: true,
  });
  assert.equal(objects.objects.size, 0);
});

test('fetch, search, and deletion remain tenant scoped', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
  await history.ingest(tenantA, input());
  await history.ingest(tenantB, input('tenant beta token xylophone'));
  const result = (await history.search(tenantA, 'orbital passage')).results[0];
  assert.equal(
    (await history.fetch(tenantA, result.id)).text,
    input().records[0].text,
  );
  const missing = await history
    .fetch(tenantA, 'f'.repeat(64))
    .then(() => null)
    .catch((error: { status?: number; message?: string }) => error);
  const foreign = await history
    .fetch(tenantB, result.id)
    .then(() => null)
    .catch((error: { status?: number; message?: string }) => error);
  assert.equal(foreign?.status, 404);
  assert.equal(foreign?.status, missing?.status);
  assert.equal(foreign?.message, missing?.message);
  assert.equal((await history.search(tenantA, 'xylophone')).results.length, 0);
  assert.equal((await history.status(tenantA)).records, 1);
  assert.equal((await history.status(tenantB)).records, 1);
  await history.deleteThread(tenantA, THREAD);
  assert.equal((await history.search(tenantA, 'orbital')).results.length, 0);
  assert.equal((await history.search(tenantB, 'xylophone')).results.length, 1);
  await assert.rejects(history.ingest(tenantA, input()), { status: 410 });
  assert.deepEqual(
    await history.ingest(tenantB, input('another beta revision')),
    {
      stored: 1,
      duplicate: 0,
    },
  );
});

test('concurrent delete and ingest cannot replay a tombstoned thread', async () => {
  const { history, objects } = setup();
  const outcomes = await Promise.allSettled([
    history.ingest(tenantA, input()),
    history.deleteThread(tenantA, THREAD),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  await assert.rejects(history.ingest(tenantA, input()), { status: 410 });
  assert.equal((await history.status(tenantA)).records, 0);
  assert.equal(objects.objects.size, 0);
});

test('PostgreSQL FTS returns plain snippets and source citations', async () => {
  const { history } = setup();
  await history.ingest(tenantA, input('Needle phrase: alpha-beta (gamma).'));
  const { results } = await history.search(tenantA, 'alpha-beta gamma');
  assert.equal(results.length, 1);
  assert.equal(results[0].text.includes('<b>'), false);
  assert.equal(
    results[0].citation,
    `Codex thread ${THREAD}, event ${SOURCE}, 2026-09-05T01:02:03.000Z; /?id=${results[0].id}; codex://threads/${THREAD}#${SOURCE}`,
  );
});

test('status preserves UTF-8 byte counts and reports physical allocation', async () => {
  const { history } = setup();
  await history.ingest(tenantA, input('hello 🌏'));
  const status = await history.status(tenantA);
  assert.equal(status.records, 1);
  assert.equal(status.text_bytes, Buffer.byteLength('hello 🌏'));
  assert.match(status.last_ingested_at!, /^\d{4}-\d{2}-\d{2}T/);
  const { databaseAllocation } = await import('../server/history.ts');
  assert.ok((await databaseAllocation(pool)).database_bytes > 0);
});

test('bounds batch, search, timestamp and record size input before writes', async () => {
  const { history, objects } = setup();
  await assert.rejects(
    history.ingest(tenantA, {
      thread_id: THREAD,
      records: Array(101).fill(input().records[0]),
    }),
    /100/,
  );
  await assert.rejects(history.search(tenantA, 'x'.repeat(257)), /256/);
  await assert.rejects(
    history.ingest(tenantA, {
      thread_id: THREAD,
      records: [{ ...input().records[0], timestamp: 'September 5, 2026' }],
    }),
    /timestamp/,
  );
  await assert.rejects(
    history.ingest(tenantA, input('x'.repeat(384 * 1024))),
    /384 KiB/,
  );
  assert.equal(objects.objects.size, 0);
});

test('rejects malformed/deep records and accepts depth 64', async () => {
  const { history, objects } = setup();
  await assert.rejects(history.ingest(tenantA, null), { status: 400 });
  await assert.rejects(
    history.ingest(tenantA, { thread_id: THREAD, records: [null] }),
    { status: 400 },
  );
  let record: Record<string, unknown> = { value: 'boundary' };
  for (let depth = 1; depth < 64; depth += 1) record = { child: record };
  const sample = input('boundary depth', record);
  assert.deepEqual(await history.ingest(tenantA, sample), {
    stored: 1,
    duplicate: 0,
  });
  const found = (await history.search(tenantA, 'boundary')).results[0];
  assert.deepEqual((await history.fetch(tenantA, found.id)).record, record);
  await assert.rejects(
    history.ingest(tenantA, input('too deep', { child: record })),
    { status: 400 },
  );
  assert.equal(objects.objects.size, 1);
});

test('new rows use the tenant id, tenant object key and envelope size', async () => {
  const { history, objects } = setup();
  const sample = input();
  assert.deepEqual(await history.ingest(tenantA, sample), {
    stored: 1,
    duplicate: 0,
  });
  const key = [...objects.objects.keys()][0];
  const revision = key.split('/').at(-1);
  assert.equal(key, `t/${sha256(TENANT_A)}/${THREAD}/${SOURCE}/${revision}`);
  const row = await pool.query<{
    id: string;
    stored_bytes: string;
    text_bytes: string;
  }>(
    'SELECT id, stored_bytes::text, text_bytes::text FROM pachigraph.history_records',
  );
  assert.equal(
    row.rows[0].id,
    sha256(`${TENANT_A}\n${THREAD}\n${SOURCE}\n${revision}`),
  );
  const envelope = `{"id":${JSON.stringify(SOURCE)},"record":{"a":1,"z":2},"text":${JSON.stringify(sample.records[0].text)},"timestamp":"2026-09-05T01:02:03.000Z"}`;
  assert.equal(Number(row.rows[0].stored_bytes), Buffer.byteLength(envelope));
  assert.notEqual(row.rows[0].stored_bytes, row.rows[0].text_bytes);
});

test('quarantine fingerprints round-trip inside the stored record', async () => {
  const { history, objects } = setup();
  const fingerprint = '0123456789abcdef0123456789abcdef';
  const record = {
    visibility: 'visible',
    redactions: [{ rule: 'generic-api-key', path: '/text#0', fp: fingerprint }],
  };
  await history.ingest(tenantA, input('synthetic redacted passage', record));
  const found = (await history.search(tenantA, 'redacted')).results[0];
  const fetched = await history.fetch(tenantA, found.id);
  assert.deepEqual(fetched.record, {
    redactions: record.redactions,
    visibility: 'visible',
  });
  assert.equal([...objects.objects.values()][0].includes(fingerprint), true);
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'pachigraph' AND table_name LIKE '%quarantine%'`,
  );
  assert.equal(tables.rowCount, 0);
});

test('a legacy object key stays fetchable and a resend is a duplicate', async () => {
  const { history, objects } = setup();
  await history.ingest(tenantA, input());
  const current = [...objects.objects.entries()][0];
  const legacyKey = `${sha256('subject-a')}/${THREAD}/${SOURCE}/legacy`;
  await pool.query(
    'UPDATE pachigraph.history_records SET object_key = $1 WHERE tenant_id = $2',
    [legacyKey, TENANT_A],
  );
  objects.objects.set(legacyKey, current[1]);
  objects.objects.delete(current[0]);
  const row = await pool.query<{ id: string }>(
    'SELECT id FROM pachigraph.history_records WHERE tenant_id = $1',
    [TENANT_A],
  );
  assert.deepEqual((await history.fetch(tenantA, row.rows[0].id)).record, {
    a: 1,
    z: 2,
  });
  assert.deepEqual(await history.ingest(tenantA, input()), {
    stored: 0,
    duplicate: 1,
  });
  assert.equal(objects.objects.get(legacyKey), current[1]);
});
