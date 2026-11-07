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
  corrects_id: string | null;
  is_retraction: boolean;
};

class MemoryPool {
  readonly rows = new Map<string, HistoryRow>();
  readonly tombstones = new Set<string>();
  failNextQuery = false;
  private lockTail = Promise.resolve();
  private nextLockDelay:
    | { started: () => void; gate: Promise<void> }
    | undefined;

  pauseNextThreadLock() {
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextLockDelay = { started, gate };
    return { waiting, release };
  }

  private async acquireThreadLock() {
    const delay = this.nextLockDelay;
    if (delay) {
      this.nextLockDelay = undefined;
      delay.started();
      await delay.gate;
    }
    const previous = this.lockTail;
    let release: () => void = () => {};
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async connect() {
    let releaseLock: (() => void) | undefined;
    return {
      query: async (statement: string, values: unknown[] = []) => {
        if (statement.includes('pg_advisory_xact_lock')) {
          releaseLock = await this.acquireThreadLock();
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes('SELECT r.id, r.thread_id, r.corrects_id') ||
          statement.includes('WITH RECURSIVE as_of_lineage') ||
          statement.includes('SELECT r.thread_id')
        ) {
          return this.query(statement, values);
        }
        const result = await this.execute(statement, values);
        if (/^(COMMIT|ROLLBACK)$/u.test(statement)) {
          releaseLock?.();
          releaseLock = undefined;
        }
        return result;
      },
      release: () => releaseLock?.(),
    };
  }

  async query<T>(statement: string, values: unknown[] = []) {
    if (this.failNextQuery) {
      this.failNextQuery = false;
      throw new Error('injected database read failure');
    }
    if (statement.includes('SELECT r.id, r.thread_id, r.corrects_id')) {
      const [ownerId, id, threadId] = values.map(String);
      const row = [...this.rows.values()].find(
        (candidate) =>
          candidate.owner_id === ownerId &&
          candidate.id === id &&
          (!threadId || candidate.thread_id === threadId) &&
          !this.tombstones.has(`${ownerId}\0${candidate.thread_id}`),
      );
      return {
        rows: row
          ? [
              {
                id: row.id,
                thread_id: row.thread_id,
                corrects_id: row.corrects_id,
              } as T,
            ]
          : [],
        rowCount: Number(Boolean(row)),
      };
    }
    if (statement.includes('SELECT r.thread_id')) {
      const [ownerId, id] = values.map(String);
      const row = [...this.rows.values()].find(
        (candidate) =>
          candidate.owner_id === ownerId &&
          candidate.id === id &&
          !this.tombstones.has(`${ownerId}\0${candidate.thread_id}`),
      );
      return {
        rows: row ? [{ thread_id: row.thread_id } as T] : [],
        rowCount: Number(Boolean(row)),
      };
    }
    if (statement.includes('WITH RECURSIVE as_of_lineage')) {
      const ownerId = String(values[0]);
      const threadId = String(values[1]);
      const rootId = String(values[2]);
      const recordedCut = Date.parse(String(values[3]));
      if (this.tombstones.has(`${ownerId}\0${threadId}`))
        return { rows: [], rowCount: 0 };
      const queue = [
        {
          row: [...this.rows.values()].find(
            (candidate) =>
              candidate.owner_id === ownerId &&
              candidate.thread_id === threadId &&
              candidate.id === rootId,
          )!,
          depth: 0,
        },
      ];
      const rows: (HistoryRow & { depth: number })[] = [];
      const seen = new Set<string>();
      while (queue.length > 0 && rows.length < 257) {
        const current = queue.shift()!;
        if (!current.row || seen.has(current.row.id)) continue;
        seen.add(current.row.id);
        rows.push({ ...current.row, depth: current.depth });
        const children = [...this.rows.values()]
          .filter(
            (child) =>
              child.owner_id === ownerId &&
              child.thread_id === threadId &&
              child.corrects_id === current.row.id &&
              Date.parse(child.recorded_from) <= recordedCut,
          )
          .sort((left, right) => left.id.localeCompare(right.id));
        for (const child of children)
          queue.push({ row: child, depth: current.depth + 1 });
      }
      return { rows: rows as T[], rowCount: rows.length };
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
    const projected = row
      ? {
          ...row,
          corrected_by_ids: [...this.rows.values()]
            .filter(
              (child) =>
                child.owner_id === row.owner_id &&
                child.thread_id === row.thread_id &&
                child.corrects_id === row.id,
            )
            .map((child) => child.id)
            .sort(),
        }
      : null;
    return { rows: projected ? [projected as T] : [], rowCount: row ? 1 : 0 };
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
    if (
      statement.includes('SELECT 1 AS present FROM pachigraph.history_records')
    ) {
      const [ownerId, threadId, sourceId, revisionId] = values.map(String);
      const exists = [...this.rows.values()].some(
        (row) =>
          row.owner_id === ownerId &&
          row.thread_id === threadId &&
          row.source_id === sourceId &&
          row.revision_id === revisionId,
      );
      return { rows: exists ? [{}] : [], rowCount: Number(exists) };
    }
    if (statement.includes('SELECT id FROM pachigraph.history_records')) {
      const [ownerId, threadId, id] = values.map(String);
      const row = [...this.rows.values()].find(
        (candidate) =>
          candidate.owner_id === ownerId &&
          candidate.thread_id === threadId &&
          candidate.id === id,
      );
      return {
        rows: row ? [{ id: row.id }] : [],
        rowCount: Number(Boolean(row)),
      };
    }
    if (statement.includes('WITH RECURSIVE correction_ancestors')) {
      const ownerId = String(values[0]);
      const threadId = String(values[1]);
      const predecessorId = String(values[2]);
      const candidateId = String(values[3]);
      let current = [...this.rows.values()].find(
        (row) =>
          row.owner_id === ownerId &&
          row.thread_id === threadId &&
          row.id === predecessorId,
      );
      const visited = new Set<string>();
      let cycle = false;
      while (current && !visited.has(current.id)) {
        if (current.id === candidateId) cycle = true;
        visited.add(current.id);
        current = current.corrects_id
          ? [...this.rows.values()].find(
              (row) =>
                row.owner_id === ownerId &&
                row.thread_id === threadId &&
                row.id === current!.corrects_id,
            )
          : undefined;
      }
      return { rows: cycle ? [{}] : [], rowCount: Number(cycle) };
    }
    if (statement.includes('FROM pachigraph.history_records sibling')) {
      const [
        ownerId,
        threadId,
        predecessorId,
        validStatus,
        validFrom,
        validTo,
      ] = values;
      const overlaps = [...this.rows.values()].some((row) => {
        if (
          row.owner_id !== ownerId ||
          row.thread_id !== threadId ||
          row.corrects_id !== predecessorId
        )
          return false;
        if (validStatus === 'unknown' || row.valid_time_status === 'unknown')
          return true;
        return (
          (row.valid_from === null ||
            validTo === null ||
            row.valid_from < String(validTo)) &&
          (validFrom === null ||
            row.valid_to === null ||
            String(validFrom) < row.valid_to)
        );
      });
      return { rows: overlaps ? [{}] : [], rowCount: Number(overlaps) };
    }
    if (statement.includes('INSERT INTO pachigraph.thread_tombstones')) {
      this.tombstones.add(`${String(values[0])}\0${String(values[1])}`);
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes('DELETE FROM pachigraph.history_records')) {
      const [ownerId, threadId] = values.map(String);
      for (const [key, row] of this.rows) {
        if (row.owner_id === ownerId && row.thread_id === threadId)
          this.rows.delete(key);
      }
      return { rows: [], rowCount: 0 };
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
      const correctsId = values[13] === null ? null : String(values[13]);
      const isRetraction = values[14] === true;
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
        corrects_id: correctsId,
        is_retraction: isRetraction,
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
  private nextGetDelay:
    | { started: () => void; gate: Promise<void> }
    | undefined;

  pauseNextGet() {
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGetDelay = { started, gate };
    return { waiting, release };
  }

  async putImmutable(key: string, value: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected object write failure');
    }
    if (!this.objects.has(key)) this.objects.set(key, value);
  }

  async getText(key: string) {
    const delay = this.nextGetDelay;
    if (delay) {
      this.nextGetDelay = undefined;
      delay.started();
      await delay.gate;
    }
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
  const exact = (await exactResponse.json()) as {
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
    records: [
      {
        ...original,
        valid_time: { from: null, to: '2031-01-01T01:00:00+01:00' },
      },
    ],
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
  const linkedKnownInput = {
    ...knownInput,
    records: [{ ...knownInput.records[0]!, corrects_id: 'a'.repeat(64) }],
  };
  assert.notEqual(
    prepareHistoryRecords(owner, linkedKnownInput)[0]?.revision,
    known?.revision,
  );
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

test('correction metadata rejects malformed archive IDs before writes', async () => {
  const { pool, objects, history } = setup();
  const original = fixture.records[0]!;
  await assert.rejects(
    history.ingest(owner, {
      ...fixture,
      records: [{ ...original, corrects_id: 'not-an-archive-id' }],
    }),
    { status: 400 },
  );
  assert.equal(pool.rows.size, 0);
  assert.equal(objects.objects.size, 0);
});

test('bitemporal interval identity normalizes offsets and migration preserves unknown history', async () => {
  const original = fixture.records[0];
  assert.ok(original);
  const first = prepareHistoryRecords(owner, {
    ...fixture,
    records: [
      {
        ...original,
        valid_time: {
          from: '2031-01-01T00:00:00.123456Z',
          to: '2031-01-02T00:00:00Z',
        },
      },
    ],
  })[0];
  const sameInterval = prepareHistoryRecords(owner, {
    ...fixture,
    records: [
      {
        ...original,
        valid_time: {
          from: '2031-01-01T01:00:00.123456+01:00',
          to: '2031-01-01T19:00:00-05:00',
        },
      },
    ],
  })[0];
  assert.equal(first?.revision, sameInterval?.revision);

  const migration = readFileSync(
    new URL('../db/migrations/0002_history_bitemporal.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /SET recorded_from = ingested_at::timestamptz/u);
  assert.match(
    migration,
    /recorded_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP/u,
  );
  assert.match(migration, /valid_time_status TEXT NOT NULL DEFAULT 'unknown'/u);
  assert.doesNotMatch(migration, /valid_from\s*=\s*source_timestamp/u);
  const correctionsMigration = readFileSync(
    new URL('../db/migrations/0003_history_corrections.sql', import.meta.url),
    'utf8',
  );
  assert.match(correctionsMigration, /corrects_id <> id/u);
  assert.match(
    correctionsMigration,
    /FOREIGN KEY \(owner_id, thread_id, corrects_id\)/u,
  );
  const retractionMigration = readFileSync(
    new URL('../db/migrations/0004_history_retractions.sql', import.meta.url),
    'utf8',
  );
  assert.match(
    retractionMigration,
    /is_retraction BOOLEAN NOT NULL DEFAULT FALSE/u,
  );
  assert.match(
    retractionMigration,
    /corrects_id IS NOT NULL AND valid_time_status = 'known'/u,
  );
});

function correctionInput(
  sourceId: string,
  correctsId: string,
  from: string | null,
  to: string | null,
  threadId = fixture.thread_id,
) {
  const original = fixture.records[0]!;
  return {
    thread_id: threadId,
    records: [
      {
        ...original,
        id: sourceId,
        text: `correction ${sourceId[0]}`,
        record: { ...original.record, event_id: sourceId, correction: true },
        valid_time: { from, to },
        corrects_id: correctsId,
      },
    ],
  };
}

function recordedPoint(row: HistoryRow, offsetMs = 1000) {
  return new Date(Date.parse(row.recorded_from) + offsetMs).toISOString();
}

test('as-of point query separates late arrival from valid time', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [
      {
        ...original,
        timestamp: '2020-01-01T00:00:00Z',
        valid_time: {
          from: '2020-01-01T00:00:00Z',
          to: '2020-01-02T00:00:00Z',
        },
      },
    ],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const row = [...pool.rows.values()][0]!;
  const beforeArrival = new Date(
    Date.parse(row.recorded_from) - 1000,
  ).toISOString();
  assert.equal(
    (await history.asOf(owner, root.id, '2020-01-01T12:00:00Z', beforeArrival))
      .status,
    'not_known',
  );
  const afterArrival = recordedPoint(row);
  const result = await history.asOf(
    owner,
    root.id,
    '2020-01-01T12:00:00Z',
    afterArrival,
  );
  assert.equal(result.status, 'resolved');
  assert.ok('record' in result);
  assert.equal(result.record.id, root.id);
  assert.equal(result.record.timestamp, '2020-01-01T00:00:00Z');
});

test('as-of recorded intervals are half-open and retain closed ancestors for traversal', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const middleInput = correctionInput('b'.repeat(64), root.id, null, null);
  const middle = prepareHistoryRecords(owner, middleInput)[0]!;
  await history.ingest(owner, middleInput);
  const leafInput = correctionInput('c'.repeat(64), middle.id, null, null);
  const leaf = prepareHistoryRecords(owner, leafInput)[0]!;
  await history.ingest(owner, leafInput);

  const middleRow = [...pool.rows.values()].find(
    (row) => row.id === middle.id,
  )!;
  const leafRow = [...pool.rows.values()].find((row) => row.id === leaf.id)!;
  const middleEnd = new Date(
    Date.parse(leafRow.recorded_from) + 30_000,
  ).toISOString();
  const leafEnd = new Date(
    Date.parse(leafRow.recorded_from) + 60_000,
  ).toISOString();
  middleRow.recorded_to = middleEnd;
  leafRow.recorded_to = leafEnd;
  const afterMiddleEnd = new Date(
    Date.parse(leafRow.recorded_from) + 45_000,
  ).toISOString();

  const before = await history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    afterMiddleEnd,
  );
  assert.ok('record' in before);
  assert.equal(before.record.id, leaf.id);
  const atEnd = await history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    leafEnd,
  );
  assert.ok('record' in atEnd);
  assert.equal(atEnd.record.id, root.id);
});

test('as-of selects partial correction only in its valid period and allows it outside ancestor validity', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [
      {
        ...original,
        valid_time: {
          from: '2031-01-01T00:00:00Z',
          to: '2031-01-07T00:00:00Z',
        },
      },
    ],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const correction = correctionInput(
    'b'.repeat(64),
    root.id,
    '2031-01-05T00:00:00Z',
    '2031-01-08T00:00:00Z',
  );
  const corrected = prepareHistoryRecords(owner, correction)[0]!;
  await history.ingest(owner, correction);
  const recordedAt = recordedPoint([...pool.rows.values()][0]!);

  const priorPeriod = await history.asOf(
    owner,
    root.id,
    '2031-01-02T00:00:00Z',
    recordedAt,
  );
  assert.ok('record' in priorPeriod);
  assert.equal(priorPeriod.record.id, root.id);
  const outsideAncestor = await history.asOf(
    owner,
    root.id,
    '2031-01-06T12:00:00Z',
    recordedAt,
  );
  assert.equal(outsideAncestor.status, 'resolved');
  assert.ok('record' in outsideAncestor);
  assert.equal(outsideAncestor.record.id, corrected.id);
  const beyondAncestor = await history.asOf(
    owner,
    root.id,
    '2031-01-07T12:00:00Z',
    recordedAt,
  );
  assert.ok('record' in beyondAncestor);
  assert.equal(beyondAncestor.record.id, corrected.id);
  assert.equal(
    (await history.asOf(owner, root.id, '2031-01-08T00:00:00Z', recordedAt))
      .status,
    'outside_validity',
  );
});

test('known eligible descendant resolves an unknown ancestor only during its interval', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = { ...fixture, records: [original] };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const correction = correctionInput(
    'b'.repeat(64),
    root.id,
    '2031-01-05T00:00:00Z',
    '2031-01-06T00:00:00Z',
  );
  const corrected = prepareHistoryRecords(owner, correction)[0]!;
  await history.ingest(owner, correction);
  const recordedAt = recordedPoint([...pool.rows.values()][0]!);

  const resolved = await history.asOf(
    owner,
    root.id,
    '2031-01-05T12:00:00Z',
    recordedAt,
  );
  assert.equal(resolved.status, 'resolved');
  assert.ok('record' in resolved);
  assert.equal(resolved.record.id, corrected.id);
  const unknown = await history.asOf(
    owner,
    root.id,
    '2031-01-07T00:00:00Z',
    recordedAt,
  );
  assert.equal(unknown.status, 'unknown');
  assert.ok('record' in unknown);
  assert.equal(unknown.record.id, root.id);
});

test('as-of reports ambiguous maximal branches instead of choosing one', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const firstInput = correctionInput(
    'b'.repeat(64),
    root.id,
    '2031-01-01T00:00:00Z',
    '2031-01-02T00:00:00Z',
  );
  const first = prepareHistoryRecords(owner, firstInput)[0]!;
  await history.ingest(owner, firstInput);
  const branchA = correctionInput(
    'c'.repeat(64),
    first.id,
    '2031-01-05T00:00:00Z',
    '2031-01-06T00:00:00Z',
  );
  const branchB = correctionInput(
    'd'.repeat(64),
    root.id,
    '2031-01-05T00:00:00Z',
    '2031-01-06T00:00:00Z',
  );
  const branchAId = prepareHistoryRecords(owner, branchA)[0]!.id;
  const branchBId = prepareHistoryRecords(owner, branchB)[0]!.id;
  await history.ingest(owner, branchA);
  await history.ingest(owner, branchB);
  const recordedAt = recordedPoint([...pool.rows.values()][0]!);

  const result = await history.asOf(
    owner,
    root.id,
    '2031-01-05T12:00:00Z',
    recordedAt,
  );
  assert.equal(result.status, 'ambiguous');
  assert.ok('candidate_ids' in result);
  assert.deepEqual(result.candidate_ids, [branchAId, branchBId].sort());
  assert.ok(!('record' in result));
});

test('retraction is an explicit hashed correction and wins only in its valid period', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [
      {
        ...original,
        valid_time: {
          from: '2031-01-01T00:00:00Z',
          to: '2031-01-10T00:00:00Z',
        },
      },
    ],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const originalRetraction = correctionInput(
    'b'.repeat(64),
    root.id,
    '2031-01-03T00:00:00Z',
    '2031-01-04T00:00:00Z',
  );
  const retraction = {
    ...originalRetraction,
    records: [{ ...originalRetraction.records[0]!, retracts: true }],
  };
  const retractionRecord = prepareHistoryRecords(owner, retraction)[0]!;
  assert.notEqual(
    retractionRecord.revision,
    prepareHistoryRecords(owner, originalRetraction)[0]!.revision,
  );
  assert.equal(
    prepareHistoryRecords(owner, originalRetraction)[0]!.revision,
    prepareHistoryRecords(owner, {
      ...retraction,
      records: [{ ...retraction.records[0], retracts: false }],
    })[0]!.revision,
  );
  await history.ingest(owner, retraction);
  const recordedAt = recordedPoint([...pool.rows.values()][0]!);

  const withdrawn = await history.asOf(
    owner,
    root.id,
    '2031-01-03T12:00:00Z',
    recordedAt,
  );
  assert.equal(withdrawn.status, 'retracted');
  assert.ok('record' in withdrawn);
  assert.equal(withdrawn.record.id, retractionRecord.id);
  assert.equal(withdrawn.record.retracts, true);
  const afterRetraction = await history.asOf(
    owner,
    root.id,
    '2031-01-05T00:00:00Z',
    recordedAt,
  );
  assert.ok('record' in afterRetraction);
  assert.equal(afterRetraction.record.id, root.id);
});

test('as-of refuses a lineage larger than its fixed traversal limit', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const first = [...pool.rows.values()][0]!;
  let parentId = root.id;
  for (let index = 0; index < 256; index += 1) {
    const id = `${index.toString(16).padStart(64, '0')}`;
    pool.rows.set(`${owner}\0${fixture.thread_id}\0${id}\0${id}`, {
      ...first,
      source_id: id,
      revision_id: id,
      id,
      corrects_id: parentId,
    });
    parentId = id;
  }
  const result = await history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    recordedPoint(first),
  );
  assert.equal(result.status, 'lineage_limit');
  assert.ok(!('record' in result));
});

test('future descendants do not exhaust the limit for an earlier recorded cut', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await history.ingest(owner, rootInput);
  const first = [...pool.rows.values()][0]!;
  const recordedAt = recordedPoint(first);
  const futureRecordedAt = new Date(
    Date.parse(recordedAt) + 60_000,
  ).toISOString();
  let parentId = root.id;
  for (let index = 0; index < 300; index += 1) {
    const id = index.toString(16).padStart(64, '0');
    pool.rows.set(`${owner}\0${fixture.thread_id}\0${id}\0${id}`, {
      ...first,
      source_id: id,
      revision_id: id,
      id,
      corrects_id: parentId,
      recorded_from: futureRecordedAt,
      ingested_at: futureRecordedAt,
    });
    parentId = id;
  }

  const result = await history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    recordedAt,
  );
  assert.equal(result.status, 'resolved');
  assert.ok('record' in result);
  assert.equal(result.record.id, root.id);
});

test('as-of holds the thread lock through object read and revalidates after delete', async () => {
  const first = setup();
  const original = fixture.records[0]!;
  const rootInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const root = prepareHistoryRecords(owner, rootInput)[0]!;
  await first.history.ingest(owner, rootInput);
  const recordedAt = recordedPoint([...first.pool.rows.values()][0]!);
  const getDelay = first.objects.pauseNextGet();
  const asOfResult = first.history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    recordedAt,
  );
  await getDelay.waiting;
  let deleteCompleted = false;
  const deletion = first.history
    .deleteThread(owner, fixture.thread_id)
    .then(() => {
      deleteCompleted = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deleteCompleted, false);
  getDelay.release();
  const result = await asOfResult;
  assert.equal(result.status, 'resolved');
  await deletion;
  assert.equal(deleteCompleted, true);

  const second = setup();
  await second.history.ingest(owner, rootInput);
  const staleLock = second.pool.pauseNextThreadLock();
  const staleAsOf = second.history.asOf(
    owner,
    root.id,
    '2031-01-01T00:00:00Z',
    recordedAt,
  );
  const staleRejection = assert.rejects(staleAsOf, { status: 404 });
  await staleLock.waiting;
  await second.history.deleteThread(owner, fixture.thread_id);
  staleLock.release();
  await staleRejection;
});

test('correction ingest is immutable, retryable, and fetches both relation directions', async () => {
  const { history } = setup();
  const original = fixture.records[0]!;
  const predecessorInput = {
    ...fixture,
    records: [
      {
        ...original,
        valid_time: {
          from: '2031-01-01T00:00:00Z',
          to: '2031-02-01T00:00:00Z',
        },
      },
    ],
  };
  const predecessor = prepareHistoryRecords(owner, predecessorInput)[0]!;
  await history.ingest(owner, predecessorInput);

  const correction = correctionInput(
    'b'.repeat(64),
    predecessor.id,
    '2031-01-10T00:00:00Z',
    '2031-01-20T00:00:00Z',
  );
  const expectedCorrection = prepareHistoryRecords(owner, correction)[0]!;
  assert.equal((await history.ingest(owner, correction)).stored, 1);
  assert.equal((await history.ingest(owner, correction)).duplicate, 1);

  const fetchedPredecessor = await history.fetch(owner, predecessor.id);
  const fetchedCorrection = await history.fetch(owner, expectedCorrection.id);
  assert.deepEqual(fetchedPredecessor.corrected_by_ids, [
    expectedCorrection.id,
  ]);
  assert.equal(fetchedPredecessor.valid_from, '2031-01-01T00:00:00.000000Z');
  assert.equal(fetchedPredecessor.valid_to, '2031-02-01T00:00:00.000000Z');
  assert.equal(fetchedCorrection.corrects_id, predecessor.id);
  assert.deepEqual(fetchedCorrection.record, correction.records[0]?.record);
  const response = await handleAPI(
    new Request(`https://history.example/api/fetch?id=${predecessor.id}`),
    owner,
    history,
  );
  assert.deepEqual(
    ((await response.json()) as { corrected_by_ids: string[] })
      .corrected_by_ids,
    [expectedCorrection.id],
  );
});

test('corrections reject wrong scope and overlapping direct replacement periods', async () => {
  const { objects, history } = setup();
  const original = fixture.records[0]!;
  const predecessorInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const predecessor = prepareHistoryRecords(owner, predecessorInput)[0]!;
  await history.ingest(owner, predecessorInput);

  const wrongOwnerPredecessor = prepareHistoryRecords(
    'other-owner',
    predecessorInput,
  )[0]!;
  await history.ingest('other-owner', predecessorInput);
  await assert.rejects(
    history.ingest(
      owner,
      correctionInput(
        'b'.repeat(64),
        wrongOwnerPredecessor.id,
        '2031-01-01T00:00:00Z',
        '2031-01-02T00:00:00Z',
      ),
    ),
    { status: 404 },
  );

  const otherThread = '018f47a8-4af3-7b83-bf0e-6f2b4e955c13';
  const wrongThreadInput = { ...predecessorInput, thread_id: otherThread };
  const wrongThreadPredecessor = prepareHistoryRecords(
    owner,
    wrongThreadInput,
  )[0]!;
  await history.ingest(owner, wrongThreadInput);
  await assert.rejects(
    history.ingest(
      owner,
      correctionInput(
        'a'.repeat(64),
        wrongThreadPredecessor.id,
        '2031-01-01T00:00:00Z',
        '2031-01-02T00:00:00Z',
      ),
    ),
    { status: 404 },
  );

  const ownerBCorrection = correctionInput(
    'e'.repeat(64),
    wrongOwnerPredecessor.id,
    '2031-01-01T00:00:00Z',
    '2031-01-02T00:00:00Z',
  );
  await history.ingest('other-owner', ownerBCorrection);
  assert.deepEqual(
    (await history.fetch(owner, predecessor.id)).corrected_by_ids,
    [],
  );
  assert.equal(
    (await history.fetch('other-owner', wrongOwnerPredecessor.id))
      .corrected_by_ids.length,
    1,
  );

  const first = correctionInput(
    'c'.repeat(64),
    predecessor.id,
    '2031-01-01T00:00:00Z',
    '2031-01-10T00:00:00Z',
  );
  await history.ingest(owner, first);
  await assert.rejects(
    history.ingest(
      owner,
      correctionInput(
        'd'.repeat(64),
        predecessor.id,
        '2031-01-09T00:00:00Z',
        '2031-01-20T00:00:00Z',
      ),
    ),
    { status: 409 },
  );
  assert.ok(objects.objects.size > 0);
});

test('correction ingest rejects a predecessor chain that would create a cycle', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const predecessorInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const predecessor = prepareHistoryRecords(owner, predecessorInput)[0]!;
  await history.ingest(owner, predecessorInput);
  const candidate = correctionInput(
    'b'.repeat(64),
    predecessor.id,
    '2031-01-01T00:00:00Z',
    '2031-01-02T00:00:00Z',
  );
  const candidateRecord = prepareHistoryRecords(owner, candidate)[0]!;
  const predecessorRow = [...pool.rows.values()].find(
    (row) => row.id === predecessor.id,
  )!;
  predecessorRow.corrects_id = candidateRecord.id;
  pool.rows.set(`${owner}\0${fixture.thread_id}\0seed\0${'f'.repeat(64)}`, {
    ...predecessorRow,
    source_id: 'f'.repeat(64),
    revision_id: 'f'.repeat(64),
    id: candidateRecord.id,
    corrects_id: predecessor.id,
  });
  await assert.rejects(history.ingest(owner, candidate), { status: 400 });
});

test('serialized correction writes reject a concurrent overlapping sibling', async () => {
  const { pool, history } = setup();
  const original = fixture.records[0]!;
  const predecessorInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const predecessor = prepareHistoryRecords(owner, predecessorInput)[0]!;
  await history.ingest(owner, predecessorInput);
  const first = correctionInput(
    'c'.repeat(64),
    predecessor.id,
    '2031-01-01T00:00:00Z',
    '2031-01-10T00:00:00Z',
  );
  const second = correctionInput(
    'd'.repeat(64),
    predecessor.id,
    '2031-01-05T00:00:00Z',
    '2031-01-15T00:00:00Z',
  );
  const outcomes = await Promise.allSettled([
    history.ingest(owner, first),
    history.ingest(owner, second),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal((rejected as PromiseRejectedResult).reason.status, 409);
  assert.equal(pool.rows.size, 2);
});

test('disjoint correction periods are allowed and thread deletion removes correction links', async () => {
  const { pool, objects, history } = setup();
  const original = fixture.records[0]!;
  const predecessorInput = {
    ...fixture,
    records: [{ ...original, valid_time: { from: null, to: null } }],
  };
  const predecessor = prepareHistoryRecords(owner, predecessorInput)[0]!;
  await history.ingest(owner, predecessorInput);
  const first = correctionInput(
    'c'.repeat(64),
    predecessor.id,
    '2031-01-01T00:00:00Z',
    '2031-01-10T00:00:00Z',
  );
  const second = correctionInput(
    'd'.repeat(64),
    predecessor.id,
    '2031-01-10T00:00:00Z',
    '2031-01-20T00:00:00Z',
  );
  await history.ingest(owner, first);
  await history.ingest(owner, second);

  assert.equal(
    (await history.fetch(owner, predecessor.id)).corrected_by_ids.length,
    2,
  );
  await history.deleteThread(owner, fixture.thread_id);
  assert.equal(pool.rows.size, 0);
  assert.equal(objects.objects.size, 0);
  await assert.rejects(history.fetch(owner, predecessor.id), { status: 404 });
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
    otherOwner.map(({ id }) => recovered.fetch('synthetic-owner-2', id)),
  );
  await assert.rejects(recovered.fetch('synthetic-owner-2', first[0]!.id), {
    status: 404,
  });
  assert.deepEqual(
    roundTrip.map(({ record }) => record),
    fixture.records.map(({ record }) => record),
  );
  assert.deepEqual(
    otherRoundTrip.map(({ record }) => record),
    fixture.records.map(({ record }) => record),
  );
  const usageEvents = roundTrip
    .map(
      ({ record }) =>
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
    usageEvents.map(({ usage }) => ({
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
    fixture.records.find(
      ({ record }) => record.event_type === 'usage.observation',
    )?.record,
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
