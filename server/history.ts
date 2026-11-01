import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TenantId } from './auth.ts';
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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validate(
  tenant: TenantId,
  input: unknown,
): asserts input is IngestInput {
  if (!tenant) throw new HistoryError(400, 'tenant is required');
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
    const serialized = `{"id":${JSON.stringify(item.id)},"record":${canonical(item.record)},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`;
    if (Buffer.byteLength(serialized) > 384 * 1024) {
      throw new HistoryError(413, 'record exceeds 384 KiB');
    }
  }
}

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isChatGptThread(threadId: string) {
  return UUID_V5.test(threadId);
}

function citation(
  id: string,
  threadId: string,
  sourceId: string,
  timestamp: string,
): string {
  if (isChatGptThread(threadId)) {
    return `ChatGPT conversation ${threadId}, event ${sourceId}, ${timestamp}; /?id=${id}`;
  }
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

async function lockThread(
  client: PoolClient,
  tenant: TenantId,
  threadId: string,
) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\n' || $2, 0))",
    [tenant, threadId],
  );
}

function prefixFromObjectKey(objectKey: string) {
  const parts = objectKey.split('/').filter((part) => part.length > 0);
  if (parts.length < 3)
    return objectKey.endsWith('/') ? objectKey : `${objectKey}/`;
  return `${parts.slice(0, -2).join('/')}/`;
}

export async function retryPendingDeletes(
  pool: Pool,
  objects: Pick<Objects, 'deletePrefix'>,
  tenant?: TenantId,
) {
  const result = await pool.query<{
    tenant_id: string;
    thread_id: string;
    prefix: string;
  }>(
    `SELECT tenant_id, thread_id, prefix
     FROM pachigraph.pending_deletes
     WHERE ($1::text IS NULL OR tenant_id = $1)`,
    [tenant ?? null],
  );
  let failed = 0;
  for (const row of result.rows) {
    try {
      await objects.deletePrefix(row.prefix);
      await pool.query(
        `DELETE FROM pachigraph.pending_deletes
         WHERE tenant_id = $1 AND thread_id = $2 AND prefix = $3`,
        [row.tenant_id, row.thread_id, row.prefix],
      );
    } catch {
      failed += 1;
    }
  }
  if (failed > 0)
    console.error(`pending_deletes cleanup failed count=${failed}`);
}

export function createHistory(
  pool: Pool,
  objects: Pick<Objects, 'putImmutable' | 'getText' | 'deletePrefix'>,
) {
  return {
    async ingest(
      tenant: TenantId,
      input: unknown,
    ): Promise<{ stored: number; duplicate: number }> {
      validate(tenant, input);
      const tenantHash = digest(tenant);
      const records = input.records.map((item) => {
        const record = canonical(item.record);
        const envelope = `{"id":${JSON.stringify(item.id)},"record":${record},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`;
        const revision = digest(
          `{"record":${record},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`,
        );
        return {
          item,
          record,
          revision,
          storedBytes: Buffer.byteLength(envelope),
          id: digest(`${tenant}\n${input.thread_id}\n${item.id}\n${revision}`),
          key: `t/${tenantHash}/${input.thread_id}/${item.id}/${revision}`,
        };
      });

      return transaction(pool, async (client) => {
        await lockThread(client, tenant, input.thread_id);
        const tombstone = await client.query(
          `SELECT 1 FROM pachigraph.thread_tombstones
           WHERE tenant_id = $1 AND thread_id = $2`,
          [tenant, input.thread_id],
        );
        if (tombstone.rowCount)
          throw new HistoryError(410, 'history was deleted');

        const existing = await client.query<{
          source_id: string;
          revision_id: string;
        }>(
          `SELECT source_id, revision_id
           FROM pachigraph.history_records
           WHERE tenant_id = $1 AND thread_id = $2
             AND (source_id, revision_id) IN (
               SELECT * FROM unnest($3::text[], $4::text[])
             )`,
          [
            tenant,
            input.thread_id,
            records.map((record) => record.item.id),
            records.map((record) => record.revision),
          ],
        );
        const seen = new Set(
          existing.rows.map((row) => `${row.source_id}\n${row.revision_id}`),
        );
        const fresh = [];
        for (const record of records) {
          const key = `${record.item.id}\n${record.revision}`;
          if (seen.has(key)) continue;
          seen.add(key);
          fresh.push(record);
        }
        const usage = await client.query<{
          records: string;
          bytes: string;
          max_records: string;
          max_bytes: string;
        }>(
          `SELECT u.records::text, u.bytes::text,
                  t.max_records::text, t.max_bytes::text
           FROM pachigraph.tenant_usage u
           JOIN pachigraph.tenants t ON t.id = u.tenant_id
           WHERE u.tenant_id = $1
           FOR UPDATE OF u`,
          [tenant],
        );
        const quota = usage.rows[0];
        if (!quota) throw new HistoryError(503, 'quota unavailable');
        const addBytes = fresh.reduce(
          (sum, record) => sum + record.storedBytes,
          0,
        );
        if (
          Number(quota.records) + fresh.length > Number(quota.max_records) ||
          Number(quota.bytes) + addBytes > Number(quota.max_bytes)
        ) {
          throw new HistoryError(507, 'Storage quota exceeded');
        }

        let stored = 0;
        let storedBytes = 0;
        for (const record of fresh) {
          // The object is the canonical record, including redaction
          // fingerprints. stored_bytes counts the envelope.
          await objects.putImmutable(record.key, record.record);
          const result = await client.query(
            `INSERT INTO pachigraph.history_records
               (tenant_id, thread_id, source_id, revision_id, id,
                source_timestamp, source_text, text_bytes, stored_bytes,
                object_key, ingested_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (tenant_id, thread_id, source_id, revision_id) DO NOTHING`,
            [
              tenant,
              input.thread_id,
              record.item.id,
              record.revision,
              record.id,
              record.item.timestamp,
              record.item.text,
              Buffer.byteLength(record.item.text),
              record.storedBytes,
              record.key,
              new Date().toISOString(),
            ],
          );
          if (result.rowCount) {
            stored += result.rowCount;
            storedBytes += record.storedBytes;
          }
        }
        if (stored) {
          await client.query(
            `UPDATE pachigraph.tenant_usage
             SET records = records + $2, bytes = bytes + $3
             WHERE tenant_id = $1`,
            [tenant, stored, storedBytes],
          );
        }
        return { stored, duplicate: records.length - stored };
      });
    },

    async fetch(tenant: TenantId, id: string) {
      const result = await pool.query<{
        id: string;
        thread_id: string;
        source_id: string;
        source_timestamp: string;
        source_text: string;
        object_key: string;
      }>(
        `SELECT id, thread_id, source_id, source_timestamp, source_text, object_key
         FROM pachigraph.history_records r
         WHERE tenant_id = $1 AND id = $2
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE tenant_id = r.tenant_id AND thread_id = r.thread_id
           )`,
        [tenant, id],
      );
      const row = result.rows[0];
      if (!row) throw new HistoryError(404, 'history record not found');
      const object = await objects.getText(row.object_key);
      if (object === null)
        throw new HistoryError(404, 'history record body not found');
      return {
        id: row.id,
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

    async search(tenant: TenantId, query: string) {
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
         WHERE r.tenant_id = $1 AND r.search_document @@ query.value
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE tenant_id = r.tenant_id AND thread_id = r.thread_id
           )
         ORDER BY ts_rank_cd(r.search_document, query.value) DESC,
                  r.source_timestamp DESC
         LIMIT 20`,
        [tenant, query],
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
      tenant: TenantId,
      threadId: string,
    ): Promise<{ deleted: true }> {
      if (!UUID.test(threadId))
        throw new HistoryError(400, 'threadId must be a UUID');
      await retryPendingDeletes(pool, objects, tenant);
      await transaction(pool, async (client) => {
        await lockThread(client, tenant, threadId);
        await client.query(
          `SELECT records FROM pachigraph.tenant_usage
           WHERE tenant_id = $1 FOR UPDATE`,
          [tenant],
        );
        const existing = await client.query<{
          object_key: string;
          stored_bytes: string;
        }>(
          `SELECT object_key, stored_bytes::text
           FROM pachigraph.history_records
           WHERE tenant_id = $1 AND thread_id = $2`,
          [tenant, threadId],
        );
        const prefixes = new Set<string>([`t/${digest(tenant)}/${threadId}/`]);
        for (const row of existing.rows)
          prefixes.add(prefixFromObjectKey(row.object_key));
        for (const prefix of prefixes) {
          await client.query(
            `INSERT INTO pachigraph.pending_deletes
               (tenant_id, thread_id, prefix)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [tenant, threadId, prefix],
          );
        }
        await client.query(
          `DELETE FROM pachigraph.history_records
           WHERE tenant_id = $1 AND thread_id = $2`,
          [tenant, threadId],
        );
        await client.query(
          `INSERT INTO pachigraph.thread_tombstones (tenant_id, thread_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [tenant, threadId],
        );
        const removedBytes = existing.rows.reduce(
          (sum, row) => sum + Number(row.stored_bytes),
          0,
        );
        await client.query(
          `UPDATE pachigraph.tenant_usage
           SET records = records - $2, bytes = bytes - $3
           WHERE tenant_id = $1`,
          [tenant, existing.rows.length, removedBytes],
        );
      });
      await retryPendingDeletes(pool, objects, tenant);
      return { deleted: true };
    },

    async status(tenant: TenantId) {
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
         WHERE tenant_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM pachigraph.thread_tombstones
             WHERE tenant_id = r.tenant_id AND thread_id = r.thread_id
           )`,
        [tenant],
      );
      const pending = await pool.query<{ pending_deletes: string }>(
        `SELECT count(*)::text AS pending_deletes
         FROM pachigraph.pending_deletes WHERE tenant_id = $1`,
        [tenant],
      );
      const row = result.rows[0];
      return {
        threads: Number(row.threads),
        records: Number(row.records),
        text_bytes: Number(row.text_bytes),
        last_ingested_at: row.last_ingested_at,
        pending_deletes: Number(pending.rows[0].pending_deletes),
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
