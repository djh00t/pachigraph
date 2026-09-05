# Pachigraph

**The elephant that never forgets.**

[Project repository](https://github.com/djh00t/pachigraph)

Find useful knowledge in active and archived Codex conversations. This MVP uses
Sites identity, R2 source records, D1 full-text search, and the maintained MCP SDK.
There is no AI processing, embedding service, or custom authorization server.

## Current release state

The Site implementation passes local checks and is being published privately for
native authentication qualification. The collector and plugin are prepared but
are not included in this checkout: automatic approval review blocked their copy
into the repository even after explicit authorization. No personal transcripts
have been uploaded, no daily job has been installed, and user acceptance is pending.

| Milestone                          | State               | Evidence                                                             |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------- |
| Site storage, search, HTTP and MCP | Local verified      | 23 tests, production build and local Workers smoke pass              |
| Collector                          | Integration blocked | Prepared implementation: 34 tests pass with real Gitleaks            |
| Plugin                             | Integration blocked | Prepared Pachigraph package: 5 tests pass; manifest schemas validate |
| Private Site publication           | In progress         | Same registered Site, owner-only audience                            |
| Native agent authentication        | Unverified          | Needs live native OAuth proof for MCP and HTTP                       |
| Representative sample              | Pending             | No personal content imported                                         |
| User acceptance                    | Pending             | User explicitly accepts, defers or rejects                           |

These are milestone states, not an FSM implementation.

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
only schema initialization mechanism. Generated migrations and the FTS migration
must be applied to local D1 before exercising a local development server. Do not
point development tools at production data or expose the local server publicly.

Authentication is provided by Sites dispatch. The application trusts the native
forwarded user ID and email only behind that boundary. Local tests inject an owner
to exercise application authorization; they do not prove production authentication.
There is no development login bypass.

## API contract

All responses containing history use `Cache-Control: no-store`. The authenticated
owner always comes from Sites; request bodies and query arguments cannot select it.

| Endpoint                     | Behavior                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| `GET /api/search?q=words`    | Up to 20 sanitized excerpts and source citations                         |
| `GET /api/fetch?id=revision` | Sanitized source record and original conversation citation               |
| `GET /api/status`            | Owner's conversation/revision counts, indexed text bytes, last ingestion |
| `POST /api/ingest`           | Idempotent append of sanitized records                                   |
| `DELETE /api/thread?id=UUID` | Owner-authorized deletion and permanent re-ingestion tombstone           |
| `POST /mcp`                  | Stateless Streamable HTTP MCP `search` and `fetch`                       |

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

Each batch accepts at most 100 records; each record must fit within 384 KiB. Source event identities are separate from
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
2. Publish privately through Sites under the existing authorization,
   and request its native MCP connection details.
3. Prove native OAuth supplies the same stable owner identity for MCP and the
   collector's authenticated HTTP requests. Browser sign-in alone is insufficient.
   If Sites cannot provide that flow, stop and report the unsupported requirement.
   Never substitute a Sites bypass token, browser-cookie extraction, a handwritten
   bearer-token validator, or another hosting platform without a new decision.
4. Select a small active, archived, and long-thread sample, using the same collector
   command intended for later incremental runs. Inspect only sanitized output.
5. Check exact replay, append, backfill, secret absence, owner isolation, deletion,
   interrupted retry, citations, and end-to-end search latency.
6. Measure actual D1 database bytes including FTS against Sites capacity before
   increasing the sample. Text bytes alone are not database size. Extrapolate using
   the sample's ratio and source corpus metadata; keep substantial headroom.
7. Ask the user to explicitly accept, defer, or reject this release. Only then
   consider the remaining archive and the native macOS daily schedule.

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
policy override was used. Recheck advisories before publication.

## Repeat the local storage smoke measurement

After `make build`, initialize a fresh **local** database with the two migrations:

```sh
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file drizzle/0000_tearful_valeria_richards.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --file drizzle/0001_history_fts.sql
npm run start -- --ip 127.0.0.1 --port 8787
```

In a second terminal run `make benchmark`, then stop the server. The script uses
synthetic records and explicitly injected test-owner headers against loopback. It
cannot qualify live authentication and must never be adapted to target a public
server. The saved measurement includes actual SQLite page allocation, which can
reuse space from prior deleted synthetic samples.
