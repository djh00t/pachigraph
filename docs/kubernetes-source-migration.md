# Pachigraph Kubernetes source migration

Issue #2 prepares Pachigraph for [cluster migration #878](https://github.com/Titanicar-US/code_pipeline/issues/878).
The approved central snapshot is `3a9299607128bd633bcd7e39ed25b6dcc78da8a7`.
It preserves current objects; it does not deploy or transfer live ownership.

## Native source configuration

`infra/k8s/workload/` renders the existing Pachigraph Deployment, Service and
NetworkPolicy with current dev01 root labels/selectors. `infra/k8s/routes/`
renders the browser/API HTTPRoutes and existing browser OIDC policy with their
raw gateway-child labels. The parent is a combined offline preview.

The manifests use native Kubernetes JSON. JSON-formatted, extensionless
`Kustomization` files are a standard Kustomize filename and valid YAML; existing
Node/JSON tests can parse them without adding a YAML dependency. This also
avoids YAML formatters rewriting JSON-formatted .yaml files into a different
syntax. Ordinary JSON source files and TypeScript tests remain format-friendly.

Preserve the current image digest, namespace, Service port 80/pod port 3000,
non-root/read-only filesystem/capability restrictions and ephemeral /tmp mount.
No persistent claim or host port is added. NetworkPolicy restricts ingress to
the existing Envoy namespace on application port 3000; it declares no new egress
policy. Browser OIDC policy and the separately authenticated API route
retain their existing boundaries. The browser policy has no gateway CIDR
authorization block. The API route is outside that browser policy and relies
on application bearer validation and PACHIGRAPH_ALLOWED_SUBJECTS. Do not infer
a gateway home-IP allowlist from this source bundle. Shared Postgres, S3/bucket and allowed-subject
Secret references, image pull identity and database wiring stay centrally
managed. Shared namespaces and broad existing database credentials are not
full tenant isolation.

Readiness remains /ready on the HTTP port and liveness /health, with their
current intervals/timeouts. Neither probe proves database/bucket isolation or
application data recovery. No authenticated live probe is invoked here.

## Offline verification

```bash
node --test tests/kubernetes-sources.test.ts
kubectl kustomize infra/k8s/workload --load-restrictor=LoadRestrictionsNone
kubectl kustomize infra/k8s/routes --load-restrictor=LoadRestrictionsNone
```

The one-time `.specify/specs/2-pachigraph-source-bundles/verify_central_baseline.py`
compares all three workload and three route/policy objects with full approved
central-owner renders. Run it using code_pipeline's existing Python/PyYAML and
kubectl environment, with `--central-repo /absolute/path/to/approved/code_pipeline`.
This is shared execution-stage verification, not a new Pachigraph dependency.
The frozen Git object must exist locally; no repository fetch, cluster/provider
or memory API call occurs. Secret bodies are not parsed or decrypted and inline
configuration is not printed. Permanent tests use only Node built-ins and
current JSON; they require no historical/external checkout or kubectl.

## Release and ownership gates

Existing central release behavior remains authoritative until accepted
per-application cutover. This PR changes no workflow/package/lock and performs no database or memory
mutation. Existing image CI publishes SHA-tagged candidate images on codex
branch pushes (and main); routine branch delivery can therefore publish a
candidate. It does not update the pinned workload digest or activate/deploy
that image. Candidate publication is not production promotion approval. A source merge does not
establish source-read access, registry trust, permissions or operational health.

Before live adoption follow the central migration procedure: qualify private
Git access, approved image/bindings and explicit Secret references; refresh
full render/inventory/UIDs and data recovery evidence; protect pruning through
current root/gateway owners; stage destinations suspended; release old desired
ownership without deletion; activate approved sources; verify unique ownership,
unchanged endpoints/access/templates/data; observe two reconciliation intervals
and 30 minutes of safe runtime qualification; demonstrate reverse handoff and
obtain operator acceptance. The installed controller's artifact/path builder
must be verified for parent-file entrypoints and the native Kustomization name.

Preparation rollback removes only these files. Live rollback reverses protected
ownership in stages; a simple reference revert must not leave competing owners.
No credential rotation, storage/database migration or access expansion is
included in this source stage.
