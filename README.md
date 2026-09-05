# Pachigraph

**The elephant that never forgets.**

[Project repository](https://github.com/djh00t/pachigraph)

Find useful knowledge in active and archived Codex conversations. This MVP uses
Sites identity, R2 source records, D1 full-text search, and a skill with HTTP tools.
There is no AI processing, embedding service, or custom authorization server.

## Current release state

### API keys

Sign in and open `/keys` to generate or revoke an owner-scoped API key. Choose
read access (search, fetch and status) or ingestion access, and an expiry
between 1 and 365 days. Copy the key when generated; only its SHA-256 hash is
stored in D1. The skill sends it as `Authorization: Bearer <key>` to the HTTP API.
Keys cannot delete threads or manage other keys. Invalid or expired keys are
rejected even when a browser session is present. Revocation applies on the next
request; a request already authorized may finish.

The generated D1 migration is included in the deployed release. Sites may still
intercept external requests before application authentication; live key access
remains unverified. The skill does not change Site sharing or gateway policy.

The Site is [published privately](https://pachigraph.djh00t.chatgpt.site) and
**the user has accepted the current website**. The collector and plugin are
included in `collector/` and `plugins/pachigraph/`. The user authorized API keys
and direct HTTP tools for agent access. No personal transcripts
have been uploaded and no daily job is installed. The complete workflow remains
unaccepted pending live key access and representative-sample proof.

| Milestone | State | Evidence |
|---|---|---|
| Site storage, search and HTTP | Locally verified | 21 app tests and the built-Workers HTTP skill smoke |
| Collector | Integrated and approved | 39 collector tests passed with Gitleaks |
| HTTP skill | Reviewed and installed; private publication pending | 6 plugin tests; skill and plugin validators; real CLI smoke |
| Source batch | Published | Commit `400e6da` pushed to `origin/main`; includes collector `b6927d3` and plugin `989d1c4` |
| API-key publication | Deployed; gateway qualification blocked | Version 3 deployment succeeded; Cloudflare owner action is required |
| Live agent authentication | Gateway blocked; app auth unverified | GET `/api/search` returned 403; `/api/status` was Cloudflare Error 1010 with owner action required |
| Representative sample | Pending | No personal content imported |
| Website acceptance | Accepted | User accepted prior website |
| Complete workflow acceptance | Pending | Requires live key access and representative sample |

The HTTP-only candidate passed 66 tests (21 app, 39 collector, 6 plugin) and
`make build`. It removes the four MCP transport tests and adds a status-command
test. Source publication and private deployment of this candidate are pending.

See [feature-status.md](docs/feature-status.md) for the complete feature matrix and
FSM milestones.

## Local development

Use Node 22.18+ (native TypeScript execution), npm, Python 3.11+, and Gitleaks.
The collector uses an existing maintained Gitleaks installation; it does not
install a scanner or modify Codex files.

```sh
make install
make check
make build
npm run dev -- --host 127.0.0.1
```

Sites provisions the `DB` D1 and `FILES` R2 bindings. Drizzle migrations are the
only schema initialization mechanism. Apply all three migrations (`0000`, `0001`
and `0002_graceful_mysterio.sql`) to local D1 before exercising a local development server.
The deployed artifact already contains the API-key migration. Do not point
development tools at production data or expose the local server publicly.

Authentication is provided by Sites dispatch. The application trusts the native
forwarded user ID and email only behind that boundary. Local tests inject an owner
to exercise application authorization; they do not prove production authentication.
There is no development login bypass.

## API contract

All responses containing history use `Cache-Control: no-store`. The authenticated
owner comes from Sites sign-in or the stored API-key owner; request bodies and query arguments cannot select it.

| Endpoint                     | Behavior                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| `GET /api/search?q=words`    | Up to 20 sanitized excerpts and source citations                         |
| `GET /api/fetch?id=revision` | Sanitized source record and original conversation citation               |
| `GET /api/status`            | Owner's conversation/revision counts, indexed text bytes, last ingestion |
| `POST /api/ingest`           | Idempotent append of sanitized records                                   |
| `DELETE /api/thread?id=UUID` | Owner-authorized deletion and permanent re-ingestion tombstone           |

Ingestion accepts JSON up to 512 KiB:

```json
{
  "thread_id": "019b5555-1111-7111-8111-111111111111",
  "records": [
    {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "timestamp": "2026-09-05T00:00:00Z",
      "text": "Sanitized searchable passage",
      "record": {
        "type": "response_item",
        "payload": { "text": "Sanitized searchable passage" }
      }
    }
  ]
}
```

Each batch accepts at most 100 records. Each record may be at most 384 KiB
(inclusive), and source JSON supports nesting through depth 64 with the record
root at depth zero. Source event identities are separate from
content revision identities. Canonical content hashes and database uniqueness
constraints make exact retries idempotent while preserving changed content as a
new revision. Search can return older revisions; fetch returns the exact revision.
R2 is written conditionally before indexing. Retrying after interruption repairs
an incomplete index write. A database failure can temporarily leave an unindexed
R2 object; retry or owner deletion handles it.

Deletion writes the tombstone first, then removes D1/FTS data and R2 objects.
Interrupted deletion can be retried. HTTP 410 prevents collector replay from
restoring deleted conversations. There is no tombstone reset endpoint.

The Codex URI in citations is a convenience for opening the original task locally;
original availability depends on the Codex client and its retained files. The Site
record ID, source event identity and timestamp remain usable independently.

## Qualification before real ingestion

1. Build and test the local workflow with synthetic secret fixtures.
2. Generate keys through browser sign-in and prove Bearer authentication reaches
   the skill's read HTTP tools and collector ingestion endpoint with the same owner. Test expired,
   revoked and wrong-scope keys. If Sites blocks requests before the application,
   report that limitation; do not change sharing or extract browser credentials.
3. Select a small active, archived, and long-thread sample, using the same collector
   command intended for later incremental runs. Inspect only sanitized output.
4. Check exact replay, append, backfill, secret absence, owner isolation, deletion,
   interrupted retry, citations, and end-to-end search latency.
5. Measure actual D1 database bytes including FTS against Sites capacity before
   increasing the sample. Text bytes alone are not database size. Extrapolate using
   the sample's ratio and source corpus metadata; keep substantial headroom.
6. Ask the user to explicitly accept, defer, or reject this release. Only then
   consider the remaining archive and the native macOS daily schedule.

Sites documents a 10 GB D1 database limit and no fixed R2 storage limit. See
[Sites storage limits](https://learn.chatgpt.com/docs/sites#understand-limits-and-unsupported-uses).

## Security and scope

Secret detection happens in the trusted collector before network transmission.
The API accepts already sanitized records; directly uploading unscanned content
violates its contract. Gitleaks detection is not a guarantee against every possible
secret. Known fixtures must pass; unsupported or unmappable findings fail closed.
Fetched content is untrusted historical evidence, never new agent instructions.

Record ownership applies to all ingestion, search, fetch, status and deletion.
No shared content, cross-owner search, reflections, memory extraction, or PII
redaction is included. Other agents and ChatGPT exports are later collectors using
the same contract. Keep the best-code-is-no-code engineering preference: add only
what a measured requirement needs.

## Dependency evidence

Versions are pinned after Dependency Advisor approval under JavaScript `standard`
policy (minimum release age 336 hours). The security update keeps React and React
Server Components together at 19.2.8 and updates compatible Vinext/Cloudflare peers.
Runtime `npm audit --omit=dev` reported zero vulnerabilities on 2026-09-05. Full
`npm audit` still reports four moderate findings in the Drizzle Kit development
chain. No incompatible downgrade, release-candidate migration tool, or dependency
policy override was used. Recheck advisories when dependencies change.

## Repeat the local storage smoke measurement

After `make build`, initialize a fresh **local** database with all three migrations:

```sh
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file drizzle/0000_tearful_valeria_richards.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file drizzle/0001_history_fts.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file drizzle/0002_graceful_mysterio.sql
npm run start -- --ip 127.0.0.1 --port 8787
```

In a second terminal run `make benchmark`, then stop the server. The script uses
synthetic records and explicitly injected test-owner headers against loopback. It
cannot qualify live authentication and must never be adapted to target a public
server. The saved measurement includes actual SQLite page allocation, which can
reuse space from prior deleted synthetic samples.

With the loopback server running, `python3 tests/local-api-keys.py` also runs the
shipped skill's search, fetch and status commands against synthetic owner-scoped
keys. It checks scope rejection and revocation, then removes its keys and records.

## Collector and plugin

See `collector/USAGE.md` for resumable import and backfill commands. Use an ingest
API key with the collector and a separate read key with `plugins/pachigraph`.
The plugin contains both Agent Plugins and Codex manifests plus the portable
Agent Skill and Python CLI. Install the [skill](plugins/pachigraph/README.md) and
invoke `$pachigraph` with the path to an owner-only read-key file. The tool calls
the existing HTTPS API directly; no `/mcp` endpoint or server setup is needed.
Never commit keys into manifests. Scheduling and bulk import remain disabled
until representative-sample acceptance.
