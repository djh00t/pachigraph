CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Default quota constants: 1,000,000 records and 10 GiB.
-- The operator CLI quota command changes these per tenant.

CREATE TABLE pachigraph.tenants (
  id TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT true,
  max_records BIGINT NOT NULL,
  max_bytes BIGINT NOT NULL,
  CONSTRAINT tenants_id_format CHECK (id ~ '^t-[0-9a-f]{16}$')
);

CREATE TABLE pachigraph.tenant_members (
  subject TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES pachigraph.tenants (id),
  CONSTRAINT tenant_members_tenant_id_len CHECK (length(trim(tenant_id)) > 0)
);

CREATE TABLE pachigraph.tenant_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES pachigraph.tenants (id),
  records BIGINT NOT NULL,
  bytes BIGINT NOT NULL
);

CREATE TABLE pachigraph.pending_deletes (
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, thread_id, prefix),
  CONSTRAINT pending_deletes_tenant_id_len CHECK (length(trim(tenant_id)) > 0)
);

ALTER TABLE pachigraph.history_records ADD COLUMN tenant_id TEXT;
ALTER TABLE pachigraph.history_records ADD COLUMN stored_bytes BIGINT;
ALTER TABLE pachigraph.thread_tombstones ADD COLUMN tenant_id TEXT;
ALTER TABLE pachigraph.api_keys ADD COLUMN tenant_id TEXT;

DO $$
DECLARE
  default_max_records CONSTANT bigint := 1000000;
  default_max_bytes CONSTANT bigint := 10737418240;
  owner text;
  new_id text;
BEGIN
  FOR owner IN
    SELECT DISTINCT owner_id FROM (
      SELECT owner_id FROM pachigraph.history_records
      UNION
      SELECT owner_id FROM pachigraph.thread_tombstones
      UNION
      SELECT owner_id FROM pachigraph.api_keys
    ) owners
  LOOP
    new_id := 't-' || left(replace(gen_random_uuid()::text, '-', ''), 16);
    INSERT INTO pachigraph.tenants (id, active, max_records, max_bytes)
    VALUES (new_id, true, default_max_records, default_max_bytes);
    INSERT INTO pachigraph.tenant_members (subject, tenant_id)
    VALUES (owner, new_id);
    UPDATE pachigraph.history_records SET tenant_id = new_id WHERE owner_id = owner;
    UPDATE pachigraph.thread_tombstones SET tenant_id = new_id WHERE owner_id = owner;
    UPDATE pachigraph.api_keys SET tenant_id = new_id WHERE owner_id = owner;
  END LOOP;
END $$;

UPDATE pachigraph.history_records SET stored_bytes = text_bytes;

INSERT INTO pachigraph.tenant_usage (tenant_id, records, bytes)
SELECT t.id,
       COALESCE(c.records, 0),
       COALESCE(c.bytes, 0)
FROM pachigraph.tenants t
LEFT JOIN (
  SELECT tenant_id,
         count(*)::bigint AS records,
         COALESCE(sum(stored_bytes), 0)::bigint AS bytes
  FROM pachigraph.history_records
  GROUP BY tenant_id
) c ON c.tenant_id = t.id;

-- Seed while thread_tombstones.owner_id still exists. The prefix is the
-- legacy object prefix sha256(owner)/thread/.
INSERT INTO pachigraph.pending_deletes (tenant_id, thread_id, prefix)
SELECT tenant_id,
       thread_id,
       encode(sha256(convert_to(owner_id, 'UTF8')), 'hex') || '/' || thread_id || '/'
FROM pachigraph.thread_tombstones;

ALTER TABLE pachigraph.history_records
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN stored_bytes SET NOT NULL;
ALTER TABLE pachigraph.history_records
  ADD CONSTRAINT history_records_tenant_id_len CHECK (length(trim(tenant_id)) > 0);
ALTER TABLE pachigraph.history_records DROP CONSTRAINT history_records_revision;
ALTER TABLE pachigraph.history_records DROP CONSTRAINT history_records_owner_id_id;
DROP INDEX pachigraph.history_records_thread;
ALTER TABLE pachigraph.history_records
  ADD CONSTRAINT history_records_revision
  UNIQUE (tenant_id, thread_id, source_id, revision_id);
ALTER TABLE pachigraph.history_records
  ADD CONSTRAINT history_records_tenant_id_id UNIQUE (tenant_id, id);
CREATE INDEX history_records_thread
  ON pachigraph.history_records (tenant_id, thread_id);
ALTER TABLE pachigraph.history_records DROP COLUMN owner_id;

ALTER TABLE pachigraph.thread_tombstones ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pachigraph.thread_tombstones
  ADD CONSTRAINT thread_tombstones_tenant_id_len CHECK (length(trim(tenant_id)) > 0);
ALTER TABLE pachigraph.thread_tombstones DROP CONSTRAINT thread_tombstones_pkey;
ALTER TABLE pachigraph.thread_tombstones
  ADD PRIMARY KEY (tenant_id, thread_id);
ALTER TABLE pachigraph.thread_tombstones DROP COLUMN owner_id;

ALTER TABLE pachigraph.api_keys ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pachigraph.api_keys
  ADD CONSTRAINT api_keys_tenant_id_len CHECK (length(trim(tenant_id)) > 0);
DROP INDEX pachigraph.api_keys_owner_expires;
CREATE INDEX api_keys_tenant_expires
  ON pachigraph.api_keys (tenant_id, expires_at);
