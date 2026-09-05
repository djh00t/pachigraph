# Codex session collector

This standalone Python 3 collector reads regular, non-symlink `.jsonl` files
below `~/.codex/sessions` and `~/.codex/archived_sessions`, sanitizes every
decoded string and dictionary key with the installed
`/opt/homebrew/bin/gitleaks`, and uploads bounded batches to
`<url>/api/ingest`. Batches stop at 100 records or 512 KiB, whichever comes
first, and records without a timezone-qualified ISO timestamp become pending
gaps. Timestamps use the server-compatible `T` separator, optional fractional
seconds, and an explicit `Z` or numeric offset. JSON values may nest to depth 64
(the record object is depth 0); deeper records become pending gaps. It never
modifies source files. A local SQLite checkpoint
advances only after an upload is acknowledged or a skipped input is recorded
as an explicit pending gap.

```sh
python3 collector.py collect --codex-home ~/.codex \
  --url https://collector.example --token-file ~/.config/codex/token \
  --state ~/.codex/collector.sqlite3
```

Use `--dry-run` to scan and report counters without making HTTP requests, or
`--limit-threads N` to take a deterministic path-ordered sample. Repeat
`--file /absolute/path/to/session.jsonl` to select exact files; each file must
remain inside one of the two session roots. Token files must be owned by the
current user, be regular non-symlink files, and have mode exactly `0600`.
Live non-local uploads require a token. HTTPS is required except for localhost
HTTP test servers. Redirects are refused. A 410 response tombstones that
thread in the local state.

Normal runs verify the SHA-256 digest of each previously checkpointed byte
prefix. Unchanged records bypass Gitleaks; an append scans only its new complete
records, while any edit to the old prefix forces a full scan. This still reads
the old bytes for hashing, but avoids two Gitleaks processes per unchanged
record. Use `--backfill` (also `--rescan`) to retry pending malformed,
oversized, or otherwise skipped records. Backfills checkpoint acknowledged
batches and resume after interruption; a completed backfill with pending gaps
starts another retry pass when invoked again. The JSON summary reports both
gaps seen during the run and the total `pending_gaps` retained in SQLite.
Occurrence counters used for fallback record IDs are updated incrementally in
the same SQLite transaction as each acknowledged checkpoint.

The 384 KiB per-record ceiling is an explicit MVP limit, including the exact
boundary value. Malformed records, non-finite JSON numbers, records above that
ceiling, and other skipped inputs remain tracked for backfill. The CLI prints
only safe counters and exits nonzero whenever gaps
remain. A complete archive run therefore requires both `gaps` and
`pending_gaps` to be zero.

Gitleaks recursively decodes common encodings to a depth of three. If it finds
an encoded secret that cannot be mapped back to an exact decoded JSON string,
the collector fails closed without uploading or advancing that batch.

Generate a launchd plist with no token contents embedded:

```sh
python3 collector.py launchd --codex-home ~/.codex \
  --url https://collector.example --state ~/.codex/collector.sqlite3 \
  --token-file ~/.config/codex/token --output codex-collector.plist
```

The plist is only installed when `--install` is explicitly supplied.
