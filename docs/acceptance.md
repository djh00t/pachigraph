# MVP acceptance record

This record separates local implementation evidence from live qualification and
human acceptance. It is deliberately a table, not workflow software.

| State               | Entry condition                          | Exit evidence                                                    | Current              |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| Implementing        | Approved minimal scope                   | Collector, Site, plugin sources and focused tests                | Active               |
| Local verified      | Integrated code                          | `make check`, production build, synthetic end-to-end checks      | Pending              |
| Platform qualified  | Private publication authorized           | Native OAuth identity reaches both MCP and HTTP; D1/R2 available | Pending              |
| Sample verified     | Platform qualified                       | Representative active, archived, long sample passes checks below | Pending              |
| Awaiting acceptance | Evidence and limitations presented       | User explicitly accepts, defers, or rejects                      | Pending              |
| Accepted            | User acceptance recorded                 | Remaining archive and daily collection may proceed as authorized | Pending              |
| Deferred / rejected | User decision or unsupported requirement | Record reason and next decision; no bulk import                  | Available transition |

## Required proof

- Exact replay changes neither logical record count nor source revisions.
- Appends and backfills preserve prior revisions; interrupted batches resume.
- Known secret fixtures never reach network bodies, R2, D1/FTS, results or logs.
- Another owner's ID, query parameters and delete requests cannot expose or erase
  the first owner's evidence.
- Deletion leaves a tombstone even if cleanup fails; retry completes cleanup and
  attempted re-ingestion returns 410.
- Search finds a known distinctive passage with the correct original conversation,
  source record and timestamp. Record p50/p95 and corpus size, not just pass/fail.
- Measure actual D1 size (including FTS) before the sample and after it. Extrapolate
  against the current Sites capacity before allowing bulk ingestion.
- Prove authenticated CLI and MCP access use the same native owner. Local tests
  that inject an owner do not satisfy this check.

## Current platform evidence

On 2026-09-05, the Pachigraph Site was published privately at
https://pachigraph.djh00t.chatgpt.site. Native Sites deployment reported success.
Anonymous requests to `/api/status` and `/mcp` were rejected with HTTP 403.

The initial native MCP connection request reported that the published Site does
not declare an MCP server. The requested `mcp` capability is now included in the
hosting manifest for platform verification. Native authenticated access remains
unverified until Sites supplies connection details and its OAuth flow succeeds.

The Site uses logical bindings `DB` and `FILES`. No personal records have been
imported, and no scheduled job is installed.

## External action boundaries

The user explicitly authorized package integration, commits, pushes and private
publication, then supplied the public `djh00t/pachigraph` GitHub repository and
requested the Pachigraph rename. The Site title and URL label are now Pachigraph
and `pachigraph` respectively. Its access remains owner-only.

Automatic approval review again rejected both package-copy commands despite that
authorization, with "approval required by policy, but AskForApproval is set to
Never". The prepared files remain in `/tmp/code-graph-collector` and
`/tmp/code-graph-plugin`. Neither rejected integration action was retried through
another mechanism. The earlier generated-cache cleanup was also rejected.

The Site portion can be published for qualification, but this is not a complete
integrated MVP release and does not authorize bulk ingestion before qualification.

## Local evidence recorded 2026-09-05

- `make check`: TypeScript and lint passed; 23 TypeScript tests passed against the
  actual Drizzle migrations, including FTS triggers and R2 interruption tests.
- `npm run build`: production build passed. The toolchain emits an upstream Node
  `punycode` deprecation warning; Node's SQLite test API emits its experimental
  warning. These do not establish a warning-free toolchain.
- Local Workers D1/R2 smoke: anonymous denial, ingest, exact replay, search, fetch,
  another owner's denial, rendered source page, deletion and replay-after-delete
  all passed using synthetic data. Identity headers were deliberately injected
  only into the loopback development runtime. This is not native OAuth proof.
- Synthetic sample: 300 records; 326,290 source JSON bytes; D1 grew 765,952 bytes.
  Twenty HTTP searches measured p50 2.64 ms and p95 3.42 ms. See
  `docs/local-benchmark.json`; `make benchmark` repeats this on an already running
  local Workers server and deletes its synthetic records in a `finally` block.
  Database allocation can retain freed pages, so repeated runs may show less
  incremental allocation. These numbers are not production latency or a reliable
  extrapolation of the personal archive.
- The local server was stopped after verification. No personal content was used.

## Prepared collector and plugin

Both packages are ready for review but could not be copied into this repository
because automatic approval review rejected that integration action.

- Collector: `/tmp/code-graph-collector/collector.py`,
  `/tmp/code-graph-collector/test_collector.py`, and its `USAGE.md`.
  The worker reports 34 passing tests, real Gitleaks 8.30.1 fixtures, 80% branch
  coverage, and passing lint/format/compile checks.
- Plugin: `/tmp/code-graph-plugin/plugin.json`, `mcp.json`, and
  `skills/pachigraph/`. Its 5 tests pass; official Agent Plugins 1.0 schemas
  validate through the maintained MCP SDK's Ajv validator.
- Collector sizing: 20 synthetic records needed 40 scanner processes and 3.170
  seconds (6.31 records/second). This is an initial-import throughput limitation;
  unchanged records bypass scanning, while append/backfill verifies the saved
  source prefix. Measure a representative sample before bulk import; batching the
  scanner is a possible follow-up if the measured duration is unacceptable.
- Oversized records above 384 KiB are explicit, persistent gaps. The collector
  exits nonzero on unresolved gaps. Full archive acceptance requires zero gaps;
  this MVP cannot yet claim complete ingestion of an arbitrary archive.
