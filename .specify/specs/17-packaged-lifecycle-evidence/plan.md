# Plan

## Boundaries

Build a repository-local consumer fixture and validator around the existing
`quality-evidence-v1` contract. Do not add a service, scheduler, graph store or
provider adapter. The Agent Brain repository remains the contract owner.

## Delivery slices

1. Add a native regression test for the pull-request trigger policy, then limit
   `check.yml` to main-targeting pull requests while preserving `workflow_call`.
2. Pin the shared contract source URL, exact revision, schema digest and fixture
   binding supplied by the Agent Brain owner.
3. Add one shadow-only typed model fixture and one deterministic packaged
   lifecycle evidence builder using standard Node APIs.
4. Test valid connected evidence plus fail-closed status, digest, dependency,
   invalidation, broad-fallback and mandatory-overlay cases.
5. Document how operators distinguish package evidence from manual release,
   runtime and acceptance evidence.

## Files

- `.github/workflows/check.yml`
- `tests/workflow-policy.test.ts`
- `tooling/package-lifecycle-evidence.mjs`
- `tests/package-lifecycle-evidence.test.ts`
- `tests/fixtures/package-lifecycle/shadow-model.json`
- `docs/packaged-lifecycle-qa.md`

The issue-scoped spec, plan and task files record coordination and evidence.

## Verification

Run the focused Node tests first. Then run `make check` with the existing
isolated PostgreSQL fixture contract and `git diff --check`. Feature commits use
`[skip ci]`; the supporting pull request targets `release/0.1.0`. GitHub Codex
and independent current-change review must clear exact heads before supporting
merges. Final release to `main` is human-only and runs the full workflow.

## Rollback

Revert each one-file commit. Restoring the unguarded pull-request trigger would
also restore feature-branch Actions, so record that policy change explicitly.
No rollback touches runtime state or evidence already produced elsewhere.
