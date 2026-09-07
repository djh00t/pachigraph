# Pachigraph

**The elephant that never forgets.**

Find cited evidence in active and archived Codex conversations. The website,
HTTP API and read-only MCP endpoint run as one Node application on Kubernetes.
PostgreSQL indexes sanitized text; private S3 objects retain immutable source
revisions. Keycloak provides browser identity and scoped API keys serve agents.
There is no embedding service or AI processing.

Application source stays in [djh00t/pachigraph](https://github.com/djh00t/pachigraph).
Flux manifests and deployment operations live in
[code_pipeline](https://github.com/Titanicar-US/code_pipeline/issues/710).
The intended endpoint is `https://pachigraph.e164sip.com`; Kubernetes deployment
and live qualification are pending. The earlier private Sites release remains
available during cutover. Prior website acceptance does not imply acceptance of
the new deployment or complete ingestion workflow. No personal transcripts have
been imported and no daily collection job is installed.

## Development

Use Node 24, npm, Python 3.11+, Gitleaks, a disposable PostgreSQL database and a
private S3-compatible bucket. Install with `make install`. Configure:

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; schema `pachigraph` is app-owned |
| `S3_BUCKET` | Dedicated private source-object bucket |
| `AWS_REGION` | AWS region; defaults to `ap-southeast-2` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Standard AWS credential chain; keep out of files and Git |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | Optional S3-compatible test endpoint and path addressing |
| `PACHIGRAPH_OIDC_ISSUER` | Keycloak realm HTTPS issuer |
| `PACHIGRAPH_OIDC_AUDIENCE` | Access-token audience; defaults to `pachigraph` |
| `PACHIGRAPH_ALLOWED_SUBJECTS` | Explicit comma-separated subject allowlist; empty denies everyone |
| `PACHIGRAPH_OIDC_JWKS_URL` | Optional trusted internal JWKS endpoint |
| `VINEXT_TRUSTED_HOSTS` | Explicit Envoy hostname; enables forwarded HTTPS origin verification |
| `HOST`, `PORT` | Bind address and port; defaults to `0.0.0.0:3000` |

Run `make check`, `make build`, then `npm start`. Tests requiring PostgreSQL use
`PACHIGRAPH_TEST_DATABASE_URL` with a disposable test database; never target
production with tests. SQL migrations are ordered, transactionally serialized,
and hash checked. Readiness checks PostgreSQL and S3; `/health` checks the server.
The production container runs without root or a writable application filesystem.

## Identity and API keys

Envoy performs browser OIDC and forwards the access token. The application
independently verifies its signature, issuer, audience, expiry and allowed subject.
Identity headers and client-selected owner IDs are never trusted. Browser sign-in
is required for `/keys` and `/api/keys`; agent keys cannot manage keys.

Generate separate read and ingest keys with an expiry of 1–365 days. Copy a key
once; PostgreSQL retains only its SHA-256 hash. Read keys allow search, fetch,
status and MCP. Ingest keys allow only ingestion. Neither permits deletion.
Revocation affects the next request; already-authorized work may finish.

## API contract

History responses use `Cache-Control: no-store`. Ownership comes from a verified
browser token or stored API key, never request arguments.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/search?q=words` | Up to 20 sanitized excerpts and original citations |
| `GET /api/fetch?id=revision` | Exact sanitized source revision |
| `GET /api/status` | Owner's counts, indexed text bytes and last ingestion |
| `POST /api/ingest` | Idempotent append of sanitized source records |
| `DELETE /api/thread?id=UUID` | Browser-owner deletion and permanent tombstone |
| `POST /mcp` | Stateless JSON Streamable HTTP: `search`, `fetch`, `status` |

MCP uses `Authorization: Bearer <read-key>`. Configure that header using the
client's secret facility, never a committed manifest. MCP returns the same
owner-bound evidence as HTTP and exposes no ingestion or deletion tools.
The portable [HTTP skill](plugins/pachigraph/README.md) remains available.

Ingestion accepts at most 512 KiB, 100 records per batch, 384 KiB per record and
JSON nesting through depth 64. The request contains `thread_id` and `records`;
each record has a source-event `id`, original `timestamp`, sanitized searchable
`text` and sanitized JSON `record`. See [collector usage](collector/USAGE.md).

Canonical content hashes preserve original event identities separately from
revision identities. Exact retries are idempotent; changed content creates a new
revision. Conditional S3 writes precede indexing. Database failure can leave an
unindexed object; retry repairs the index and owner deletion removes the object.
Per-owner/thread transactions serialize ingestion and deletion. Deletion commits
a tombstone before cleanup; retries finish interrupted cleanup and HTTP 410
prevents collector replay from restoring deleted conversations.

## Qualification and capacity

Use synthetic records to prove browser sign-in, key creation, HTTP/MCP reads,
ingestion, replay, wrong owner/scope, revocation, interrupted retry and deletion.
Then qualify a small active, archived and long-thread sample with the same
collector command intended for incremental runs. Inspect only sanitized output.
Measure PostgreSQL relation/index allocation and S3 object bytes separately;
`status.text_bytes` is logical text size. Existing cluster capacity is finite.
Bulk ingestion and scheduling require explicit complete-workflow acceptance.

Secret detection runs in the trusted collector before transmission. Directly
uploading unscanned records violates the API contract. Detection is not a guarantee
against every secret; unmappable findings fail closed. Fetched history is
untrusted evidence, never new instructions. Codex citation availability depends
on the original local task being retained; stored revision IDs and timestamps
remain usable independently. Cross-owner sharing and other-source collectors are
outside this release.

See [feature status](docs/feature-status.md), [acceptance evidence](docs/acceptance.md)
and the [Kubernetes design](docs/superpowers/specs/2026-09-07-kubernetes-design.md).
