# Plan

Base: `main@cec1a7677ad82352f699a803a94098eff762d212`.
Lease: `9a0a7859-127f-4628-b2a1-87b1cd5f97c8`.

1. Encode the existing code_pipeline layered `release.json` contract in a small
   dependency-free Node producer.
2. Add positive and negative producer tests and workflow-boundary checks.
3. Extend the existing image workflow with a manual main-only evidence path,
   pinned native rendering and a single redacted JSON artifact.
4. Document operator inputs, evidence meaning and retained approval gates.
5. Run focused and repository checks, one-file commits, independent review and
   exact-head CI before human merge.

Rollback reverts the source files. No runtime rollback applies because this task
does not dispatch the workflow or alter deployed state.
