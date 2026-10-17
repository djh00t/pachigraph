# Issue 17: packaged lifecycle evidence

## Purpose

Prove one connected Pachigraph package lifecycle with deterministic evidence
that can be consumed by the existing Agent Brain quality-evidence graph. Keep
isolated checks, source delivery, manual release evidence, runtime qualification
and operator acceptance as distinct facts.

## Requirements

1. Emit the frozen `quality-evidence-v1` consumer shape with component,
   contract, data, artifact, journey, check and evidence nodes.
2. Use only passed, failed, blocked, skipped, stale and unknown statuses.
3. Bind each node to source-qualified artifacts, exact revisions, UTC start/end,
   duration and SHA-256 inputs, toolchain, configuration, fixtures and policy
   digests.
4. Use exact-revision requires, produces and covers edges. A digest change
   invalidates its node and transitive requires descendants.
5. Unknown or stale evidence selects broad deterministic checks.
6. Money, authentication, tenant, persistence, migration and recovery overlays
   are explicit and mandatory. Model output cannot waive them.
7. A typed model adapter is shadow-fixture-only. It cannot call a provider,
   upload private data, use credentials or replace deterministic checks.
8. Supporting feature pull requests into a release branch create no GitHub
   Actions runs. Main-targeting release and dependency pull requests retain the
   repository check.

## Acceptance

- One native packaged journey fixture and test prove graph shape, dependency
  closure, digest stability, invalidation, broad fallback and risk overlays.
- A native workflow-policy test proves `check.yml` targets only pull requests
  whose base is `main` and remains callable by the image workflow.
- Existing tests remain and the changed scope passes the repository checks.
- The shared graph contract exact revision is recorded before consumer fixture
  integration.

## Exclusions

No new orchestrator, provider call, private upload, paid call, credential or
access change, workflow dispatch, deployment, runtime mutation, manual release
evidence, runtime qualification or operator acceptance.
