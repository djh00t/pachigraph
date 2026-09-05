# Pachigraph feature status

Status is current at 2026-09-06. `🟢` is complete and evidenced, `🔵` is
accepted, `🟠` is deployed or implemented but unverified at the live boundary,
`🟡` is pending, and `⏸️` is deferred. A pending item is not a failure. Historical
blockers are dated in the acceptance record and are not repeated as current
state.

## Feature matrix

| Feature or task | State | Dependencies | Next action | Subagent | Model | Reasoning |
|---|---|---|---|---|---|---|
| Site storage, D1 schema, R2 records and FTS | 🟢 Local verified | Sites DB/FILES bindings; Drizzle migrations | Keep migrations as the schema path | /root/application_review | Sol | high |
| Search, fetch, status and deletion HTTP routes | 🟢 Local verified | Storage and owner resolution | Exercise during live qualification | /root/application_review | Sol | high |
| Streamable HTTP MCP search/fetch | 🟢 Local verified | HTTP routes; MCP SDK | Prove authenticated live access | /root/application_review | Sol | high |
| Browser API-key generation and revocation | 🟢 Local verified | Sites sign-in; API-key migration | Await Cloudflare owner action before live UAT | /root/application_review | Sol | high |
| Read and ingest key scopes and expiry | 🟢 Local verified | API-key store and route guards | Test wrong scope and expiry live | /root/application_review | Sol | high |
| API-key migration in deployed source | 🟠 Deployed; UAT pending | Commit `744622126d1d59e661d4d38068acf57e2c3a4f3c` | Confirm live key-backed route behavior | /root/application_review | Sol | high |
| Private Sites version 3 deployment | 🟠 Deployed; UAT pending | Reviewed source and bindings | Preserve owner-only sharing | Orchestrator (current session) | current session | not exposed |
| Website acceptance | 🔵 Accepted | Private deployment | Keep website scope separate from workflow acceptance | Orchestrator (current session) | current session | not exposed |
| In-app browser connection and signed-in search | 🟢 Live verified | User completed ChatGPT sign-in | Preserve browser evidence; qualify agent access separately | Orchestrator (no subagent) | current session | not exposed |
| Deployed API-key store read | 🟢 Live verified | Signed-in key page lists the existing read key | Prove Bearer HTTP/MCP access; generation and revocation remain untested | Orchestrator (no subagent) | current session | not exposed |
| Browser storage-status inspection | 🟠 Browser refused navigation | `/api/status` returned `ERR_BLOCKED_BY_CLIENT` | Require a permitted status/capacity inspection path | Orchestrator (no subagent) | current session | not exposed |
| Collector implementation and secret scanning | 🟢 Integrated; 39 tests reviewed and approved | Bearer ingest contract; maintained Gitleaks | Run a representative sanitized sample | /root/collector_stream | Sol | medium |
| Collector replay, append, backfill and resume behavior | 🟢 Local verified | Ingest idempotency and source prefix contract | Prove on the representative sample | /root/collector_stream | Sol | medium |
| Portable agent plugin, manifests and CLI | 🟢 Integrated and approved | Bearer read contract; MCP client configuration | Prove client configuration against live keys | /root/plugin_stream | Sol | medium |
| Integrated release source | 🟢 Published at `400e6da` | Completed package and final reviews | Await Cloudflare owner action; no app redeployment is required | /root/matrix_stream | Luna | medium |
| Collector and plugin package review | 🟢 Approved and published | Commits `b6927d3` and `989d1c4` pushed in `400e6da` | Preserve approval evidence | /root/package_review | Sol | medium |
| Release final review | 🟢 Completed | Integrated source and corrected release evidence | Preserve final-review evidence | /root/release_final_review | GPT-6 Astra | high |
| Final documentation repair | 🟢 Completed; scoped verification passed | Release final-review findings, including the residual dependency correction | Preserve this post-publication status snapshot | /root/final_docs_fix | Sol | medium |
| Source publication | 🟢 Published at `400e6da` | Approved integration and completed final review | Await Cloudflare owner action; no app redeployment is required | /root | current session | not exposed |
| Local checks and production build | 🟢 Local verified | Node, npm, Python and Gitleaks toolchain | Keep known upstream warnings documented | Orchestrator (current session) | current session | not exposed |
| Live gateway observation | 🟠 Gateway blocked | Valid-format read key; Cloudflare/Sites ingress | Do not retry or change user agent; owner action is required | Orchestrator (current session) | current session | not exposed |
| Live valid-key HTTP authentication | 🟠 Gateway blocked; app auth unverified | Valid deployed-format read-key file; gateway ingress | Preserve the GET `/api/search` 403 evidence; do not infer app-key failure | Orchestrator (current session) | current session | not exposed |
| Live valid-key MCP authentication | 🟠 Gateway blocked; app auth unverified | Valid deployed-format read key; gateway ingress | Preserve the POST `/mcp` 403 evidence; do not infer app-key failure | Orchestrator (current session) | current session | not exposed |
| Live status classification | 🟠 Gateway blocked | `/api/status`; Cloudflare Error 1010 | Record `browser_signature_banned`, `retryable=false`, `owner_action_required=true`; do not retry | Orchestrator (current session) | current session | not exposed |
| Same-owner CLI and MCP proof | 🟡 Pending gateway owner action | Live HTTP and MCP key checks | Resume only after the gateway owner block is cleared | /root/application_review | Sol | high |
| Expired, revoked and wrong-scope live checks | 🟡 Pending gateway owner action | Live key access | Resume only after gateway qualification; never vary the user agent | /root/application_review | Sol | high |
| Representative active sample | 🟡 Pending | Live authentication; collector | Select a small sanitized active sample | /root/collector_stream | Sol | medium |
| Representative archived sample | 🟡 Pending | Live authentication; collector | Select a small sanitized archived sample | /root/collector_stream | Sol | medium |
| Representative long-thread sample | 🟡 Pending | Live authentication; collector | Select a small sanitized long-thread sample | /root/collector_stream | Sol | medium |
| Secret absence in bodies, storage, results and logs | 🟡 Pending | Representative sample; scanner | Verify known fixtures and inspect sanitized outputs | /root/collector_stream | Sol | medium |
| Owner isolation and deletion/tombstone proof | 🟡 Pending | Live or qualified sample workflow | Test cross-owner reads/deletes and replay after delete | /root/application_review | Sol | high |
| Search citation correctness | 🟡 Pending | Representative sample | Verify conversation, source record and timestamp | /root/collector_stream | Sol | medium |
| Search p50/p95 latency measurement | 🟡 Pending | Representative sample and live route | Measure with corpus size recorded | /root/application_review | Sol | high |
| Actual D1/FTS capacity measurement | 🟡 Pending | Representative sample | Measure before/after and extrapolate with headroom | /root/application_review | Sol | high |
| Complete workflow acceptance | 🟡 Pending | Live access, sample and required proof | Present evidence for explicit user decision | Orchestrator (current session) | current session | not exposed |
| Bulk archive ingestion | ⏸️ Deferred | Complete workflow acceptance; zero unresolved gaps | Start only after acceptance | unassigned | — | — |
| Daily macOS collection schedule | 🟡 Prepared, not installed | Accepted workflow; operational authorization | Install only after acceptance and authorization | Orchestrator (current session) | current session | not exposed |
| Native Sites MCP/OAuth for agent credentials | 🔵 Superseded | User-authorized API-key decision | Keep API keys as the chosen path | Orchestrator (current session) | current session | not exposed |
| Other-agent and ChatGPT export collectors | ⏸️ Deferred | Stable accepted collector contract | Add only when requested | unassigned | — | — |
| Passkeys and user-side encryption | ⏸️ Deferred | Explicit security/product requirement | Add only when the product scope requires it | unassigned | — | — |
| Pi, ClaudeCode and OpenCode collectors | ⏸️ Deferred | Source formats and accepted collector contract | Add only when requested | unassigned | — | — |
| Config and memory capture | ⏸️ Deferred | Explicit capture scope and privacy review | Define a bounded contract before implementation | unassigned | — | — |
| Relationships and graph features | ⏸️ Deferred | Product requirement and accepted design | Add only for a measured requirement | unassigned | — | — |
| Reflection and memory extraction | ⏸️ Deferred | Product requirement and accepted design | Add only for a measured requirement | unassigned | — | — |
| Richer grants and sharing controls | ⏸️ Deferred | Explicit authorization model | Specify grants before implementation | unassigned | — | — |
| Other OS and Kubernetes operation | ⏸️ Deferred | Operational requirement and deployment target | Add only when an operational target is authorized | unassigned | — | — |
| FSM software implementation | ⏸️ Deferred | Stable release gates and product requirement | Keep the FSM as documentation until software is required | unassigned | — | — |
| PII redaction and shared-content search | ⏸️ Deferred | Explicit privacy/product scope | Do not infer from the MVP | unassigned | — | — |
| AI processing and embeddings | ⏸️ Deferred | Explicit search-quality requirement | Keep the MVP text-search only | unassigned | — | — |

Evidence anchors: source batch `400e6da`, including collector commit `b6927d3`
and plugin commit `989d1c4`, is pushed to `origin/main`. This status snapshot
records that publication and is not claimed as part of `400e6da`. Private Sites version 3
`appgprj_6a9b93afa6788191b7b0a59358a497ce~appgver_9f561efed35c8191823362705e01cdc2`
deployment `appgdep_6a9c23e5798c8191bdeb9da1946daf78` succeeded at
`2026-09-05T14:15:26Z`. Integrated evidence is 39 collector tests, 25 app tests
and 5 plugin tests (69 current total); the collector and plugin changes were
reviewed and approved. Integrated `make check` passed all 69 tests;
Codex plugin validation and `git diff --check` also passed. No personal uploads
or jobs exist. Valid-format key UAT reached the gateway: GET
`/api/search` and POST `/mcp` returned 403. `/api/status` was classified as
Cloudflare Error 1010 `browser_signature_banned`, with `retryable=false` and
`owner_action_required=true`. The block is at Cloudflare; it does not prove an
application API-key failure or a Sites OAuth block. Do not retry or change the
user agent.

## Major release FSM

The major FSM is a release gate model, not application workflow code.

```text
Planned
  -> Implementing
  -> Locally verified
  -> Privately deployed
  -> Website accepted
  -> Live access qualified
  -> Representative sample verified
  -> Awaiting workflow acceptance
  -> Workflow accepted
  -> Bulk ingestion authorized
  -> Scheduled operation
```

Current position: `Scheduled operation` is not reached. The website is accepted;
the collector and plugin fixes passed review and were published in source batch
`400e6da`. Reviewed integration and source publication have passed. The v3 app
remains deployed at `744622126d1d59e661d4d38068acf57e2c3a4f3c`; the app runtime
is unchanged, so no redeployment is required. Live gateway qualification is
blocked on owner action, followed by sample verification and workflow acceptance. Any gate may
instead end in `Deferred / rejected`, recording the reason and preventing bulk
ingestion.

## Minor feature FSMs

These compact sub-FSMs show the next transition for each active workstream.

```text
API keys:       local -> deployed -> live HTTP proof -> live MCP proof -> accepted
Collector:      implemented -> integrated -> sample run -> safety/capacity proof
Plugin:         manifests -> CLI checks -> integrated -> configured live client
Release docs:   historical record -> reconciled facts -> user acceptance record
Sample:         not selected -> active/archived/long selected -> replay/isolation/
                deletion/citation/latency checks -> capacity check
Operations:     no import -> workflow accepted -> bulk import -> daily schedule
```

The API-key, collector, plugin and release-docs implementation states are
complete through their local or deployment evidence. The live proof and sample
sub-FSMs remain at their pending transitions.
