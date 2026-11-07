import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Objects } from './objects.ts';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type InputRecord = {
  id: string;
  timestamp: string;
  text: string;
  record: Record<string, unknown>;
  valid_time?: { from: string | null; to: string | null };
  corrects_id?: string;
  retracts?: boolean;
};

const MAX_AS_OF_LINEAGE = 256;

export type IngestInput = { thread_id: string; records: InputRecord[] };

type AsOfBase = { root_id: string; valid_at: string; recorded_at: string };
type AsOfEvidence = {
  id: string;
  revision_id: string;
  thread_id: string;
  timestamp: string;
  text: string;
  record: Record<string, unknown>;
  valid_time_status: 'unknown' | 'known';
  valid_from: string | null;
  valid_to: string | null;
  recorded_from: string;
  recorded_to: string | null;
  corrects_id: string | null;
  retracts: boolean;
  citation: string;
};
export type AsOfResult =
  | (AsOfBase & { status: 'lineage_limit'; limit: number })
  | (AsOfBase & { status: 'not_known' | 'outside_validity' })
  | (AsOfBase & { status: 'ambiguous'; candidate_ids: string[] })
  | (AsOfBase & {
      status: 'resolved' | 'unknown' | 'retracted';
      record: AsOfEvidence;
    });

export class HistoryError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HistoryError';
    this.status = status;
  }
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 64)
    throw new HistoryError(400, 'record nesting exceeds 64 levels');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object')
    throw new HistoryError(400, 'record must contain JSON values');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`,
    )
    .join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeValidEndpoint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HistoryError(
      400,
      'valid_time endpoints must be ISO timestamps with at most microsecond precision',
    );
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  if (!match)
    throw new HistoryError(
      400,
      'valid_time endpoints must be ISO timestamps with at most microsecond precision',
    );
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ] ?? 0;
  if (
    year < 1 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new HistoryError(400, 'valid_time endpoint is not a real timestamp');
  }
  const fraction = match[7] ?? '';
  const millisFraction = fraction.slice(0, 3).padEnd(3, '0');
  const parseValue = fraction
    ? value.replace(`.${fraction}`, `.${millisFraction}`)
    : value.replace(/(?=Z|[+-]\d{2}:\d{2}$)/u, '.000');
  const milliseconds = Date.parse(parseValue);
  if (Number.isNaN(milliseconds))
    throw new HistoryError(400, 'valid_time endpoint is not a real timestamp');
  const utc = new Date(milliseconds).toISOString();
  return `${utc.slice(0, -1)}${fraction.slice(3).padEnd(3, '0')}Z`;
}

function normalizeValidTime(item: Partial<InputRecord>) {
  if (item.valid_time === undefined)
    return { status: 'unknown' as const, from: null, to: null };
  if (
    !item.valid_time ||
    typeof item.valid_time !== 'object' ||
    Array.isArray(item.valid_time) ||
    Object.keys(item.valid_time).sort().join(',') !== 'from,to'
  ) {
    throw new HistoryError(400, 'valid_time must contain only from and to');
  }
  const from = normalizeValidEndpoint(item.valid_time.from);
  const to = normalizeValidEndpoint(item.valid_time.to);
  if (from !== null && to !== null && from >= to)
    throw new HistoryError(400, 'valid_time must have a non-empty interval');
  return { status: 'known' as const, from, to };
}

function validate(owner: string, input: unknown): asserts input is IngestInput {
  if (!owner) throw new HistoryError(400, 'owner is required');
  if (!input || typeof input !== 'object')
    throw new HistoryError(400, 'input must be an object');
  const candidate = input as { thread_id?: unknown; records?: unknown };
  if (
    typeof candidate.thread_id !== 'string' ||
    !UUID.test(candidate.thread_id)
  ) {
    throw new HistoryError(400, 'thread_id must be a UUID');
  }
  if (!Array.isArray(candidate.records) || candidate.records.length > 100) {
    throw new HistoryError(400, 'records must contain at most 100 items');
  }
  for (const value of candidate.records) {
    if (!value || typeof value !== 'object')
      throw new HistoryError(400, 'record is invalid');
    const item = value as Partial<InputRecord>;
    const validDate =
      typeof item.timestamp === 'string' &&
      ISO_TIMESTAMP.test(item.timestamp) &&
      !Number.isNaN(Date.parse(item.timestamp));
    if (
      !SHA256.test(item.id ?? '') ||
      !validDate ||
      typeof item.text !== 'string'
    ) {
      throw new HistoryError(400, 'record id, timestamp, or text is invalid');
    }
    if (
      !item.record ||
      typeof item.record !== 'object' ||
      Array.isArray(item.record)
    ) {
      throw new HistoryError(400, 'record must be an object');
    }
    const validTime = normalizeValidTime(item);
    if (item.corrects_id !== undefined && !SHA256.test(item.corrects_id))
      throw new HistoryError(400, 'corrects_id must be an archive id');
    if (item.retracts !== undefined && typeof item.retracts !== 'boolean')
      throw new HistoryError(400, 'retracts must be a boolean');
    if (
      item.retracts === true &&
      (!item.corrects_id || validTime.status !== 'known')
    )
      throw new HistoryError(
        400,
        'a retraction requires a predecessor and known valid time',
      );
    const serialized = `{"id":${JSON.stringify(item.id)},"record":${canonical(item.record)},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}${validTime.status === 'known' ? `,"valid_time":{"from":${JSON.stringify(validTime.from)},"to":${JSON.stringify(validTime.to)}}` : ''}${item.corrects_id === undefined ? '' : `,"corrects_id":${JSON.stringify(item.corrects_id)}`}${item.retracts === true ? ',"retracts":true' : ''}}`;
    if (Buffer.byteLength(serialized) > 384 * 1024) {
      throw new HistoryError(413, 'record exceeds 384 KiB');
    }
  }
}

function prepareValidatedHistoryRecords(owner: string, input: IngestInput) {
  const ownerHash = digest(owner);
  return input.records.map((item) => {
    const record = canonical(item.record);
    const validTime = normalizeValidTime(item);
    const legacyRevision = `{"record":${record},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`;
    const revisionBody =
      validTime.status === 'known'
        ? `${legacyRevision.slice(0, -1)},"valid_time":{"from":${JSON.stringify(validTime.from)},"to":${JSON.stringify(validTime.to)}}}`
        : legacyRevision;
    const revisionWithCorrection =
      item.corrects_id === undefined
        ? revisionBody
        : `${revisionBody.slice(0, -1)},"corrects_id":${JSON.stringify(item.corrects_id)}}`;
    const revisionWithRetraction =
      item.retracts === true
        ? `${revisionWithCorrection.slice(0, -1)},"retracts":true}`
        : revisionWithCorrection;
    const revision = digest(revisionWithRetraction);
    return {
      item,
      record,
      revision,
      validTimeStatus: validTime.status,
      validFrom: validTime.from,
      validTo: validTime.to,
      correctsId: item.corrects_id,
      isRetraction: item.retracts === true,
      id: digest(`${owner}\n${input.thread_id}\n${item.id}\n${revision}`),
      key: `${ownerHash}/${input.thread_id}/${item.id}/${revision}`,
    };
  });
}

export function prepareHistoryRecords(owner: string, input: unknown) {
  validate(owner, input);
  return prepareValidatedHistoryRecords(owner, input);
}

function citation(
  id: string,
  threadId: string,
  sourceId: string,
  timestamp: string,
): string {
  return `Codex thread ${threadId}, event ${sourceId}, ${timestamp}; /?id=${id}; codex://threads/${threadId}#${sourceId}`;
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockThread(client: PoolClient, owner: string, threadId: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\n' || $2, 0))",
    [owner, threadId],
  );
}

export function createHistory(
  pool: Pool,
  objects: Pick<Objects, 'putImmutable' | 'getText' | 'deletePrefix'>,
) {
  return {
    async ingest(
      owner: string,
      input: unknown,
    ): Promise<{
      stored: number;
      duplicate: number;
      records: { id: string; revision_id: string; archive_id: string }[];
    }> {
      validate(owner, input);
      const records = prepareValidatedHistoryRecords(owner, input);

      return transaction(pool, async (client) => {
        await lockThread(client, owner, input.thread_id);
        const tombstone = await client.query(
          `SELECT 1 FROM pachigraph.thread_tombstones
           WHERE owner_id = $1 AND thread_id = $2`,
          [owner, input.thread_id],
        );
        if (tombstone.rowCount)
          throw new HistoryError(410, 'history was deleted');

        let stored = 0;
        for (const record of records) {
          const existing = await client.query(
            `SELECT 1 AS present FROM pachigraph.history_records
             WHERE owner_id = $1 AND thread_id = $2 AND source_id = $3 AND revision_id = $4`,
            [owner, input.thread_id, record.item.id, record.revision],
          );
          if (existing.rowCount) continue;

          if (record.correctsId !== undefined) {
            if (record.correctsId === record.id)
              throw new HistoryError(400, 'a record cannot correct itself');
            const predecessor = await client.query(
              `SELECT id FROM pachigraph.history_records
               WHERE owner_id = $1 AND thread_id = $2 AND id = $3`,
              [owner, input.thread_id, record.correctsId],
            );
            if (!predecessor.rowCount)
              throw new HistoryError(404, 'correction predecessor not found');

            const cycle = await client.query(
              `WITH RECURSIVE correction_ancestors(id, corrects_id) AS (
                 SELECT id, corrects_id FROM pachigraph.history_records
                 WHERE owner_id = $1 AND thread_id = $2 AND id = $3
                 UNION
                 SELECT parent.id, parent.corrects_id
                 FROM pachigraph.history_records parent
                 JOIN correction_ancestors child ON parent.id = child.corrects_id
                 WHERE parent.owner_id = $1 AND parent.thread_id = $2
               )
               SELECT 1 FROM correction_ancestors WHERE id = $4 LIMIT 1`,
              [owner, input.thread_id, record.correctsId, record.id],
            );
            if (cycle.rowCount)
              throw new HistoryError(400, 'correction would create a cycle');

            const overlap = await client.query(
              `SELECT 1 FROM pachigraph.history_records sibling
               WHERE sibling.owner_id = $1 AND sibling.thread_id = $2
                 AND sibling.corrects_id = $3
                 AND (
                   $4 = 'unknown' OR sibling.valid_time_status = 'unknown'
                   OR (
                     (sibling.valid_from IS NULL OR $6::timestamptz IS NULL OR sibling.valid_from < $6::timestamptz)
                     AND ($5::timestamptz IS NULL OR sibling.valid_to IS NULL OR $5::timestamptz < sibling.valid_to)
                   )
                 )
               LIMIT 1`,
              [
                owner,
                input.thread_id,
                record.correctsId,
                record.validTimeStatus,
                record.validFrom,
                record.validTo,
              ],
            );
            if (overlap.rowCount)
              throw new HistoryError(
                409,
                'overlapping direct corrections are ambiguous',
              );
          }

          await objects.putImmutable(record.key, record.record);
          const result = await client.query(
            `INSERT INTO pachigraph.history_records
               (owner_id, thread_id, source_id, revision_id, id,
                source_timestamp, source_text, text_bytes, object_key, ingested_at,
                valid_time_status, valid_from, valid_to, recorded_from, recorded_to,
                corrects_id, is_retraction)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $10::timestamptz, NULL, $14, $15)
             ON CONFLICT (owner_id, thread_id, source_id, revision_id) DO NOTHING`,
            [
              owner,
              input.thread_id,
              record.item.id,
              record.revision,
              record.id,
              record.item.timestamp,
              record.item.text,
              Buffer.byteLength(record.item.text),
              record.key,
              new Date().toISOString(),
              record.validTimeStatus,
              record.validFrom,
              record.validTo,
              record.correctsId ?? null,
              record.isRetraction,
            ],
          );
          stored += result.rowCount ?? 0;
        }
        return {
          stored,
          duplicate: records.length - stored,
          records: records.map((record) => ({
            id: record.item.id,
            revision_id: record.revision,
            archive_id: record.id,
          })),
        };
      });
    },

    async fetch(owner: string, id: string) {
      const result = await pool.query<{
        id: string;
        revision_id: string;
        thread_id: string;
        source_id: string;
        source_timestamp: string;
        source_text: string;
        object_key: string;
        valid_time_status: 'unknown' | 'known';
        valid_from: string | null;
        valid_to: string | null;
        recorded_from: string;
        recorded_to: string | null;
        corrects_id: string | null;
        corrected_by_ids: string[];
      }>(
        `SELECT id, revision_id, thread_id, source_id, source_timestamp, source_text, object_key,
                valid_time_status,
                to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
                to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to,
                to_char(recorded_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_from,
                to_char(recorded_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_to,
                corrects_id,
                ARRAY(
                  SELECT child.id FROM pachigraph.history_records child
                  WHERE child.owner_id = r.owner_id AND child.thread_id = r.thread_id
                    AND child.corrects_id = r.id
                  ORDER BY child.id
                ) AS corrected_by_ids
         FROM pachigraph.history_records r
         WHERE owner_id = $1 AND id = $2
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE owner_id = r.owner_id AND thread_id = r.thread_id
           )`,
        [owner, id],
      );
      const row = result.rows[0];
      if (!row) throw new HistoryError(404, 'history record not found');
      const object = await objects.getText(row.object_key);
      if (object === null)
        throw new HistoryError(503, 'history record body unavailable');
      return {
        id: row.id,
        revision_id: row.revision_id,
        valid_time_status: row.valid_time_status,
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        recorded_from: row.recorded_from,
        recorded_to: row.recorded_to,
        corrects_id: row.corrects_id,
        corrected_by_ids: row.corrected_by_ids,
        thread_id: row.thread_id,
        timestamp: row.source_timestamp,
        text: row.source_text,
        record: JSON.parse(object) as Record<string, unknown>,
        citation: citation(
          row.id,
          row.thread_id,
          row.source_id,
          row.source_timestamp,
        ),
      };
    },

    async asOf(
      owner: string,
      rootId: string,
      validAtInput: unknown,
      recordedAtInput: unknown,
    ): Promise<AsOfResult> {
      if (!SHA256.test(rootId))
        throw new HistoryError(400, 'root_id must be an archive id');
      const validAt = normalizeValidEndpoint(validAtInput);
      const recordedAt = normalizeValidEndpoint(recordedAtInput);
      if (validAt === null || recordedAt === null)
        throw new HistoryError(
          400,
          'as-of query requires valid_at and recorded_at',
        );

      const rootResult = await pool.query<{
        id: string;
        thread_id: string;
        corrects_id: string | null;
      }>(
        `SELECT r.id, r.thread_id, r.corrects_id
         FROM pachigraph.history_records r
         WHERE r.owner_id = $1 AND r.id = $2
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE owner_id = r.owner_id AND thread_id = r.thread_id
           )`,
        [owner, rootId],
      );
      const root = rootResult.rows[0];
      if (!root) throw new HistoryError(404, 'history record not found');
      if (root.corrects_id !== null)
        throw new HistoryError(400, 'root_id must identify a lineage root');

      const lineageResult = await pool.query<{
        id: string;
        revision_id: string;
        thread_id: string;
        source_id: string;
        source_timestamp: string;
        source_text: string;
        object_key: string;
        valid_time_status: 'unknown' | 'known';
        valid_from: string | null;
        valid_to: string | null;
        recorded_from: string;
        recorded_to: string | null;
        corrects_id: string | null;
        is_retraction: boolean;
        depth: number;
      }>(
        `WITH RECURSIVE as_of_lineage AS (
           SELECT r.id, r.revision_id, r.thread_id, r.source_id,
                  r.source_timestamp, r.source_text, r.object_key,
                  r.valid_time_status,
                  to_char(r.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
                  to_char(r.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to,
                  to_char(r.recorded_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_from,
                  to_char(r.recorded_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_to,
                  r.corrects_id, r.is_retraction, 0 AS depth,
                  ARRAY[r.id]::text[] AS path
           FROM pachigraph.history_records r
           WHERE r.owner_id = $1 AND r.thread_id = $2 AND r.id = $3
             AND NOT EXISTS (
               SELECT 1 FROM pachigraph.thread_tombstones
               WHERE owner_id = r.owner_id AND thread_id = r.thread_id
             )
           UNION ALL
           SELECT child.id, child.revision_id, child.thread_id, child.source_id,
                  child.source_timestamp, child.source_text, child.object_key,
                  child.valid_time_status,
                  to_char(child.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
                  to_char(child.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to,
                  to_char(child.recorded_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_from,
                  to_char(child.recorded_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_to,
                  child.corrects_id, child.is_retraction, parent.depth + 1,
                  parent.path || child.id
           FROM pachigraph.history_records child
           JOIN as_of_lineage parent
             ON child.owner_id = $1 AND child.thread_id = parent.thread_id
            AND child.corrects_id = parent.id
           WHERE child.recorded_from <= $4::timestamptz
             AND NOT child.id = ANY(parent.path)
         )
         SELECT id, revision_id, thread_id, source_id, source_timestamp,
                source_text, object_key, valid_time_status, valid_from, valid_to,
                recorded_from, recorded_to, corrects_id, is_retraction, depth
         FROM as_of_lineage
         LIMIT ${MAX_AS_OF_LINEAGE + 1}`,
        [owner, root.thread_id, rootId, recordedAt],
      );
      const lineage = lineageResult.rows;
      if (lineage.length === 0)
        throw new HistoryError(404, 'history record not found');
      const response = {
        root_id: rootId,
        valid_at: validAt,
        recorded_at: recordedAt,
      };
      if (lineage.length > MAX_AS_OF_LINEAGE)
        return {
          ...response,
          status: 'lineage_limit',
          limit: MAX_AS_OF_LINEAGE,
        };

      const isRecordedAt = (row: (typeof lineage)[number]) => {
        const from = normalizeValidEndpoint(row.recorded_from)!;
        const to =
          row.recorded_to === null
            ? null
            : normalizeValidEndpoint(row.recorded_to);
        return from <= recordedAt && (to === null || recordedAt < to);
      };
      const isValidAt = (row: (typeof lineage)[number]) => {
        if (row.valid_time_status === 'unknown') return true;
        const from =
          row.valid_from === null
            ? null
            : normalizeValidEndpoint(row.valid_from);
        const to =
          row.valid_to === null ? null : normalizeValidEndpoint(row.valid_to);
        return (
          (from === null || from <= validAt) && (to === null || validAt < to)
        );
      };
      const visible = lineage.filter(isRecordedAt);
      if (visible.length === 0) return { ...response, status: 'not_known' };
      const eligible = visible.filter(isValidAt);
      if (eligible.length === 0)
        return { ...response, status: 'outside_validity' };

      const byId = new Map(lineage.map((row) => [row.id, row]));
      const eligibleIds = new Set(eligible.map((row) => row.id));
      const superseded = new Set<string>();
      for (const row of eligible) {
        const visited = new Set<string>();
        let parent = row.corrects_id ? byId.get(row.corrects_id) : undefined;
        while (parent && !visited.has(parent.id)) {
          visited.add(parent.id);
          if (eligibleIds.has(parent.id)) superseded.add(parent.id);
          parent = parent.corrects_id
            ? byId.get(parent.corrects_id)
            : undefined;
        }
      }
      const winners = eligible
        .filter((row) => !superseded.has(row.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (winners.length > 1)
        return {
          ...response,
          status: 'ambiguous',
          candidate_ids: winners.map((row) => row.id),
        };
      const winner = winners[0];
      if (!winner) return { ...response, status: 'outside_validity' };
      const object = await objects.getText(winner.object_key);
      if (object === null)
        throw new HistoryError(503, 'history record body unavailable');
      return {
        ...response,
        status:
          winner.valid_time_status === 'unknown'
            ? 'unknown'
            : winner.is_retraction
              ? 'retracted'
              : 'resolved',
        record: {
          id: winner.id,
          revision_id: winner.revision_id,
          thread_id: winner.thread_id,
          timestamp: winner.source_timestamp,
          text: winner.source_text,
          record: JSON.parse(object) as Record<string, unknown>,
          valid_time_status: winner.valid_time_status,
          valid_from: winner.valid_from,
          valid_to: winner.valid_to,
          recorded_from: winner.recorded_from,
          recorded_to: winner.recorded_to,
          corrects_id: winner.corrects_id,
          retracts: winner.is_retraction,
          citation: citation(
            winner.id,
            winner.thread_id,
            winner.source_id,
            winner.source_timestamp,
          ),
        },
      };
    },

    async search(owner: string, query: string) {
      if (typeof query !== 'string' || query.length > 256)
        throw new HistoryError(400, 'query exceeds 256 characters');
      if (!query.match(/[\p{L}\p{N}_]+/u)) return { results: [] };
      const result = await pool.query<{
        id: string;
        thread_id: string;
        source_id: string;
        source_timestamp: string;
        source_text: string;
      }>(
        `WITH query AS (SELECT plainto_tsquery('simple', $2) AS value)
         SELECT r.id, r.thread_id, r.source_id, r.source_timestamp,
                ts_headline(
                  'simple', r.source_text, query.value,
                  'StartSel=, StopSel=, MaxWords=24, MinWords=12'
                ) AS source_text
         FROM pachigraph.history_records r CROSS JOIN query
         WHERE r.owner_id = $1 AND r.search_document @@ query.value
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE owner_id = r.owner_id AND thread_id = r.thread_id
           )
         ORDER BY ts_rank_cd(r.search_document, query.value) DESC,
                  r.source_timestamp DESC
         LIMIT 20`,
        [owner, query],
      );
      return {
        results: result.rows.map((row) => ({
          id: row.id,
          thread_id: row.thread_id,
          timestamp: row.source_timestamp,
          text: row.source_text,
          citation: citation(
            row.id,
            row.thread_id,
            row.source_id,
            row.source_timestamp,
          ),
        })),
      };
    },

    async deleteThread(
      owner: string,
      threadId: string,
    ): Promise<{ deleted: true }> {
      if (!UUID.test(threadId))
        throw new HistoryError(400, 'threadId must be a UUID');
      await transaction(pool, async (client) => {
        await lockThread(client, owner, threadId);
        await client.query(
          `INSERT INTO pachigraph.thread_tombstones (owner_id, thread_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [owner, threadId],
        );
        await client.query(
          `DELETE FROM pachigraph.history_records
           WHERE owner_id = $1 AND thread_id = $2`,
          [owner, threadId],
        );
      });
      await objects.deletePrefix(`${digest(owner)}/${threadId}/`);
      return { deleted: true };
    },

    async status(owner: string) {
      const result = await pool.query<{
        threads: string;
        records: string;
        text_bytes: string;
        last_ingested_at: string | null;
      }>(
        `SELECT COUNT(DISTINCT thread_id) AS threads,
                COUNT(*) AS records,
                COALESCE(SUM(text_bytes), 0) AS text_bytes,
                MAX(ingested_at) AS last_ingested_at
         FROM pachigraph.history_records r
         WHERE owner_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE owner_id = r.owner_id AND thread_id = r.thread_id
           )`,
        [owner],
      );
      const row = result.rows[0];
      return {
        threads: Number(row.threads),
        records: Number(row.records),
        text_bytes: Number(row.text_bytes),
        last_ingested_at: row.last_ingested_at,
      };
    },
  };
}

export async function databaseAllocation(pool: Pool) {
  const result = await pool.query<{ database_bytes: string }>(`
    SELECT COALESCE(SUM(pg_total_relation_size(class.oid)), 0)::bigint AS database_bytes
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'pachigraph' AND class.relkind = 'r'
  `);
  return { database_bytes: Number(result.rows[0].database_bytes) };
}
