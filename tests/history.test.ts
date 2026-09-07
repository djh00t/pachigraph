import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { createHistory } from '../server/history.ts';
import { clearStorage, testPool } from './storage-support.ts';

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
const OWNER_A = 'acct-A';
const OWNER_B = 'acct-B';
const THREAD = '018f47a8-4af3-7b83-bf0e-6f2b4e955c12';
const SOURCE = 'a'.repeat(64);

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
beforeEach(async () => clearStorage(pool));
after(async () => pool.end());

test('migration is repeatable and rejects changed applied SQL', async () => {
  const { migrate } = await import('../db/migrate.ts');
  await migrate(pool);
  const result = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM pachigraph.schema_migrations',
  );
  assert.deepEqual(
    result.rows.map((row) => row.filename),
    ['0001_initial.sql'],
  );
  const original = result.rows[0].sha256;
  await pool.query(
    "UPDATE pachigraph.schema_migrations SET sha256 = repeat('0', 64)",
  );
  await assert.rejects(migrate(pool), /changed after it was applied/);
  await pool.query(
    'UPDATE pachigraph.schema_migrations SET sha256 = $1 WHERE filename = $2',
    [original, '0001_initial.sql'],
  );
});

test('duplicate replay stores one immutable revision', async () => {
  const { history, objects } = setup();
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 1,
    duplicate: 0,
  });
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 0,
    duplicate: 1,
  });
  assert.equal(objects.objects.size, 1);
  assert.equal((await history.status(OWNER_A)).records, 1);
});

test('changed and backfilled source events append deterministic revisions', async () => {
  const { history, objects } = setup();
  await history.ingest(OWNER_A, input('newer', { b: 2, a: 1 }));
  assert.equal([...objects.objects.values()][0], '{"a":1,"b":2}');
  await history.ingest(OWNER_A, input('older', { original: true }));
  assert.deepEqual(
    await history.ingest(OWNER_A, input('newer', { a: 1, b: 2 })),
    { stored: 0, duplicate: 1 },
  );
  assert.equal((await history.status(OWNER_A)).records, 2);
});

test('object and database failures remain retryable', async () => {
  const { history, objects } = setup();
  objects.failNextPut = true;
  await assert.rejects(history.ingest(OWNER_A, input()), /injected object/);
  assert.equal((await history.status(OWNER_A)).records, 0);

  await pool.query(`
    CREATE FUNCTION pachigraph.reject_history_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$;
    CREATE TRIGGER reject_history_insert BEFORE INSERT ON pachigraph.history_records
    FOR EACH ROW EXECUTE FUNCTION pachigraph.reject_history_insert()
  `);
  await assert.rejects(history.ingest(OWNER_A, input()), /injected database/);
  assert.equal(objects.objects.size, 1);
  assert.equal((await history.status(OWNER_A)).records, 0);
  await pool.query(`
    DROP TRIGGER reject_history_insert ON pachigraph.history_records;
    DROP FUNCTION pachigraph.reject_history_insert()
  `);
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 1,
    duplicate: 0,
  });
});

test('deletion commits its tombstone before retryable object cleanup', async () => {
  const { history, objects } = setup();
  await history.ingest(OWNER_A, input());
  objects.failNextDelete = true;
  await assert.rejects(history.deleteThread(OWNER_A, THREAD), /cleanup/);
  await assert.rejects(history.ingest(OWNER_A, input()), { status: 410 });
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
  assert.deepEqual(await history.deleteThread(OWNER_A, THREAD), {
    deleted: true,
  });
  assert.equal(objects.objects.size, 0);
});

test('fetch, search, and deletion remain owner scoped', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
  await history.ingest(OWNER_A, input());
  await history.ingest(OWNER_B, input());
  const result = (await history.search(OWNER_A, 'orbital passage')).results[0];
  assert.equal(
    (await history.fetch(OWNER_A, result.id)).text,
    input().records[0].text,
  );
  await assert.rejects(history.fetch(OWNER_B, result.id), { status: 404 });
  await history.deleteThread(OWNER_A, THREAD);
  assert.equal((await history.search(OWNER_A, 'orbital')).results.length, 0);
  assert.equal((await history.search(OWNER_B, 'orbital')).results.length, 1);
});

test('concurrent delete and ingest cannot replay a tombstoned thread', async () => {
  const { history, objects } = setup();
  const outcomes = await Promise.allSettled([
    history.ingest(OWNER_A, input()),
    history.deleteThread(OWNER_A, THREAD),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  await assert.rejects(history.ingest(OWNER_A, input()), { status: 410 });
  assert.equal((await history.status(OWNER_A)).records, 0);
  assert.equal(objects.objects.size, 0);
});

test('PostgreSQL FTS returns plain snippets and source citations', async () => {
  const { history } = setup();
  await history.ingest(OWNER_A, input('Needle phrase: alpha-beta (gamma).'));
  const { results } = await history.search(OWNER_A, 'alpha-beta gamma');
  assert.equal(results.length, 1);
  assert.equal(results[0].text.includes('<b>'), false);
  assert.equal(
    results[0].citation,
    `Codex thread ${THREAD}, event ${SOURCE}, 2026-09-05T01:02:03.000Z; /?id=${results[0].id}; codex://threads/${THREAD}#${SOURCE}`,
  );
});

test('status preserves UTF-8 byte counts and reports physical allocation', async () => {
  const { history } = setup();
  await history.ingest(OWNER_A, input('hello 🌏'));
  const status = await history.status(OWNER_A);
  assert.equal(status.records, 1);
  assert.equal(status.text_bytes, Buffer.byteLength('hello 🌏'));
  assert.match(status.last_ingested_at!, /^\d{4}-\d{2}-\d{2}T/);
  const { databaseAllocation } = await import('../server/history.ts');
  assert.ok((await databaseAllocation(pool)).database_bytes > 0);
});

test('bounds batch, search, timestamp and record size input before writes', async () => {
  const { history, objects } = setup();
  await assert.rejects(
    history.ingest(OWNER_A, {
      thread_id: THREAD,
      records: Array(101).fill(input().records[0]),
    }),
    /100/,
  );
  await assert.rejects(history.search(OWNER_A, 'x'.repeat(257)), /256/);
  await assert.rejects(
    history.ingest(OWNER_A, {
      thread_id: THREAD,
      records: [{ ...input().records[0], timestamp: 'September 5, 2026' }],
    }),
    /timestamp/,
  );
  await assert.rejects(
    history.ingest(OWNER_A, input('x'.repeat(384 * 1024))),
    /384 KiB/,
  );
  assert.equal(objects.objects.size, 0);
});

test('rejects malformed/deep records and accepts depth 64', async () => {
  const { history, objects } = setup();
  await assert.rejects(history.ingest(OWNER_A, null), { status: 400 });
  await assert.rejects(
    history.ingest(OWNER_A, { thread_id: THREAD, records: [null] }),
    { status: 400 },
  );
  let record: Record<string, unknown> = { value: 'boundary' };
  for (let depth = 1; depth < 64; depth += 1) record = { child: record };
  const sample = input('boundary depth', record);
  assert.deepEqual(await history.ingest(OWNER_A, sample), {
    stored: 1,
    duplicate: 0,
  });
  const found = (await history.search(OWNER_A, 'boundary')).results[0];
  assert.deepEqual((await history.fetch(OWNER_A, found.id)).record, record);
  await assert.rejects(
    history.ingest(OWNER_A, input('too deep', { child: record })),
    { status: 400 },
  );
  assert.equal(objects.objects.size, 1);
});
