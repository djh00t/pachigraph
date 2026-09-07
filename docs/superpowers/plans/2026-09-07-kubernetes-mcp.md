# Kubernetes MCP implementation plan

> Execute in this task with `superpowers:executing-plans`, using bounded review
> checkpoints. Application changes remain in Pachigraph; operational manifests
> remain in the separate code_pipeline checkout.

**Goal:** Run the accepted website, HTTP API and restored MCP server on dev01
through Flux with existing PostgreSQL and S3-compatible storage.

**Architecture:** Standalone vinext/Node application. PostgreSQL indexes and
tombstones, immutable S3 JSON, Keycloak OIDC browser identity, scoped agent keys.

**Tech stack:** Existing React/vinext, pg, AWS S3 SDK, JOSE, MCP SDK, Flux/Envoy.

**Spec:** [Kubernetes design](../specs/2026-09-07-kubernetes-design.md).

## Constraints

- Preserve canonical record hashes, owner isolation and source transcripts.
- No Sites authentication bypass, client-supplied identity, or plaintext secrets.
- Reuse cluster services; provision no duplicate database/object-store server.
- Validate every new direct dependency with Dependency Advisor standard policy.
- Do not merge or activate unreviewed deployment configuration.
- Personal sample, bulk import and scheduling retain their qualification gates.

## Tasks

### 1. PostgreSQL and S3 storage

Files: `db/index.ts`, `db/migrate.ts`, `db/migrations/0001_initial.sql`,
`server/history.ts`, `server/api-keys.ts`, `server/objects.ts`,
`tests/history.test.ts`, `tests/api-keys.test.ts`, `tests/objects.test.ts`.

- [ ] Write failing PostgreSQL lifecycle checks using synthetic owner/thread IDs:
  ingest, duplicate, changed revision, fetch, literal search, wrong owner,
  interrupted object write, interrupted database write, tombstone and cleanup retry.
- [ ] Preserve `createHistory(...).ingest/search/fetch/status/deleteThread` return
  contracts while moving queries to PostgreSQL and S3 commands.
- [ ] Use `INSERT ... ON CONFLICT DO NOTHING` and a generated `tsvector` GIN index.
- [ ] Lock each owner/thread inside ingest/delete transactions with
  `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`.
- [ ] Apply ordered SQL migrations under a database advisory lock. Record applied
  filenames and content hashes; reject edited applied migrations.
- [ ] Verify relation/index bytes with `pg_total_relation_size`, separately from
  logical text bytes and object bytes. Expose allocation only to operators.
- [ ] Remove obsolete D1 bindings, SQLite fixtures and R2-specific build code.

### 2. Browser identity and MCP

Files: `server/auth.ts`, `app/auth.ts`, `app/page.tsx`,
`app/api/[action]/route.ts`, `server/mcp.ts`, `app/mcp/route.ts`,
`tests/auth.test.ts`, `tests/mcp.test.ts`, plugin manifests and documentation.

- [ ] Test signed/expired/wrong-audience/wrong-issuer JWTs with ephemeral local
  signing keys and a loopback JWKS endpoint; reject spoofed identity headers.
- [ ] Verify Keycloak tokens and the explicit subject allowlist in the application.
- [ ] Keep scoped API-key resolution separate from browser key management.
- [ ] Restore SDK `search` and `fetch` tools plus read-only `status`; bind the
  resolved owner in the handler and test actual SDK client requests.
- [ ] Test malformed bodies, foreign Origin, denied scope and revoked keys.
- [ ] Update skill and portable plugin examples for configurable Kubernetes URL.

### 3. Standalone container and release checks

Files: `vite.config.ts`, `next.config.ts`, `package.json`, `Dockerfile`,
`.dockerignore`, `.github/workflows/check.yml`, `.github/workflows/image.yml`,
`tests/local-api-keys.py`, `Makefile`, README and release evidence.

- [ ] Build with `output: 'standalone'` and start the isolated output without
  Cloudflare bindings. Copy SQL migrations into the image.
- [ ] Run with a non-root user, a bounded connection pool and explicit environment.
- [ ] Add `/health` and `/ready` checks; readiness probes both storage services.
- [ ] Exercise synthetic key creation, read/MCP/ingest, replay and revocation
  against the built server. Stop test processes and remove synthetic resources.
- [ ] Run `make check`, production build, container smoke and plugin validation.
- [ ] Review the complete diff before publication; pin the image by digest.

### 4. Flux deployment ownership

Files in code_pipeline only: issue-linked `.specify/specs/` package,
`platform/targets/k8s-flux/apps/pachigraph/`, apps/gateway kustomizations,
Gateway TLS listener/certificate, focused validation and Docusaurus runbook.

- [ ] Locate/create the tracking issue and acquire the repository path lease.
- [ ] Reference existing PostgreSQL, AWS credential Secret and GHCR pull secret.
- [ ] Resolve bucket/region and dedicated Keycloak client/allowed subject values.
- [ ] Add Deployment/Service/HTTPRoute and OIDC SecurityPolicy with separate API
  routing, startup/readiness probes, non-root settings and resource bounds.
- [ ] Validate rendered manifests, secret references and exact-image ownership.
- [ ] Publish reviewed application/image and propose reviewed GitOps desired state.
- [ ] After authorized activation, verify Flux readiness, live authentication,
  real storage growth and synthetic lifecycle behavior before any personal sample.

## Evidence record

Baseline and task completion are recorded in `docs/feature-status.md` and
`docs/acceptance.md`. Missing credentials or infrastructure are external
prerequisites, never substituted with placeholder secrets or a claim of live proof.
