ALTER TABLE pachigraph.history_records
  ADD COLUMN corrects_id TEXT,
  ADD CONSTRAINT history_records_owner_thread_id
    UNIQUE (owner_id, thread_id, id),
  ADD CONSTRAINT history_records_not_self_corrected
    CHECK (corrects_id IS NULL OR corrects_id <> id),
  ADD CONSTRAINT history_records_correction_predecessor
    FOREIGN KEY (owner_id, thread_id, corrects_id)
    REFERENCES pachigraph.history_records (owner_id, thread_id, id);

CREATE INDEX history_records_corrections
  ON pachigraph.history_records (owner_id, thread_id, corrects_id)
  WHERE corrects_id IS NOT NULL;
