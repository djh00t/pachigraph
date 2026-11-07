ALTER TABLE pachigraph.history_records
  ADD COLUMN is_retraction BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT history_records_retraction_contract
    CHECK (
      NOT is_retraction
      OR (corrects_id IS NOT NULL AND valid_time_status = 'known')
    );
