import { sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const threadTombstones = sqliteTable(
  'thread_tombstones',
  {
    ownerId: text('owner_id').notNull(),
    threadId: text('thread_id').notNull(),
    deletedAt: text('deleted_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.threadId] })],
);

export const historyRecords = sqliteTable(
  'history_records',
  {
    rowId: integer('rowid').primaryKey({ autoIncrement: true }),
    ownerId: text('owner_id').notNull(),
    threadId: text('thread_id').notNull(),
    sourceId: text('source_id').notNull(),
    revisionId: text('revision_id').notNull(),
    id: text('id').notNull(),
    sourceTimestamp: text('source_timestamp').notNull(),
    sourceText: text('source_text').notNull(),
    textBytes: integer('text_bytes').notNull(),
    r2Key: text('r2_key').notNull(),
    ingestedAt: text('ingested_at').notNull(),
  },
  (table) => [
    uniqueIndex('history_records_revision').on(
      table.ownerId,
      table.threadId,
      table.sourceId,
      table.revisionId,
    ),
    uniqueIndex('history_records_owner_id_id').on(table.ownerId, table.id),
  ],
);
