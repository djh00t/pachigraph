import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = new URL('../infra/k8s/', import.meta.url);
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, source), 'utf8'));
const workload = read('app.json').items;
const network = read('network-policy.json');
const routes = read('route.json').items;
const deployment = workload.find(
  (resource: { kind: string }) => resource.kind === 'Deployment',
);
const service = workload.find(
  (resource: { kind: string }) => resource.kind === 'Service',
);
const pod = deployment.spec.template.spec;
const container = pod.containers[0];
const labels = {
  'app.kubernetes.io/instance': 'dev01',
  'app.kubernetes.io/part-of': 'codex-specops',
  'app.kubernetes.io/managed-by': 'fluxcd',
};

test('source layers contain exactly the existing six resource identities', () => {
  const resources = [...workload, network, ...routes];
  assert.deepEqual(
    resources.map((resource) => [
      resource.kind,
      resource.metadata.namespace,
      resource.metadata.name,
    ]),
    [
      ['Deployment', 'codex-specops', 'pachigraph'],
      ['Service', 'codex-specops', 'pachigraph'],
      ['NetworkPolicy', 'codex-specops', 'pachigraph'],
      ['HTTPRoute', 'codex-specops', 'pachigraph-browser'],
      ['HTTPRoute', 'codex-specops', 'pachigraph-api'],
      ['SecurityPolicy', 'codex-specops', 'pachigraph-oidc'],
    ],
  );
  assert.deepEqual(read('Kustomization').resources, ['workload', 'routes']);
  const workloads = read('workload/Kustomization');
  assert.deepEqual(workloads.resources, [
    '../app.json',
    '../network-policy.json',
  ]);
  assert.deepEqual(workloads.labels, [
    { includeSelectors: true, pairs: labels },
  ]);
  const routeLayer = read('routes/Kustomization');
  assert.deepEqual(routeLayer.resources, ['../route.json']);
  assert.equal(routeLayer.labels, undefined);
});

test('API/browser pod preserves selectors, ports, restricted filesystem and ephemeral mounts', () => {
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.selector.matchLabels, service.spec.selector);
  assert.deepEqual(
    deployment.spec.template.metadata.labels,
    service.spec.selector,
  );
  assert.deepEqual(service.spec.ports, [
    { name: 'http', port: 80, targetPort: 'http' },
  ]);
  assert.deepEqual(container.ports, [{ name: 'http', containerPort: 3000 }]);
  assert.match(
    container.image,
    /^ghcr\.io\/djh00t\/pachigraph@sha256:[0-9a-f]{64}$/,
  );
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.deepEqual(container.volumeMounts, [
    { name: 'tmp', mountPath: '/tmp' },
  ]);
  assert.deepEqual(pod.volumes, [
    { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
  ]);
  assert.deepEqual(pod.imagePullSecrets, [{ name: 'ghcr-read' }]);
  const env = Object.fromEntries(
    container.env.map((entry: { name: string }) => [entry.name, entry]),
  );
  assert.deepEqual(env.POSTGRES_PASSWORD_URLENCODED.valueFrom.secretKeyRef, {
    name: 'codex-specops-runtime',
    key: 'POSTGRES_PASSWORD_URLENCODED',
  });
  assert.deepEqual(env.PACHIGRAPH_ALLOWED_SUBJECTS.valueFrom.secretKeyRef, {
    name: 'pachigraph',
    key: 'allowed-subjects',
  });
  assert.deepEqual(env.S3_BUCKET.valueFrom.secretKeyRef, {
    name: 'pachigraph',
    key: 's3-bucket',
  });
  assert.equal(
    env.DATABASE_URL.value,
    'postgresql://postgres:$(POSTGRES_PASSWORD_URLENCODED)@postgres:5432/specops',
  );
  assert.equal(env.PACHIGRAPH_OIDC_AUDIENCE.value, 'pachigraph');
});

test('network ingress remains limited to Envoy namespace on application port', () => {
  assert.deepEqual(network.spec.podSelector.matchLabels, service.spec.selector);
  assert.deepEqual(network.spec.policyTypes, ['Ingress']);
  assert.deepEqual(network.spec.ingress, [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: {
              'kubernetes.io/metadata.name': 'envoy-gateway-system',
            },
          },
        },
      ],
      ports: [{ protocol: 'TCP', port: 3000 }],
    },
  ]);
  assert.equal(network.spec.egress, undefined);
});

test('browser OIDC and separately authenticated API routes retain current boundaries', () => {
  const browserPolicy = routes.find(
    (resource: { kind: string }) => resource.kind === 'SecurityPolicy',
  );
  assert.equal(browserPolicy.spec.authorization, undefined);
  assert.deepEqual(browserPolicy.spec.targetRefs, [
    {
      group: 'gateway.networking.k8s.io',
      kind: 'HTTPRoute',
      name: 'pachigraph-browser',
    },
  ]);
  for (const route of routes.filter(
    (resource: { kind: string }) => resource.kind === 'HTTPRoute',
  )) {
    assert.deepEqual(route.spec.parentRefs, [
      {
        name: 'codex-specops-public',
        namespace: 'codex-specops',
        sectionName: 'pachigraph-https',
      },
    ]);
    assert.deepEqual(route.spec.hostnames, ['pachigraph.e164sip.com']);
    assert.deepEqual(route.spec.rules[0].backendRefs, [
      { name: 'pachigraph', port: 80 },
    ]);
    assert.deepEqual(route.spec.rules[0].timeouts, {
      request: '60s',
      backendRequest: '55s',
    });
  }
  assert.deepEqual(routes[0].spec.rules[0].matches, [
    { path: { type: 'PathPrefix', value: '/' } },
    { path: { type: 'PathPrefix', value: '/api/keys' } },
    { path: { type: 'PathPrefix', value: '/api/thread' } },
  ]);
  assert.deepEqual(routes[1].spec.rules[0].matches, [
    { path: { type: 'PathPrefix', value: '/api' } },
    { path: { type: 'PathPrefix', value: '/mcp' } },
  ]);
  const policy = routes[2].spec;
  assert.deepEqual(policy.targetRefs, [
    {
      group: 'gateway.networking.k8s.io',
      kind: 'HTTPRoute',
      name: 'pachigraph-browser',
    },
  ]);
  assert.equal(policy.oidc.clientID, 'pachigraph');
  assert.deepEqual(policy.oidc.clientSecret, { name: 'pachigraph' });
  assert.equal(policy.oidc.forwardAccessToken, true);
  assert.deepEqual(policy.oidc.scopes, ['openid', 'profile', 'email']);
  assert.equal(policy.basicAuth, undefined);
});
