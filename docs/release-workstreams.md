# Current Kubernetes workstream

The 2026-09-07 migration restores read-only MCP alongside the HTTP skill and
replaces Sites storage/auth with PostgreSQL, S3 and verified Keycloak identity.
See [current status](feature-status.md) and [acceptance](acceptance.md). The
following records describe earlier releases and do not qualify Kubernetes.

# Release workstreams

The current work replaces MCP with the existing skill's direct HTTP tools,
adds the read-only status command, and removes the MCP route and dependencies.
The collector and stored data contracts are unchanged. Reviewed source
`628e41bab9c377fefbbc2e8fe5c756c6cdb2ac30` is pushed to GitHub and Sites,
and privately deployed as Sites version 4. The standalone skill is installed.
The website is accepted; the integrated workflow is not yet accepted.

## Ownership and dependency graph

| Stream | Owner | Files / output | Exit evidence | Dependencies |
|---|---|---|---|---|
| Collector reliability | Sol medium | Integrated collector | Review and synthetic contract tests; no personal ingestion | Existing HTTP contract |
| HTTP skill implementation | Orchestrator (current model; reasoning not exposed) | Existing skill/CLI, MCP removal and docs | Read-only HTTP tools, local end-to-end smoke and installed skill | Existing Bearer contract |
| Release evidence | Luna medium | README and acceptance record | Current facts, no stale blockers presented as current | Published version and recorded checks |
| Auth, storage and UI review | Sol high | Read-only findings | Concrete release blockers with evidence and bounded fixes | Current application |
| Live gateway qualification | Orchestrator | Native Sites state and reduced HTTP observations | Confirm whether application auth is reachable | Existing private deployment |
| HTTP skill review | release_final_review (GPT-6 Astra, high) | Read-only findings | Review changed behavior and release evidence | Finished implementation and checks |
| Integration and release | Orchestrator | Reviewed HTTP-only release | Relevant checks, reviewed source and private deployment | HTTP skill review |

Workers use distinct staging directories. Only the Site owner integrates into the
Site checkout, handles Git publication or calls Sites tools. Workers cannot
modify each other's files, start personal imports, install jobs, change sharing,
publish or create credentials. No new dependencies without Dependency Advisor.

## Required release gates

1. Validate browser-managed keys and live Bearer requests through the private
   Sites gateway. Never inject identity headers or extract browser credentials.
2. Validate a representative active, archived and long-thread sample after auth
   qualification: secrets, exact replay, append/backfill, resume, isolation,
   deletion, citations, latency and actual D1 growth.
3. Present complete workflow evidence for user acceptance before bulk import or
   scheduler activation. Deferred graph and other-agent features stay deferred.

## Conflict checks

| Pair or task | Shared contract | Decision |
|---|---|---|
| Collector / plugin | Bearer HTTP authentication | Both consume it; neither changes it |
| Collector / storage review | Ingest limits and identity | Findings return to orchestrator before contract edits |
| Skill / auth review | Read scope and direct HTTP transport | Preserve owner resolution, expiry, scope and revocation |
| Docs / all streams | Evidence only | Reconcile again after integration |
| Collector | Tests versus implementation | Fix demonstrated release defects only |
| Plugin | Packaging versus runtime | Do not equate schema validity with authenticated client proof |
| Docs | Status versus history | Keep historic facts explicitly dated |
| Auth/storage/UI | Review versus implementation | No worker changes during review |
| Gateway | Private hosting versus API keys | Report interception; do not weaken sharing |

## Milestones

| State | Status |
|---|---|
| Independent stream execution | Complete |
| HTTP-only release review | Approved; corrected documentation confirmed |
| HTTP-only source publication and private deployment | Complete: `628e41b`, private version 4 |
| Live platform qualification | Blocked by Cloudflare Error 1010 pending owner action |
| Representative sample | Pending |
| Workflow acceptance | Pending |
