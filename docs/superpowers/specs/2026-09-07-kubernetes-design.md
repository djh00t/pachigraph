# Pachigraph Kubernetes release

## Decision and ownership

The owner requested Kubernetes deployment through Flux, keeping application code
in `djh00t/pachigraph` and deployment configuration in `code_pipeline`. GitHub
redirects the latter to `Titanicar-US/code_pipeline`. Its existing dev01 target
provides PostgreSQL, Keycloak and Envoy Gateway. The owner selected existing
PostgreSQL and S3-compatible storage, preferring an existing MinIO endpoint if one
is available. Live service inventory found PostgreSQL but no MinIO service;
the cluster runtime Secret has AWS credential entries.

Pachigraph owns its Node application, PostgreSQL migrations, S3 client, MCP
server, collector, skill, tests, Dockerfile and image build workflow.
`code_pipeline` owns only deployment manifests, Flux wiring, encrypted/runtime
secret references, validation, and operational documentation. Do not copy the
application source into the deployment repository.

## Runtime

Use the existing vinext React application with its standalone Node output.
Keep the accepted interface and HTTP record/citation contracts. Remove the
Cloudflare build/runtime dependency rather than maintaining two implementations.
The existing deployed Sites version and its stored data remain untouched.

PostgreSQL stores owner-scoped revisions, API-key digests, tombstones and a GIN
full-text index in the `pachigraph` schema. Versioned SQL migrations are owned by
the application. Preserve canonical hashing and source timestamps exactly.
Serialize ingestion and deletion per owner/thread with PostgreSQL transaction
advisory locks. S3 stores immutable canonical source JSON under the existing
owner-hash/thread/source/revision key structure. Conditional puts preserve
original objects; retries tolerate an object written before a database failure.
Commit deletion tombstones before object cleanup, so failed cleanup remains
retryable and cannot make the thread visible again.

Use the AWS SDK with an optional endpoint and path-style addressing for MinIO;
AWS S3 uses the normal regional endpoint. Buckets are pre-provisioned, never
created during application startup. Credentials come from Kubernetes Secrets or
the AWS credential provider chain, never from source or returned status data.

## Authentication and ingress

Reuse Envoy's Keycloak OIDC integration for browser login. A dedicated client
issues access tokens with audience `pachigraph`; verify signature, issuer,
audience, expiry and subject with JOSE in the application. Require an explicit
subject allowlist to retain private access. Never trust user-supplied identity
headers. Browser key management uses this verified identity.

Read/ingest API keys retain expiry, revocation and separate grants. A read key
may call only HTTP search/fetch/status and the read-only MCP endpoint. Ingest
keys may call only ingestion. API and MCP routes reach application authentication
without a browser-login redirect; website/key-management/deletion routes use OIDC.
Both paths preserve application-level owner isolation. MCP tools never accept
an owner argument. Use the maintained SDK's stateless Streamable HTTP transport.

Default deployment hostname is `pachigraph.e164sip.com` on dev01, using the
existing Envoy Gateway and certificate-management conventions. Hostname, allowed
subjects, database credentials and object-storage configuration must be resolved
before live deployment. No home-IP-only policy is applied to authenticated agent
API traffic; it must be usable by authorized remote clients.

## Delivery and qualification

Build one non-root container from Pachigraph and pin its immutable image in Flux.
Use startup migration locking, database/object-storage readiness, resource bounds,
and graceful process shutdown. Runtime credentials remain encrypted in GitOps.
Do not change existing applications or repair the unrelated conflicted local
`code_pipeline` checkout. Work from a fresh isolated checkout.

Validate real PostgreSQL queries and S3 requests with synthetic records before
live qualification. Prove exact replay, append/backfill, interruption, concurrent
delete/ingest, wrong-owner reads, API-key scope/revocation, citations and measured
database allocation. Container startup must work without Sites headers or runtime
bindings. Test the packaged MCP server with the actual SDK client.

Local checks, image publication, Flux reconciliation, browser login and live
read/ingest/MCP proof are separate evidence. Do not import personal history until
authentication and storage are qualified. Complete-workflow acceptance remains
required before bulk ingestion or installing a daily job.

## Rollback

Keep the current Sites deployment available during qualification. A Kubernetes
rollback restores the previous pinned image through Flux; it does not delete the
database, bucket or source transcripts. Roll back schema changes only with an
explicit data-preserving migration. Removing a workload must not prune shared
PostgreSQL or object-storage resources.
