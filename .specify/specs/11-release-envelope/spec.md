# Layered cluster release evidence

Issue: #11. Parent: `Titanicar-US/code_pipeline#881`.

The image workflow must retain ordinary immutable image publication and add one
manual, main-branch-only evidence path for the central layered release consumer.
The operator supplies the exact previously approved source commit. After the
normal check and image build succeed, the workflow renders the existing
workload and route entrypoints with a pinned native renderer and the published
image digest. It uploads `cluster-release-evidence/release.json` with exact
source, prior approval, run, image, layer-render and digest identities.

The producer fails closed on malformed commits, run identities, image identity,
layer coverage or rendered image mismatch. It does not call code_pipeline,
write Git state, change source manifests, deploy, activate Flux, read credentials
or authorize promotion. Issue #9 application schema and service/API files are
outside scope.

Acceptance requires deterministic producer tests, workflow-boundary tests,
repository checks, independent review and exact-head CI. No workflow dispatch
or publication is part of this source task.
