# Existing source-owned Flux configuration

Issue #5; parent Titanicar-US/code_pipeline#882, epic#878. Existing infra/k8s uses JSON manifests and uppercase Kustomization entrypoints. Native workload/routes renders match all six current central resources exactly. Correct repository documentation to identify this source candidate and separate current central ownership from eventual application ownership. No manifests, workflows, dependencies, credentials, database/schema/storage/activation changes. Preserve source basebc51b5ba and approved runtime image40add1e4.

Acceptance: exact six-resource render equality, updated README and infra/k8s guidance, repository make check with Node24 and an isolated synthetic disposable database, independent review/CI. Source access, binding/recovery/pruning/handoff, two Flux intervals,30-minute qualification, rollback and operator acceptance remain live gates. No new bundle or test helper is needed.
