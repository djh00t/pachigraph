# Pachigraph source preparation evaluation

Issue #2; central epic #878/workstream #882. Frozen central source `3a9299607128bd633bcd7e39ed25b6dcc78da8a7`. Native repair starts from `4510d3c1458a12ae20545b6e98de7762400845ed`; lease `ff9a4507-1d90-4c23-8ae6-2a5d0d3d252d`.

## Verification

Canonical app/network/route JSON moved with unchanged bytes into self-contained workload/routes entrypoints; root aggregate and transformations are unchanged. Five focused Node tests passed, including default native workload/routes/root renders and source immutability. All six complete objects match the frozen central baseline: selectors, ports, mounts, namespace, image, references and access policy remain identical. Source builds use default restrictions; only the frozen historical central render retains an explicit bypass.

Full `make check` exited 0 against a dedicated PostgreSQL17 fixture matching CI. The test database used the guarded random `pachigraph_test_<32hex>` namespace, a loopback-only published port, no host data mounts, and an environment excluding provider credentials. The temporary container was removed after testing. This performed synthetic database operations only, with no live database/provider/cluster calls. All 37 Node tests passed with zero skips, plus 39 collector and six plugin Python tests. TypeScript, lint and source formatting checks passed; no dependency/lock/workflow/application code changes.

Native stage rendering is mandatory and ran here. Permanent tests use current JSON/Node built-ins with no external checkout/history; the native regression skips only when kubectl is unavailable. One-time full comparison uses existing Python/PyYAML, prints identities only and does not parse/decrypt Secret bodies. Independent focused review found no actionable blockers and independently verified byte identity, strict native union and frozen parity. Revised exact-head CI and candidate publication evidence are pending delivery.

## Remaining gates

Browser policy retains OIDC without a gateway CIDR block; the API retains application bearer/allowed-subject validation. Broad existing database credentials and shared namespaces are not full tenant isolation. Release-helper/reference/binding qualification, source access, publication trust, current live identities, pruning/recovery/runtime/reverse-handoff and operator acceptance remain open.

Existing codex/main image CI can publish a candidate during routine source delivery. Candidate publication does not update the pinned workload digest or approve/deploy the image; record its exact run/digest separately. Existing dependency security findings remain tracked in issue3; no remediation or security qualification is claimed.

Preparation rollback reverts source artifacts only; any live rollback requires protected single-owner reverse transfer. Existing release authority remains unchanged. No live credential/provisioning/storage/activation change or service upgrade occurred; wave4 and cluster completion remain unproven.
