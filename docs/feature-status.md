# Pachigraph feature status

## October engineering reconciliation — 2026-10-22

Evidence checked on 22 October 2026 at 20:38 Australia/Sydney (09:38 UTC).
Source baseline: `0487c5eb78bc26c0e9f2ce894ad381aab403f30a`. This section
supersedes older current-state descriptions only where fresh evidence is linked;
the dated September and Sites records below remain historical evidence.
This is a feature/status matrix, not an executable coordination state machine.
An hourly refresh records observations; it does not authorize installation,
publication dispatch, imports, runtime operations or transition execution.

| Outcome | Source | Publication | Installation | Runtime / acceptance | Blocker / accountable owner | Next bounded action |
| --- | --- | --- | --- | --- | --- | --- |
| Packaged lifecycle and release evidence ([#17](https://github.com/djh00t/pachigraph/issues/17), [#11](https://github.com/djh00t/pachigraph/issues/11)) | PR #20 merged as `0487c5e`; exact-main checks succeeded | [17 October receipt](https://github.com/djh00t/pachigraph/issues/17#issuecomment-6229082191) confirms GHCR image `sha256:e38687a5bfe65e4937d105e69bc656ab733d8a4fc7271ae5e465aa264468d8fa` | No current-version installation established by that receipt | Deployment, Flux release-reference qualification, shared Agent Brain conformance and operator acceptance remain separate; no fresh runtime proof claimed | Existing release-evidence / QA owners under #11 and #17; central qualification belongs to the migration owner | Reconcile the next missing qualification receipt with the existing owner; do not repeat completed source checks or dispatch publication from this matrix |
| Cross-platform archive contract ([#9](https://github.com/djh00t/pachigraph/issues/9)) | [PR #10](https://github.com/djh00t/pachigraph/pull/10) merged producer evidence, synthetic fixtures and a [contract proposal](cross-platform-contract-review.md); production contract remains unimplemented | Preparation is on main; no implementation release claimed | No new adapters or collection job installed by this work | Four-source ingest/retry/search/readback, correction links and Agent Brain retrieval acceptance remain unmet; fixture checks are not live qualification | Human interface decision pending; David/product approver, with the existing app source owner coordinating. Issue #9 remains closed; closure is not implementation evidence | Obtain explicit decisions on metadata storage, nullable time, legacy provenance and archive-ID acknowledgements; then lease the retained-identity helper and restart/replay tests as a separate 10–15 minute package |
| Existing-version migration and recovery (existing coordination #970 / #878) | Separately owned migration/recovery source work; no public qualification receipt established by this refresh | Source delivery is separate from accepted migration | Not established by public evidence in this refresh | Recovery, controlled ownership transfer, protection and operator acceptance remain separately gated; private runtime observations are intentionally omitted | Existing Flux/migration owner; source integration is held pending that owner's protection/qualification decision. Human/operator owns later execution approvals | Obtain a sanitized public engineering handover stating the remaining gate and next authorized package; preserve the hold and existing owner. New schema is not a migration dependency |
| Dependency qualification ([#3](https://github.com/djh00t/pachigraph/issues/3), [PR #16](https://github.com/djh00t/pachigraph/pull/16)) | Candidate `73fa7f9335b7bf92fd3342b363ba4361896647b4` changes direct SDK / formatter plus indirect dependencies | Unmerged; PR explicitly says do not merge | Candidate not installed by qualification work | Current-target checks/build/smoke and independent/Codex acceptance not provided; older hosted success does not qualify this target | Dependency Advisor returned blocked with no recommended version for the exact SDK / formatter requests; existing dependency owner under #3. Human owns any separately explicit policy exception | Preserve the candidate and policy result; await a policy-recommended candidate or explicit exception before installation and exact-target qualification. Do not retry unchanged denied work |

Installation and runtime fields are evidence scopes, not claims that an older
installation or service does not exist. Historical skill installation below is
not proof of compatibility or installation of the October source. No current
personal import, daily collection activation or runtime acceptance is inferred.

Hourly maintenance owner: the existing Pachigraph source coordinator, through
an isolated single-writer lease, review and feature PR to the existing release
branch. This refresh remains a candidate until integrated; canonical status is
the version on main. The portfolio coordinator links this existing matrix and
owns scheduling separately. Keep each refresh bounded: update evidence time,
source/publication/installation/runtime distinctions, blocker, owner and next
action; preserve dated history and do not rerun unchanged failed tests.

Only sanitized engineering metadata belongs here. Exclude conversation contents,
customer or financial material, credentials, private filesystem locations and
private runtime evidence. Link a safe public engineering receipt or explicitly
record unknown evidence instead. No new access, credential or visibility change
is authorized by matrix maintenance.


## Kubernetes migration — 2026-09-07

The following work supersedes the Sites runtime. Historical evidence below does
not qualify the new deployment.

| Work | State | Owner | Model / reasoning |
| --- | --- | --- | --- |
| Signed Keycloak identity and read-only MCP | 🟢 Focused checks: 9 tests, lint and strict types | k8s_auth_mcp | Sol / high |
| PostgreSQL and S3 storage | 🟢 13 real PostgreSQL and 4 S3-command tests | k8s_storage | Sol / high |
| Standalone image and Flux configuration | 🟢 Build and standalone smoke; Flux image pin pending | Primary agent | Current session / not exposed |
| Kubernetes live authentication and storage | 🟡 Not deployed or qualified | Primary agent | Current session / not exposed |
| Personal import and daily schedule | ⏸️ Await explicit workflow acceptance | Unassigned | — |

## Historical Sites release


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
| MCP transport | 🔵 Removed in version 4 | User selected a skill with HTTP tools | Preserve historical evidence | Orchestrator (no subagent) | current session | not exposed |
| Browser API-key generation and revocation | 🟢 Local verified | Sites sign-in; API-key migration | Await Cloudflare owner action before live UAT | /root/application_review | Sol | high |
| Read and ingest key scopes and expiry | 🟢 Local verified | API-key store and route guards | Test wrong scope and expiry live | /root/application_review | Sol | high |
| API-key migration in deployed source | 🟠 Deployed; UAT pending | Commit `744622126d1d59e661d4d38068acf57e2c3a4f3c` | Confirm live key-backed route behavior | /root/application_review | Sol | high |
| Private Sites version 4 deployment | 🟢 Deployment succeeded | Source `628e41b`; live HTTP proof remains separate | Preserve owner-only sharing | Orchestrator (current session) | current session | not exposed |
| Website acceptance | 🔵 Accepted | Private deployment | Keep website scope separate from workflow acceptance | Orchestrator (current session) | current session | not exposed |
| In-app browser connection and signed-in search | 🟢 Live verified | User completed ChatGPT sign-in | Preserve browser evidence; qualify agent access separately | Orchestrator (no subagent) | current session | not exposed |
| Deployed API-key store read | 🟢 Live verified | Signed-in key page lists the existing read key | Prove Bearer HTTP access; generation and revocation remain untested | Orchestrator (no subagent) | current session | not exposed |
| Browser storage-status inspection | 🟠 Browser refused navigation | `/api/status` returned `ERR_BLOCKED_BY_CLIENT` | Require a permitted status/capacity inspection path | Orchestrator (no subagent) | current session | not exposed |
| Native D1 schema and empty-store baseline | 🟢 Live verified | Sites database overview and bounded row reads | Measure physical size against the documented 10 GB D1 limit | Orchestrator (no subagent) | current session | not exposed |
| Collector implementation and secret scanning | 🟢 Integrated; 39 tests reviewed and approved | Bearer ingest contract; maintained Gitleaks | Run a representative sanitized sample | /root/collector_stream | Sol | medium |
| Collector replay, append, backfill and resume behavior | 🟢 Local verified | Ingest idempotency and source prefix contract | Prove on the representative sample | /root/collector_stream | Sol | medium |
| Direct HTTP skill and tools | 🟢 Locally verified | 6 plugin tests, validators and built-Workers CLI smoke | Qualify live HTTP access after owner action | Orchestrator (no subagent) | current session | not exposed |
| HTTP-only release review | 🟢 Approved | Finished skill, MCP removal and local checks | Preserve review evidence | /root/release_final_review | GPT-6 Astra | high |
| Standalone HTTP skill installation | 🟢 Installed | Reviewed skill copied with byte-for-byte verification | Invoke `$pachigraph` with the read-key file path | Orchestrator (no subagent) | current session | not exposed |
| HTTP-only source publication and deployment | 🟢 Published as version 4 | Reviewed source `628e41b`; successful private deployment | Qualify live HTTP access after owner action | Orchestrator (no subagent) | current session | not exposed |
| Previous integrated release source | 🟢 Historical publication at `400e6da` | Completed package and final reviews for that batch | Preserve previous-release evidence | /root/matrix_stream | Luna | medium |
| Collector and plugin package review | 🟢 Approved and published | Commits `b6927d3` and `989d1c4` pushed in `400e6da` | Preserve approval evidence | /root/package_review | Sol | medium |
| Release final review | 🟢 Completed | Integrated source and corrected release evidence | Preserve final-review evidence | /root/release_final_review | GPT-6 Astra | high |
| Final documentation repair | 🟢 Completed; scoped verification passed | Release final-review findings, including the residual dependency correction | Preserve this post-publication status snapshot | /root/final_docs_fix | Sol | medium |
| Previous source publication | 🟢 Historical publication at `400e6da` | Approved integration and completed final review for that batch | Preserve previous-release evidence | /root | current session | not exposed |
| Local checks and production build | 🟢 Local verified | Node, npm, Python and Gitleaks toolchain | Keep known upstream warnings documented | Orchestrator (current session) | current session | not exposed |
| Live gateway observation | 🟠 Gateway blocked | Valid-format read key; Cloudflare/Sites ingress | Do not retry or change user agent; owner action is required | Orchestrator (current session) | current session | not exposed |
| Live valid-key HTTP authentication | 🟠 Gateway blocked; app auth unverified | Valid deployed-format read-key file; gateway ingress | Preserve the GET `/api/search` 403 evidence; do not infer app-key failure | Orchestrator (current session) | current session | not exposed |
| Live MCP authentication | 🔵 Superseded | User selected HTTP skill tools | Keep previous observations as historical evidence only | Orchestrator (current session) | current session | not exposed |
| Live status classification | 🟠 Gateway blocked | `/api/status`; Cloudflare Error 1010 | Record `browser_signature_banned`, `retryable=false`, `owner_action_required=true`; do not retry | Orchestrator (current session) | current session | not exposed |
| Same-owner skill and collector proof | 🟡 Pending gateway owner action | Live HTTP read and ingest key checks | Resume only after the gateway owner block is cleared | /root/application_review | Sol | high |
| Expired, revoked and wrong-scope live checks | 🟡 Pending gateway owner action | Live key access | Resume only after gateway qualification; never vary the user agent | /root/application_review | Sol | high |
| Representative active sample | 🟡 Pending | Live authentication; collector | Select a small sanitized active sample | /root/collector_stream | Sol | medium |
| Representative archived sample | 🟡 Pending | Live authentication; collector | Select a small sanitized archived sample | /root/collector_stream | Sol | medium |
| Representative long-thread sample | 🟡 Pending | Live authentication; collector | Select a small sanitized long-thread sample | /root/collector_stream | Sol | medium |
| Secret absence in bodies, storage, results and logs | 🟡 Pending | Representative sample; scanner | Verify known fixtures and inspect sanitized outputs | /root/collector_stream | Sol | medium |
| Owner isolation and deletion/tombstone proof | 🟡 Pending | Live or qualified sample workflow | Test cross-owner reads/deletes and replay after delete | /root/application_review | Sol | high |
| Search citation correctness | 🟡 Pending | Representative sample | Verify conversation, source record and timestamp | /root/collector_stream | Sol | medium |
| Search p50/p95 latency measurement | 🟡 Pending | Representative sample and live route | Measure with corpus size recorded | /root/application_review | Sol | high |
| Actual D1/FTS capacity measurement | 🟡 Pending | Representative sample; documented 10 GB D1 limit | Measure actual bytes before/after and extrapolate with headroom | /root/application_review | Sol | high |
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

Historical evidence anchors: source batch `400e6da`, including collector commit `b6927d3`
and plugin commit `989d1c4`, is pushed to `origin/main`. This status snapshot
records that publication and is not claimed as part of `400e6da`. Private Sites version 3
`appgprj_6a9b93afa6788191b7b0a59358a497ce~appgver_9f561efed35c8191823362705e01cdc2`
deployment `appgdep_6a9c23e5798c8191bdeb9da1946daf78` succeeded at
`2026-09-05T14:15:26Z`. Integrated evidence is 39 collector tests, 25 app tests
and 5 plugin tests (69 tests in that release); the collector and plugin changes were
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

Current position: the website is accepted. The user selected a skill with direct
HTTP tools on 2026-09-06, replacing MCP. The HTTP-only source passed 66 tests,
the production build, skill/plugin validation and the local CLI smoke. It
is installed locally and privately deployed as version 4 from
`628e41bab9c377fefbbc2e8fe5c756c6cdb2ac30`. Deployment
`appgdep_6a9c3a7da18c8191968b68423fe7ebab` succeeded at
`2026-09-05T15:51:38.952205Z`. Native MCP enablement is no longer a
release gate; the separate HTTP gateway restriction remains, followed by sample
verification and workflow acceptance. No personal import or daily schedule has
started. Any gate may instead end in `Deferred / rejected`, recording the reason
and preventing bulk ingestion.

## Minor feature FSMs

These compact sub-FSMs show the next transition for each active workstream.

```text
API keys:       local -> deployed -> live read/ingest HTTP proof -> accepted
Collector:      implemented -> integrated -> sample run -> safety/capacity proof
Skill:          HTTP tools -> local smoke -> review -> installed -> live proof
Release docs:   historical record -> reconciled facts -> user acceptance record
Sample:         not selected -> active/archived/long selected -> replay/isolation/
                deletion/citation/latency checks -> capacity check
Operations:     no import -> workflow accepted -> bulk import -> daily schedule
```

The collector and API-key storage retain their existing evidence. The HTTP-only
skill release is installed and privately deployed; live HTTP proof and sample verification remain
pending. Historical MCP results do not define the new release requirements.
