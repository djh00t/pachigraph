import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { handleAPI } from '../server/http.ts';
import {
  createHistory,
  prepareHistoryRecords,
  type IngestInput,
} from '../server/history.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/agent-run/synthetic-run.json', import.meta.url),
    'utf8',
  ),
) as IngestInput;

const owner = 'synthetic-owner';

const acknowledgement = (
  ownerId: string,
  input: IngestInput,
  stored: number,
  duplicate: number,
) => ({
  stored,
  duplicate,
  records: prepareHistoryRecords(ownerId, input).map(
    ({ item, revision, id }) => ({
      id: item.id,
      revision_id: revision,
      archive_id: id,
    }),
  ),
});

type HistoryRow = {
  owner_id: string;
  thread_id: string;
  source_id: string;
  revision_id: string;
  id: string;
  source_timestamp: string;
  source_text: string;
  object_key: string;
  ingested_at: string;
  valid_time_status: 'unknown' | 'known';
  valid_from: string | null;
  valid_to: string | null;
  recorded_from: string;
  recorded_to: string | null;
};

class MemoryPool {
  readonly rows = new Map<string, HistoryRow>();
  readonly tombstones = new Set<string>();
  failNextQuery = false;

  async connect() {
    return {
      query: async (statement: string, values: unknown[] = []) =>
        this.execute(statement, values),
      release: () => undefined,
    };
  }

  async query<T>(statement: string, values: unknown[] = []) {
    if (this.failNextQuery) {
      this.failNextQuery = false;
      throw new Error('injected database read failure');
    }
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
      const ownerId = String(values[0]);
      const threadId = String(values[1]);
      const sourceId = String(values[2]);
      const revisionId = String(values[3]);
      const id = String(values[4]);
      const timestamp = String(values[5]);
      const text = String(values[6]);
      const objectKey = String(values[8]);
      const recordedFrom = String(values[9]);
      const validStatus = String(values[10]) as 'unknown' | 'known';
      const validFrom = values[11] === null ? null : String(values[11]);
      const validTo = values[12] === null ? null : String(values[12]);
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
        ingested_at: recordedFrom,
        valid_time_status: validStatus,
        valid_from: validFrom,
        valid_to: validTo,
        recorded_from: recordedFrom,
        recorded_to: null,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected memory-pool query: ${statement}`);
  }
}

class MemoryObjects {
  readonly objects = new Map<string, string>();
  failNextPut = false;
  failNextGet = false;

  async putImmutable(key: string, value: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected object write failure');
    }
    if (!this.objects.has(key)) this.objects.set(key, value);
  }

  async getText(key: string) {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('injected object read failure');
    }
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

  assert.deepEqual(
    await history.ingest(owner, fixture),
    acknowledgement(owner, fixture, fixture.records.length, 0),
  );
  assert.deepEqual(
    await history.ingest(owner, fixture),
    acknowledgement(owner, fixture, 0, fixture.records.length),
  );
  assert.equal(pool.rows.size, fixture.records.length);
  assert.equal(objects.objects.size, fixture.records.length);

  const expected = [...pool.rows.values()].find(
    (row) => row.source_id === first.id,
  );
  assert.ok(expected);
  const fetched = await history.fetch(owner, expected.id);
  assert.equal(fetched.id, expected.id);
  assert.equal(fetched.revision_id, expected.revision_id);
  assert.equal(fetched.timestamp, first.timestamp);
  assert.equal(fetched.text, first.text);
  assert.deepEqual(fetched.record, first.record);
  assert.match(fetched.citation, new RegExp(`\\?id=${expected.id}`));
  const exactResponse = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${expected.id}`),
    owner,
    history,
  );
  assert.equal(exactResponse.status, 200);
  const exact = await exactResponse.json() as {
    revision_id: string;
    valid_time_status: string;
    valid_from: string | null;
    valid_to: string | null;
    recorded_from: string;
    recorded_to: string | null;
  };
  assert.equal(exact.revision_id, expected.revision_id);
  assert.equal(exact.valid_time_status, 'unknown');
  assert.equal(exact.valid_from, null);
  assert.equal(exact.valid_to, null);
  assert.ok(exact.recorded_from);
  assert.equal(exact.recorded_to, null);
});

test('bitemporal ingest preserves legacy identity and distinguishes known open validity', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0];
  assert.ok(original);
  const legacyInput = { ...fixture, records: [original] };
  const legacy = prepareHistoryRecords(owner, legacyInput)[0];
  assert.equal(
    legacy?.revision,
    '0c98995879ea1f2fd7a25dc392f59d721e94a394a9ab903d6cc4ae25def268cb',
  );
  await history.ingest(owner, legacyInput);
  const legacyRow = [...pool.rows.values()][0];
  assert.equal(legacyRow?.valid_time_status, 'unknown');
  assert.equal(legacyRow?.valid_from, null);
  assert.equal(legacyRow?.valid_to, null);
  assert.ok(legacyRow?.recorded_from);
  assert.equal(legacyRow?.recorded_from, legacyRow?.ingested_at);
  assert.equal(legacyRow?.recorded_to, null);

  const knownInput = {
    ...fixture,
    records: [{
      ...original,
      valid_time: { from: null, to: '2031-01-01T01:00:00+01:00' },
    }],
  };
  const known = prepareHistoryRecords(owner, knownInput)[0];
  assert.notEqual(known?.revision, legacy?.revision);
  assert.equal(known?.validFrom, null);
  assert.equal(known?.validTo, '2031-01-01T00:00:00.000000Z');
  await history.ingest(owner, knownInput);
  const roundTrip = await history.fetch(owner, known!.id);
  assert.equal(roundTrip.valid_time_status, 'known');
  assert.equal(roundTrip.valid_from, null);
  assert.equal(roundTrip.valid_to, '2031-01-01T00:00:00.000000Z');
  assert.equal(roundTrip.recorded_to, null);
});

test('bitemporal ingest rejects empty or reversed known intervals before writes', async () => {
  for (const interval of [
    { from: '2031-01-01T00:00:00Z', to: '2031-01-01T00:00:00.000000Z' },
    { from: '2031-01-02T00:00:00Z', to: '2031-01-01T00:00:00Z' },
    { from: '2031-02-30T00:00:00Z', to: null },
    { from: '2031-01-01T00:00:00.1234567Z', to: null },
  ]) {
    const { pool, objects, history } = setup();
    const original = fixture.records[0];
    assert.ok(original);
    await assert.rejects(
      history.ingest(owner, {
        ...fixture,
        records: [{ ...original, valid_time: interval }],
      }),
      { status: 400 },
    );
    assert.equal(pool.rows.size, 0);
    assert.equal(objects.objects.size, 0);
  }
});

test('bitemporal interval identity normalizes offsets and migration preserves unknown history', async () => {
  const original = fixture.records[0];
  assert.ok(original);
  const first = prepareHistoryRecords(owner, {
    ...fixture,
    records: [{ ...original, valid_time: {
      from: '2031-01-01T00:00:00.123456Z',
      to: '2031-01-02T00:00:00Z',
    } }],
  })[0];
  const sameInterval = prepareHistoryRecords(owner, {
    ...fixture,
    records: [{ ...original, valid_time: {
      from: '2031-01-01T01:00:00.123456+01:00',
      to: '2031-01-01T19:00:00-05:00',
    } }],
  })[0];
  assert.equal(first?.revision, sameInterval?.revision);

  const migration = readFileSync(
    new URL('../db/migrations/0002_history_bitemporal.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /SET recorded_from = ingested_at::timestamptz/u);
  assert.match(migration, /recorded_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP/u);
  assert.match(migration, /valid_time_status TEXT NOT NULL DEFAULT 'unknown'/u);
  assert.doesNotMatch(migration, /valid_from\s*=\s*source_timestamp/u);
});

test('exact fetch reports an indexed record with a missing object as unavailable', async () => {
  const { pool, objects, history } = setup();
  await history.ingest(owner, fixture);
  const row = [...pool.rows.values()][0];
  assert.ok(row);
  objects.objects.delete(row.object_key);

  const response = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${row.id}`),
    owner,
    history,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Temporarily unavailable' });
});

test('exact fetch keeps absent and denied records at 404 while backend failures map to 503', async () => {
  const { pool, objects, history } = setup();
  await history.ingest(owner, fixture);
  const row = [...pool.rows.values()][0];
  assert.ok(row);
  const denied = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${row.id}`),
    'different-owner',
    history,
  );
  assert.equal(denied.status, 404);
  const absent = await handleAPI(
    new Request('https://history.example/api/fetch?id=absent'),
    owner,
    history,
  );
  assert.equal(absent.status, 404);

  objects.failNextGet = true;
  const storageUnavailable = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${row.id}`),
    owner,
    history,
  );
  assert.equal(storageUnavailable.status, 503);

  pool.failNextQuery = true;
  const unavailable = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${row.id}`),
    owner,
    history,
  );
  assert.equal(unavailable.status, 503);
});

test('run replay preserves owner-scoped usage evidence', async () => {
  const { pool, objects, history } = setup();
  const recovered = createHistory(pool as unknown as Pool, objects);
  const first = prepareHistoryRecords(owner, fixture);
  const otherOwner = prepareHistoryRecords('synthetic-owner-2', fixture);

  assert.deepEqual(
    await history.ingest(owner, fixture),
    acknowledgement(owner, fixture, fixture.records.length, 0),
  );
  assert.deepEqual(
    await history.ingest(owner, fixture),
    acknowledgement(owner, fixture, 0, fixture.records.length),
  );
  assert.deepEqual(
    await history.ingest('synthetic-owner-2', fixture),
    acknowledgement('synthetic-owner-2', fixture, fixture.records.length, 0),
  );
  assert.deepEqual(
    await recovered.ingest(owner, fixture),
    acknowledgement(owner, fixture, 0, fixture.records.length),
  );

  assert.equal(pool.rows.size, fixture.records.length * 2);
  assert.equal(objects.objects.size, fixture.records.length * 2);
  assert.notDeepEqual(
    first.map(({ id, key }) => ({ id, key })),
    otherOwner.map(({ id, key }) => ({ id, key })),
  );
  const roundTrip = await Promise.all(
    first.map(({ id }) => recovered.fetch(owner, id)),
  );
  const otherRoundTrip = await Promise.all(
    otherOwner.map(({ id }) =>
      recovered.fetch('synthetic-owner-2', id),
    ),
  );
  await assert.rejects(
    recovered.fetch('synthetic-owner-2', first[0]!.id),
    { status: 404 },
  );
  assert.deepEqual(
    roundTrip.map(({ record }) => record),
    fixture.records.map(({ record }) => record),
  );
  assert.deepEqual(
    otherRoundTrip.map(({ record }) => record),
    fixture.records.map(({ record }) => record),
  );
  const usageEvents = roundTrip
    .map(({ record }) =>
      record as {
        event_type: string;
        usage: {
          report_semantics: string;
          receipt_id: string | null;
          coverage: string;
        };
      },
    )
    .filter((record) => record.event_type === 'model.call');
  assert.equal(usageEvents[0]?.usage.receipt_id, 'receipt-001');
  assert.deepEqual(
    usageEvents
      .map(({ usage }) => ({
        report_semantics: usage.report_semantics,
        receipt_id: usage.receipt_id,
        coverage: usage.coverage,
      })),
    [
      {
        report_semantics: 'provider-reported',
        receipt_id: 'receipt-001',
        coverage: 'reported',
      },
      {
        report_semantics: 'redacted-by-source',
        receipt_id: 'receipt-002',
        coverage: 'redacted',
      },
    ],
  );
  assert.deepEqual(
    roundTrip.find(({ record }) => record.event_type === 'usage.observation')
      ?.record,
    fixture.records.find(({ record }) => record.event_type === 'usage.observation')
      ?.record,
  );
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
  assert.deepEqual(
    await history.ingest(owner, input),
    acknowledgement(owner, input, 1, 0),
  );
  const row = [...pool.rows.values()][0];
  assert.ok(row);
  assert.deepEqual(
    await history.fetch(owner, row.id).then(({ record }) => record),
    input.records[0]?.record,
  );
});
