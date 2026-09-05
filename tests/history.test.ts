import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';

import { createHistory, HistoryError } from '../server/history.ts';

const migrations = new URL('../drizzle/', import.meta.url);
const HISTORY_SQL = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
  .join('\n');

class D1Statement {
  private values: unknown[] = [];
  private readonly sqlite: DatabaseSync;
  private readonly sql: string;
  private readonly fail: () => boolean;

  constructor(sqlite: DatabaseSync, sql: string, fail: () => boolean) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.fail = fail;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.fail()) throw new Error('injected D1 failure');
    const result = this.sqlite
      .prepare(this.sql)
      .run(...(this.values as SQLInputValue[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async all<T>() {
    const results = this.sqlite
      .prepare(this.sql)
      .all(...(this.values as SQLInputValue[])) as T[];
    return { success: true, results };
  }

  async first<T>() {
    return (
      (this.sqlite
        .prepare(this.sql)
        .get(...(this.values as SQLInputValue[])) as T | undefined) ?? null
    );
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failNextRun = false;

  constructor() {
    this.sqlite.exec(HISTORY_SQL);
  }

  prepare(sql: string) {
    return new D1Statement(this.sqlite, sql, () => {
      if (!this.failNextRun) return false;
      this.failNextRun = false;
      return true;
    });
  }
}

class MemoryR2 {
  readonly objects = new Map<string, string>();
  failNextPut = false;

  async put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected R2 failure');
    }
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key))
      return null;
    this.objects.set(key, value);
    return { key };
  }

  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

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
  const db = new TestD1();
  const bucket = new MemoryR2();
  return { db, bucket, history: createHistory(db as never, bucket as never) };
}

test('duplicate replay stores one immutable revision', async () => {
  const { history, bucket } = setup();
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 1,
    duplicate: 0,
  });
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 0,
    duplicate: 1,
  });
  assert.equal(bucket.objects.size, 1);
  assert.equal((await history.status(OWNER_A)).records, 1);
});

test('changed and backfilled source events append deterministic revisions', async () => {
  const { history, bucket } = setup();
  await history.ingest(OWNER_A, input('newer', { b: 2, a: 1 }));
  assert.equal([...bucket.objects.values()][0], '{"a":1,"b":2}');
  await history.ingest(OWNER_A, input('older', { original: true }));
  assert.deepEqual(
    await history.ingest(OWNER_A, input('newer', { a: 1, b: 2 })),
    {
      stored: 0,
      duplicate: 1,
    },
  );
  assert.equal((await history.status(OWNER_A)).records, 2);
});

test('failed R2 or index writes can be retried without partial index state', async () => {
  const { history, bucket, db } = setup();
  bucket.failNextPut = true;
  await assert.rejects(history.ingest(OWNER_A, input()), /injected R2/);
  assert.equal((await history.status(OWNER_A)).records, 0);

  db.failNextRun = true;
  await assert.rejects(history.ingest(OWNER_A, input()), /injected D1/);
  assert.equal(bucket.objects.size, 1);
  assert.equal((await history.status(OWNER_A)).records, 0);
  assert.deepEqual(await history.ingest(OWNER_A, input()), {
    stored: 1,
    duplicate: 0,
  });
});

test('thread deletion removes an orphan left by an interrupted index write', async () => {
  const { history, bucket, db } = setup();
  db.failNextRun = true;
  await assert.rejects(history.ingest(OWNER_A, input()), /injected D1/);
  assert.equal(bucket.objects.size, 1);
  await history.deleteThread(OWNER_A, THREAD);
  assert.equal(bucket.objects.size, 0);
  await assert.rejects(history.ingest(OWNER_A, input()), { status: 410 });
});

test('fetch, search, and deletion remain owner scoped', async () => {
  const { history } = setup();
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

test('thread tombstones permanently reject reingestion', async () => {
  const first = setup();
  assert.deepEqual(await first.history.deleteThread(OWNER_A, THREAD), {
    deleted: true,
  });
  await assert.rejects(first.history.ingest(OWNER_A, input()), (error) => {
    assert.ok(error instanceof HistoryError);
    assert.equal(error.status, 410);
    return true;
  });

  await assert.rejects(
    first.history.ingest(OWNER_A, { thread_id: THREAD, records: [] }),
    {
      status: 410,
    },
  );
});

test('a tombstone created immediately after insert rejects ingest and cleans R2', async () => {
  const { history, bucket, db } = setup();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (sql.startsWith('INSERT OR IGNORE INTO history_records')) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        const result = await originalRun();
        db.sqlite
          .prepare(
            'INSERT OR IGNORE INTO thread_tombstones(owner_id, thread_id) VALUES (?, ?)',
          )
          .run(OWNER_A, THREAD);
        return result;
      };
    }
    return statement;
  };
  await assert.rejects(history.ingest(OWNER_A, input()), { status: 410 });
  assert.equal(bucket.objects.size, 0);
});

test('ingest that races a tombstone leaves no row or object', async () => {
  const { history, bucket, db } = setup();
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (...args: Parameters<MemoryR2['put']>) => {
    const result = await originalPut(...args);
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO thread_tombstones(owner_id, thread_id) VALUES (?, ?)',
      )
      .run(OWNER_A, THREAD);
    return result;
  };
  await assert.rejects(history.ingest(OWNER_A, input()), { status: 410 });
  assert.equal(bucket.objects.size, 0);
  assert.equal((await history.status(OWNER_A)).records, 0);
});

test('FTS literal tokens find known text and return source citations', async () => {
  const { history } = setup();
  await history.ingest(OWNER_A, input('Needle phrase: alpha-beta (gamma).'));
  const { results } = await history.search(OWNER_A, 'alpha-beta (gamma)');
  assert.equal(results.length, 1);
  assert.equal(
    results[0].citation,
    `Codex thread ${THREAD}, event ${SOURCE}, 2026-09-05T01:02:03.000Z; /?id=${results[0].id}; codex://threads/${THREAD}#${SOURCE}`,
  );
});

test('status reports indexed UTF-8 bytes and last ingestion time', async () => {
  const { history } = setup();
  await history.ingest(OWNER_A, input('hello 🌏'));
  const status = await history.status(OWNER_A);
  assert.equal(status.records, 1);
  assert.equal(status.text_bytes, Buffer.byteLength('hello 🌏'));
  assert.match(status.last_ingested_at!, /^\d{4}-\d{2}-\d{2}T/);
});

test('bounds batch and search query input', async () => {
  const { history } = setup();
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
});

test('rejects oversized records before writing', async () => {
  const { history, bucket } = setup();
  await assert.rejects(
    history.ingest(OWNER_A, input('x'.repeat(384 * 1024))),
    /384 KiB/,
  );
  assert.equal(bucket.objects.size, 0);
});

test('rejects malformed and deeply nested records as 400', async () => {
  const { history } = setup();
  await assert.rejects(history.ingest(OWNER_A, null), { status: 400 });
  await assert.rejects(
    history.ingest(OWNER_A, { thread_id: THREAD, records: [null] }),
    {
      status: 400,
    },
  );
  let record: Record<string, unknown> = {};
  for (let depth = 0; depth < 70; depth += 1) record = { child: record };
  await assert.rejects(history.ingest(OWNER_A, input('deep', record)), {
    status: 400,
  });
});

test('accepts depth 64, preserves replay identity, and rejects depth 65', async () => {
  const { history, bucket } = setup();
  let record: Record<string, unknown> = { value: 'boundary' };
  for (let depth = 1; depth < 64; depth += 1) record = { child: record };
  const sample = input('boundary depth', record);
  assert.deepEqual(await history.ingest(OWNER_A, sample), {
    stored: 1,
    duplicate: 0,
  });
  const found = (await history.search(OWNER_A, 'boundary')).results[0];
  assert.deepEqual((await history.fetch(OWNER_A, found.id)).record, record);
  assert.deepEqual(await history.ingest(OWNER_A, sample), {
    stored: 0,
    duplicate: 1,
  });
  assert.equal(bucket.objects.size, 1);
  await assert.rejects(
    history.ingest(OWNER_A, input('too deep', { child: record })),
    { status: 400 },
  );
  assert.equal(bucket.objects.size, 1);
});
