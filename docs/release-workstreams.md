# Release workstreams

Baseline: `744622126d1d59e661d4d38068acf57e2c3a4f3c`, privately deployed as Sites
version 3. The original MVP plus the user's API-key decision is the acceptance
contract. The website is accepted; the integrated workflow is not yet accepted.

## Ownership and dependency graph

| Stream | Owner | Files / output | Exit evidence | Dependencies |
|---|---|---|---|---|
| Collector reliability | Sol medium | Integrated collector | Review and synthetic contract tests; no personal ingestion | Existing HTTP contract |
| Portable agent access | Sol medium | Integrated plugin | Manifest/skill/CLI correctness and client configuration proof | Existing Bearer contract |
| Release evidence | Luna medium | README and acceptance record | Current facts, no stale blockers presented as current | Published version and recorded checks |
| Auth, storage and UI review | Sol high | Read-only findings | Concrete release blockers with evidence and bounded fixes | Current application |
| Live gateway qualification | Orchestrator | Native Sites state and reduced HTTP observations | Confirm whether application auth is reachable | Existing private deployment |
| Integration and release | Orchestrator | Reviewed integrated changes | Relevant checks, final documentation review and published source | All changed streams reviewed |

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
| Plugin / auth review | Read scope and MCP transport | Findings return before auth changes |
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
| Reviewed integration | Approved; final documentation repair under review |
| Source publication | Pending final documentation review; no app redeployment required |
| Live platform qualification | Blocked by Cloudflare Error 1010 pending owner action |
| Representative sample | Pending |
| Workflow acceptance | Pending |
