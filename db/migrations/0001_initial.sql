CREATE TABLE pachigraph.api_keys (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX api_keys_owner_expires
  ON pachigraph.api_keys (owner_id, expires_at DESC);

CREATE TABLE pachigraph.thread_tombstones (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, thread_id)
);

CREATE TABLE pachigraph.history_records (
  row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  source_text TEXT NOT NULL,
  text_bytes BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', source_text)
  ) STORED,
  CONSTRAINT history_records_revision UNIQUE (
    owner_id, thread_id, source_id, revision_id
  ),
  CONSTRAINT history_records_owner_id_id UNIQUE (owner_id, id)
);

CREATE INDEX history_records_thread
  ON pachigraph.history_records (owner_id, thread_id);

CREATE INDEX history_records_search
  ON pachigraph.history_records USING GIN (search_document);
