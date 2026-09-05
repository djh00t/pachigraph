# MVP acceptance record

This record separates local implementation evidence from live qualification and
human acceptance. It is deliberately a table, not workflow software.

| State               | Entry condition                          | Exit evidence                                                    | Current              |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| Implementing        | Approved minimal scope                   | Collector, Site, plugin sources and focused tests                | Complete             |
| Local verified      | Integrated code                          | `make check`, production build, synthetic end-to-end checks      | Complete             |
| Platform qualified  | Private publication authorized           | Owner-scoped API keys reach MCP and HTTP; D1/R2 available        | Pending              |
| Sample verified     | Platform qualified                       | Representative active, archived, long sample passes checks below | Pending              |
| Awaiting acceptance | Evidence and limitations presented       | User explicitly accepts, defers, or rejects                      | Pending              |
| Accepted            | User acceptance recorded                 | Remaining archive and daily collection may proceed as authorized | Pending              |
| Deferred / rejected | User decision or unsupported requirement | Record reason and next decision; no bulk import                  | Available transition |

## Website acceptance and next release

On 2026-09-05, the user accepted the current website and explicitly set the goal
to deliver the next release. This acceptance covers the website only; it does not
waive authentication, sample-ingestion, safety, capacity or agent-access
checks. The complete workflow still requires its own explicit acceptance.

The integrated release must qualify standard HTTPS MCP and equivalent
authenticated HTTP access, and pass a small
active/archived/long-thread sample through the required proof below. Bulk import
and the daily macOS schedule remain behind that acceptance gate.

Earlier native Sites checks returned an owner-level MCP enablement error. That is
historical context: the current agent-credential decision uses user-authorized
API keys instead of native Sites MCP OAuth. No authorization server, bypass
credential or alternate hosting has been introduced.

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
- Prove authenticated CLI and MCP access use keys tied to the same signed-in owner. Local tests
  that inject an owner do not satisfy this check.

## Current platform evidence

On 2026-09-05, Pachigraph was published privately at
https://pachigraph.djh00t.chatgpt.site. Both native deployments reported success;
the second includes `capabilities: ["mcp"]` in the hosting manifest. The access
policy remains custom, with one allowed owner, no groups and no external visitors.
A valid-format user read key was tested through the live gateway: `GET
/api/search` and `POST /mcp` both returned HTTP 403. `GET /api/status` was
classified as Cloudflare Error 1010 `browser_signature_banned`, with detail that
the Site owner is blocked by browser signature, `retryable=false`, and
`owner_action_required=true`.

This is a Cloudflare gateway block. It does not prove application API-key
failure or a Sites OAuth block. Do not retry or change the user agent; owner
action is required. Native MCP/OAuth was superseded by the API-key decision, so
do not add a custom authorization server or bypass token.

The Site uses logical bindings `DB` and `FILES`. No personal records have been
imported and no scheduled job is installed. The deployed application source is
commit `744622126d1d59e661d4d38068acf57e2c3a4f3c`, pushed to the repository.
Sites version 3 deployment `appgdep_6a9c23e5798c8191bdeb9da1946daf78`
succeeded at `2026-09-05T14:15:26Z`; the private version is
`appgprj_6a9b93afa6788191b7b0a59358a497ce~appgver_9f561efed35c8191823362705e01cdc2`.

## External action boundaries

The user explicitly authorized package integration, commits, pushes and private
publication, then supplied the public `djh00t/pachigraph` GitHub repository and
requested the Pachigraph rename. The Site title and URL label are now Pachigraph
and `pachigraph` respectively. Its access remains owner-only.

Earlier automatic approval review rejected package-copy commands with
"approval required by policy, but AskForApproval is set to Never". That blocker
is historical: repository integration and commit permissions were subsequently
resolved, and the packages are now integrated.

The Site is published for qualification, but live key access, representative
sample proof and complete workflow acceptance remain pending. Bulk ingestion and
scheduling are not authorized before those gates pass.

## Local evidence recorded 2026-09-05

- `make check`: TypeScript and lint passed; 25 app tests passed against the
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

## Reviewed collector and plugin integration

The integrated collector and plugin changes passed review: 39 collector tests and 5
plugin tests passed. The app baseline has 25 tests; integrated `make check` passed
all 69 tests, with Codex plugin validation and `git diff --check` also passing.
Source batch `400e6da`, including collector commit `b6927d3` and plugin commit
`989d1c4`, was pushed to `origin/main`. These changes do not change the app
runtime, so v3 remains the current deployment and no redeployment is required.
This status snapshot records that publication and is not claimed as part of
`400e6da`. Build checks pass with the
known upstream Node `punycode` and experimental SQLite warnings.
- Collector sizing: 20 synthetic records needed 40 scanner processes and 3.170
  seconds (6.31 records/second). This is an initial-import throughput limitation;
  unchanged records bypass scanning, while append/backfill verifies the saved
  source prefix. Measure a representative sample before bulk import; batching the
  scanner is a possible follow-up if the measured duration is unacceptable.
- Oversized records above 384 KiB are explicit, persistent gaps. The collector
  exits nonzero on unresolved gaps. Full archive acceptance requires zero gaps;
  this MVP cannot yet claim complete ingestion of an arbitrary archive.

## API-key authentication decision

The user explicitly requested an API-key generator instead of Sites MCP enablement.
The deployed implementation adds browser-managed, hashed, expiring and revocable
read or ingest keys. Standard MCP and HTTP resolve the owner from the key record.
This supersedes the native OAuth requirement for agent credentials; browser key
management still requires native Sites sign-in. Deployment succeeded; live
ingress qualification is blocked by Cloudflare Error 1010 pending owner action;
the application-key outcome remains unknown. No Site sharing or platform
enablement was changed.

### Local API-key runtime proof

On 2026-09-05, `python3 tests/local-api-keys.py` passed against the built Workers
runtime at `127.0.0.1:8787`, with all three D1 migrations applied locally. It
generated read and ingest keys through a synthetic browser identity, then used
Bearer-only requests for ingest, duplicate replay, search, fetch, MCP initialize,
tool listing and search. Wrong-scope access was rejected. Revocation caused both
HTTP and MCP requests to return 401. Synthetic keys and source records were
removed afterward; the local server was stopped. Credentials were not printed.

This verifies route composition with D1/R2, not production Sites authentication
or gateway behavior. The test is loopback-only and must not be adapted to inject
trusted browser identity headers against production.

| Next-release milestone | State |
|---|---|
| Current website | User-accepted |
| API-key generator and HTTP/MCP integration | Locally verified |
| Collector and plugin integration | Published in source batch `400e6da` on 2026-09-06 |
| Published Bearer-key access | Gateway blocked; app-key outcome unproven; `/api/search` and `/mcp` returned 403 |
| Representative personal sample | Pending |
| Complete workflow acceptance | Pending |

On 2026-09-06, following the user's confirmation of full access, package
integration succeeded. The earlier approval restriction is historical; the
collector and plugin are now present in the repository. API-key live access
and representative-sample acceptance remain pending. The live gateway block does
not establish an application-key failure.
