CREATE VIRTUAL TABLE history_fts USING fts5(
  source_text,
  content = 'history_records',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);
--> statement-breakpoint
CREATE TRIGGER history_records_fts_insert AFTER INSERT ON history_records BEGIN
  INSERT INTO history_fts(rowid, source_text) VALUES (new.rowid, new.source_text);
END;
--> statement-breakpoint
CREATE TRIGGER history_records_fts_delete AFTER DELETE ON history_records BEGIN
  INSERT INTO history_fts(history_fts, rowid, source_text)
  VALUES ('delete', old.rowid, old.source_text);
END;
