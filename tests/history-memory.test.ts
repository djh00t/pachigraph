import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createHistory, type IngestInput } from '../server/history.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/agent-run/synthetic-run.json', import.meta.url),
    'utf8',
  ),
) as IngestInput;

const owner = 'synthetic-owner';

type HistoryRow = {
  owner_id: string;
  thread_id: string;
  source_id: string;
  revision_id: string;
  id: string;
  source_timestamp: string;
  source_text: string;
  object_key: string;
};

class MemoryPool {
  readonly rows = new Map<string, HistoryRow>();
  readonly tombstones = new Set<string>();

  async connect() {
    return {
      query: async (statement: string, values: unknown[] = []) =>
        this.execute(statement, values),
      release: () => undefined,
    };
  }

  async query<T>(statement: string, values: unknown[] = []) {
    if (!statement.includes('FROM pachigraph.history_records r'))
      throw new Error(`Unexpected memory-pool query: ${statement}`);
    const ownerId = String(values[0]);
    const id = String(values[1]);
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.owner_id === ownerId &&
        candidate.id === id &&
        !this.tombstones.has(`${ownerId}\0${candidate.thread_id}`),
    );
    return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
  }

  private async execute(statement: string, values: unknown[]) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(statement))
      return { rows: [], rowCount: 0 };
    if (statement.includes('pg_advisory_xact_lock'))
      return { rows: [], rowCount: 0 };
    if (statement.includes('FROM pachigraph.thread_tombstones')) {
      const key = `${String(values[0])}\0${String(values[1])}`;
      return {
        rows: this.tombstones.has(key) ? [{}] : [],
        rowCount: Number(this.tombstones.has(key)),
      };
    }
    if (statement.includes('INSERT INTO pachigraph.history_records')) {
      const [
        ownerId,
        threadId,
        sourceId,
        revisionId,
        id,
        timestamp,
        text,
        ,
        objectKey,
      ] = values.map(String);
      const unique = `${ownerId}\0${threadId}\0${sourceId}\0${revisionId}`;
      if (this.rows.has(unique)) return { rows: [], rowCount: 0 };
      this.rows.set(unique, {
        owner_id: ownerId,
        thread_id: threadId,
        source_id: sourceId,
        revision_id: revisionId,
        id,
        source_timestamp: timestamp,
        source_text: text,
        object_key: objectKey,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected memory-pool query: ${statement}`);
  }
}

class MemoryObjects {
  readonly objects = new Map<string, string>();
  failNextPut = false;

  async putImmutable(key: string, value: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected object write failure');
    }
    if (!this.objects.has(key)) this.objects.set(key, value);
  }

  async getText(key: string) {
    return this.objects.get(key) ?? null;
  }

  async deletePrefix(prefix: string) {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

function setup() {
  const pool = new MemoryPool();
  const objects = new MemoryObjects();
  return {
    pool,
    objects,
    history: createHistory(pool as unknown as Pool, objects),
  };
}

test('history ingest, replay, and fetch use the in-memory storage boundaries', async () => {
  const { pool, objects, history } = setup();
  const first = fixture.records[0];
  assert.ok(first);

  assert.deepEqual(await history.ingest(owner, fixture), {
    stored: fixture.records.length,
    duplicate: 0,
  });
  assert.deepEqual(await history.ingest(owner, fixture), {
    stored: 0,
    duplicate: fixture.records.length,
  });
  assert.equal(pool.rows.size, fixture.records.length);
  assert.equal(objects.objects.size, fixture.records.length);

  const expected = [...pool.rows.values()].find(
    (row) => row.source_id === first.id,
  );
  assert.ok(expected);
  const fetched = await history.fetch(owner, expected.id);
  assert.equal(fetched.id, expected.id);
  assert.equal(fetched.timestamp, first.timestamp);
  assert.equal(fetched.text, first.text);
  assert.deepEqual(fetched.record, first.record);
  assert.match(fetched.citation, new RegExp(`\\?id=${expected.id}`));
});

test('failed immutable object write leaves ingest retryable', async () => {
  const { pool, objects, history } = setup();
  const input = { ...fixture, records: [fixture.records[0]] };
  objects.failNextPut = true;

  await assert.rejects(
    history.ingest(owner, input),
    /injected object write failure/,
  );
  assert.equal(pool.rows.size, 0);
  assert.equal(objects.objects.size, 0);
  assert.deepEqual(await history.ingest(owner, input), {
    stored: 1,
    duplicate: 0,
  });
  const row = [...pool.rows.values()][0];
  assert.ok(row);
  assert.deepEqual(
    await history.fetch(owner, row.id).then(({ record }) => record),
    input.records[0]?.record,
  );
});
