# OpenAI export import

ChatGPT conversations only, active path only. The collector reads a zip on the
owner's machine and uploads redacted records. The verbatim original of a found
secret stays in a local quarantine file on that machine. The server stores the
redacted text and, when a secret was found, `record.redactions` entries of
`rule`, `path` and `fp`. It does not store the secret.

Placeholders in the commands below are not real hosts, paths, or token files.

## Prerequisites

- The laptop disk is encrypted. The collector cannot check that.
- Tenancy is deployed and requalified. Cross-tenant checks have been run.
- An ingest key is in a mode `0600` file `<token-file>`.
- `<state>` is an explicit path. There is no default under a home directory.
- `<zip>` is the export archive. `<pachigraph-url>` is the server origin.

Record the database size before deploying migration `0002`, using the queries
in the T11 section, where database access already lives.

## T8 dry run

Do this only with the owner's yes. Nothing is uploaded. Port 9 is closed, so a
network call fails the run.

```
python3 collector/collector.py openai-export --zip <zip> --dry-run --url http://127.0.0.1:9 --state <state>
```

Expected: exit 0, even when gap counters are non-zero. One JSON line of
counters only, including `uploads` (0), `oversized`, `no_timestamp`, `hidden`,
`quarantined`, `non_finite`, `side_branch`, `secs`, `records_per_sec` and
`peak_rss_mib`. No state file and no `<state>.quarantine` file are created.

Keep that counters line as the only evidence. If `oversized` is greater than
0, the gated chunker work can start. Otherwise it is not needed.

## Approval gate

Stop here until the owner approves a real import. A dry run is not approval.
Do not upload, and do not paste message text, titles, ids, or secrets into an
issue, a pull request, or a log.

## T9 import and verify

After tenancy is deployed and requalified, import 3 synthetic threads and 3
owner-approved threads:

```
python3 collector/collector.py openai-export --zip <zip> --url <pachigraph-url> --token-file <token-file> --state <state>
```

Then, with a read key, call MCP `search` and MCP `fetch` for one imported
thread. Expected: a hit is returned, and `fetch` returns the same revision id.
The citation has no `codex://`. The thread page shows "Imported from a ChatGPT
export" and no `codex://` link.

## T10 identity and permanent delete

1. Import the synthetic canary thread.
2. From the `collector/` directory, compute the thread id locally:

```
python3 -c "import oe_identity as i; print(i.thread_id('<synthetic conversation id>'))"
```

3. Delete it from the owner's browser session with a same-origin
   `DELETE /api/thread?id=<thread_id>`. A thread delete is permanent. It is
   never a step in a repair, refresh, or re-import. There is no untombstone.
4. Rerun with a fresh `<state>` after purging the quarantine store (or moving
   it away first), as described in the fresh-state section.
   Expected: 410, `tombstoned` 1, exit 0. The thread is not restored.
5. Rerun with that same state. Expected: `uploads` 0 and no request for that
   thread.

## T11 counts

Run where the server's database read access already lives, not on the owner's
machine. Run before deploying `0002`, and again before and after the import.
Numbers go to the owner only. They do not go into this repository.

```
SELECT c.relname, pg_total_relation_size(c.oid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'pachigraph' AND c.relkind IN ('r', 'i');
```

```
SELECT count(*) FROM pachigraph.history_records;
```

Object-store listing, where that access already lives, last two summary lines
only. Do not copy the listing into this repository.

## T12 canary check

After importing a synthetic canary thread that includes a hidden message and a
runtime-assembled fake secret:

```
rg -c "$CANARY" <log dir> <evidence dir>
rg -c "$FAKE_SECRET" <log dir> <evidence dir>
```

Expected: no output (exit 1) for both. A read-key fetch of the record, checked
in memory, contains `[REDACTED]` and not the fake secret. Do not write the
fetch body down.

## Local quarantine

The store is `<state>.quarantine`, mode `0600`, next to `<state>`. The
directory must be owned by the current user and not writable by group or
others. These commands are interactive and local. Their output is never pasted
anywhere.

```
python3 collector/collector.py openai-export --state <state> quarantine list
python3 collector/collector.py openai-export --state <state> quarantine show <n> --reveal
python3 collector/collector.py openai-export --state <state> quarantine purge --older-than <days>
python3 collector/collector.py openai-export --state <state> quarantine purge --thread <thread_id>
python3 collector/collector.py openai-export --state <state> quarantine purge --all
```

`list` prints age, rule, path, fingerprint and thread id. It does not print
the secret. `show <n> --reveal` prints one original only when stdout is a
terminal and `--reveal` is set. It refuses otherwise.

Retention is `--quarantine-days` (default 30, allowed 1–365). Every real run
purges expired items first.

Rotate the credential, then purge the quarantine item. Do not purge first and
leave the credential in place.

## Fresh state

A fresh `<state>` creates a new `finding_key`. Nodes with findings are
uploaded again as new revisions. Nodes without findings stay duplicates. That
churn is accepted. There is no clean-copy procedure in v1. Earlier revisions
stay readable. Never delete a thread to tidy revisions.

If `<state>.quarantine` exists and `<state>` does not, the collector exits 7
before reading the zip. Remove the old store before any fresh `<state>`. Either
purge it:

```
python3 collector/collector.py openai-export --state <state> quarantine purge --all
```

or move the store away first. The purge works when the state file is already
gone, removes the quarantine store, and does not create one. Then a fresh run
succeeds. Use a fresh state only when a scanner upgrade makes a re-scan worth
the churn.

## Cleanup

Remove the local zip, the state file, and the quarantine file when the owner
says the import is finished and the secrets have been rotated. Do not delete
the thread on the server to finish cleanup.
