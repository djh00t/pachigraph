# Plan

1. Verify approved bases, issue, isolation and exact lease; notify Steve/affected owners.
2. Materialize only selected non-secret central desired objects into `infra/k8s`; retain current platform/dependency ownership.
3. Add independent workload/route render entrypoints, preserving complete owner-specific transformations.
4. Add object-level tests without historical/external-checkout dependency; record one-time full central render parity outside default tests.
5. Document current source dependencies, existing release authority, workload auth/placement/activation and protected handoff/reverse handoff.
6. Run relevant repository make check and independent review; publish one-file commits and main-targeted PR; monitor exact-head CI without approving/merging/deploying.

Rollback removes preparation artifacts only; no live inventory changes. Any later live rollback follows the protected central ownership-transfer procedure.

## Native repair plan

1. Record source head/lease/prerequisites on issue2 and notify Steve before edits.
2. Move canonical files into self-contained child entrypoints and update test consumers, preserving raw bytes and root aggregate.
3. Prove native default workload/routes/aggregate rendering and full frozen six-object parity using existing tools; no dependency installation or unsafe database test target.
4. Update docs/evaluation; run relevant checks and independent review; update existing PR4 through one-file commits and monitor exact-head CI/candidate publication separately. Keep all live gates open.
