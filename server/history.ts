/// <reference types="@cloudflare/workers-types" />

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const encoder = new TextEncoder();

export type InputRecord = {
  id: string;
  timestamp: string;
  text: string;
  record: Record<string, unknown>;
};

export type IngestInput = { thread_id: string; records: InputRecord[] };

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

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
      !SHA256.test(item?.id ?? '') ||
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
    const canonicalRecord = canonical(item.record);
    const serialized = `{"id":${JSON.stringify(item.id)},"record":${canonicalRecord},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`;
    if (encoder.encode(serialized).byteLength > 384 * 1024) {
      throw new HistoryError(413, 'record exceeds 384 KiB');
    }
  }
}

function citation(
  id: string,
  threadId: string,
  sourceId: string,
  timestamp: string,
): string {
  return `Codex thread ${threadId}, event ${sourceId}, ${timestamp}; /?id=${id}; codex://threads/${threadId}#${sourceId}`;
}

function literalMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  return (
    tokens?.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ') ??
    null
  );
}

export function createHistory(db: D1Database, bucket: R2Bucket) {
  async function tombstoned(owner: string, threadId: string): Promise<boolean> {
    const row = await db
      .prepare(
        `SELECT 1 AS found FROM thread_tombstones WHERE owner_id = ? AND thread_id = ? LIMIT 1`,
      )
      .bind(owner, threadId)
      .first();
    return row !== null;
  }

  return {
    async ingest(
      owner: string,
      input: unknown,
    ): Promise<{ stored: number; duplicate: number }> {
      validate(owner, input);
      let stored = 0;
      let duplicate = 0;
      const ownerHash = await digest(owner);
      if (await tombstoned(owner, input.thread_id))
        throw new HistoryError(410, 'history was deleted');

      for (const item of input.records) {
        const canonicalRecord = canonical(item.record);
        const revision = await digest(
          canonical({
            record: item.record,
            text: item.text,
            timestamp: item.timestamp,
          }),
        );
        const id = await digest(
          `${owner}\n${input.thread_id}\n${item.id}\n${revision}`,
        );
        const key = `${ownerHash}/${input.thread_id}/${item.id}/${revision}`;
        await bucket.put(key, canonicalRecord, {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        const ingestedAt = new Date().toISOString();
        const result = await db
          .prepare(
            `INSERT OR IGNORE INTO history_records
                 (owner_id, thread_id, source_id, revision_id, id, source_timestamp, source_text, text_bytes, r2_key, ingested_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM thread_tombstones WHERE owner_id = ? AND thread_id = ?)`,
          )
          .bind(
            owner,
            input.thread_id,
            item.id,
            revision,
            id,
            item.timestamp,
            item.text,
            encoder.encode(item.text).byteLength,
            key,
            ingestedAt,
            owner,
            input.thread_id,
          )
          .run();
        if (await tombstoned(owner, input.thread_id)) {
          await bucket.delete(key);
          throw new HistoryError(410, 'history was deleted');
        }
        if ((result.meta.changes ?? 0) > 0) {
          stored += 1;
        } else {
          duplicate += 1;
        }
      }
      return { stored, duplicate };
    },

    async fetch(owner: string, id: string) {
      const row = await db
        .prepare(
          `SELECT id, thread_id, source_id, source_timestamp, source_text, r2_key
           FROM history_records r WHERE owner_id = ? AND id = ?
             AND NOT EXISTS (
               SELECT 1 FROM thread_tombstones
               WHERE owner_id = r.owner_id AND thread_id = r.thread_id
             )`,
        )
        .bind(owner, id)
        .first<{
          id: string;
          thread_id: string;
          source_id: string;
          source_timestamp: string;
          source_text: string;
          r2_key: string;
        }>();
      if (!row) throw new HistoryError(404, 'history record not found');
      const object = await bucket.get(row.r2_key);
      if (!object) throw new HistoryError(404, 'history record body not found');
      return {
        id: row.id,
        thread_id: row.thread_id,
        timestamp: row.source_timestamp,
        text: row.source_text,
        record: JSON.parse(await object.text()) as Record<string, unknown>,
        citation: citation(
          row.id,
          row.thread_id,
          row.source_id,
          row.source_timestamp,
        ),
      };
    },

    async search(owner: string, query: string) {
      if (typeof query !== 'string' || query.length > 256)
        throw new HistoryError(400, 'query exceeds 256 characters');
      const match = literalMatch(query);
      if (!match) return { results: [] };
      const { results } = await db
        .prepare(
          `SELECT r.id, r.thread_id, r.source_id, r.source_timestamp,
                  snippet(history_fts, 0, '', '', ' ... ', 24) AS source_text
           FROM history_fts JOIN history_records r
             ON r.rowid = history_fts.rowid
           WHERE history_fts MATCH ? AND r.owner_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM thread_tombstones
               WHERE owner_id = r.owner_id AND thread_id = r.thread_id
             )
           ORDER BY bm25(history_fts), r.source_timestamp DESC LIMIT 20`,
        )
        .bind(match, owner)
        .all<{
          id: string;
          thread_id: string;
          source_id: string;
          source_timestamp: string;
          source_text: string;
        }>();
      return {
        results: results.map((row) => ({
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
      await db
        .prepare(
          'INSERT OR IGNORE INTO thread_tombstones(owner_id, thread_id, deleted_at) VALUES (?, ?, ?)',
        )
        .bind(owner, threadId, new Date().toISOString())
        .run();
      await db
        .prepare(
          'DELETE FROM history_records WHERE owner_id = ? AND thread_id = ?',
        )
        .bind(owner, threadId)
        .run();
      const prefix = `${await digest(owner)}/${threadId}/`;
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        if (page.objects.length)
          await bucket.delete(page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { deleted: true };
    },

    async status(owner: string) {
      const row = await db
        .prepare(
          `SELECT COUNT(DISTINCT thread_id) AS threads, COUNT(*) AS records,
                  COALESCE(SUM(text_bytes), 0) AS text_bytes, MAX(ingested_at) AS last_ingested_at
           FROM history_records r WHERE owner_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM thread_tombstones
               WHERE owner_id = r.owner_id AND thread_id = r.thread_id
             )`,
        )
        .bind(owner)
        .first<{
          threads: number;
          records: number;
          text_bytes: number;
          last_ingested_at: string | null;
        }>();
      return row!;
    },
  };
}
