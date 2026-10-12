# Source-owned Flux candidate

These existing JSON manifests and uppercase `Kustomization` files are application-owned source candidates. Current code_pipeline workload and gateway owners remain authoritative until the approved [cluster migration](https://github.com/Titanicar-US/code_pipeline/issues/878) handoff and rollback are accepted. No active source registration is implied.

| Render path | Resources |
| --- | --- |
| `infra/k8s/workload` | Deployment, Service, NetworkPolicy |
| `infra/k8s/routes` | Two HTTPRoutes and SecurityPolicy |
| `infra/k8s` | Aggregate for review; transfer workload and routes independently |

Use `kubectl kustomize <path>`. JSON is valid Kubernetes input; retain the native uppercase filename. Existing tests in `tests/kubernetes-sources.test.ts` cover the source boundaries and native rendering. All six resources preserve the approved cluster namespace, labels/selectors, image digest, ports, mounts and authentication/network restrictions. Do not create another copied bundle.

code_pipeline owns environment registrations, approved source/image references, shared Postgres/RustFS/Keycloak, encrypted credentials, access policies and provisioning. Existing Secret references do not approve access or prove isolation. Source credentials, bindings, recovery, current-owner pruning protection, staged single-owner handoff, two successful Flux intervals,30-minute runtime qualification and operator acceptance remain prerequisites. Do not apply the aggregate directly or activate a candidate.

After accepted cutover, release through reviewed references rather than copying manifests back centrally. Existing image CI publishes immutable images; it does not deploy and publication is not runtime acceptance. Keep the approved image during ownership migration.

Documentation rollback has no live effect. Live rollback must reverse the staged ownership transfer; a simple source revert must not leave competing reconcilers. Preserve existing databases, bucket objects, credentials and persistent identities through qualification and rollback.
