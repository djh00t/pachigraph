ALTER TABLE pachigraph.history_records
  ADD COLUMN valid_time_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN valid_from TIMESTAMPTZ,
  ADD COLUMN valid_to TIMESTAMPTZ,
  ADD COLUMN recorded_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN recorded_to TIMESTAMPTZ;

UPDATE pachigraph.history_records
SET recorded_from = ingested_at::timestamptz;

ALTER TABLE pachigraph.history_records
  ALTER COLUMN recorded_from SET NOT NULL,
  ADD CONSTRAINT history_records_valid_time_status
    CHECK (valid_time_status IN ('unknown', 'known')),
  ADD CONSTRAINT history_records_valid_time_shape
    CHECK (
      (valid_time_status = 'unknown' AND valid_from IS NULL AND valid_to IS NULL)
      OR valid_time_status = 'known'
    ),
  ADD CONSTRAINT history_records_valid_time_order
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to),
  ADD CONSTRAINT history_records_recorded_time_order
    CHECK (recorded_to IS NULL OR recorded_from < recorded_to);
