import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildReleaseEvidence,
  main,
} from '../tooling/create-release-evidence.mjs';

const sourceCommit = 'a'.repeat(40);
const previousCommit = 'b'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const image = `ghcr.io/djh00t/pachigraph@${digest}`;
const workload = `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - image: ${image}\n`;
const routes = 'apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\n';
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

function input() {
  return {
    sourceCommit,
    previousCommit,
    runId: '42',
    runAttempt: '1',
    image,
    layers: { workload, routes },
  };
}

test('builds the exact layered consumer envelope', () => {
  const evidence = buildReleaseEvidence(input());
  assert.equal(evidence.source_commit, sourceCommit);
  assert.equal(evidence.previous_commit, previousCommit);
  assert.equal(evidence.ci_run_id, 42);
  assert.equal(evidence.ci_run_attempt, 1);
  assert.deepEqual(evidence.images, [image]);
  assert.equal(evidence.render_digest, hash(workload));
  assert.deepEqual(evidence.layers.workload, {
    rendered: workload,
    render_digest: hash(workload),
    images: [{ name: 'ghcr.io/djh00t/pachigraph', digest }],
  });
  assert.deepEqual(evidence.layers.routes, {
    rendered: routes,
    render_digest: hash(routes),
    images: [],
  });
});

test('rejects malformed identities and incomplete layer evidence', () => {
  for (const mutate of [
    (value: ReturnType<typeof input>) => (value.sourceCommit = 'short'),
    (value: ReturnType<typeof input>) =>
      (value.image = 'ghcr.io/other/app@' + digest),
    (value: ReturnType<typeof input>) => (value.runId = '0'),
    (value: ReturnType<typeof input>) =>
      delete (value.layers as { routes?: string }).routes,
    (value: ReturnType<typeof input>) =>
      (value.layers.workload = workload.replace(image, 'missing')),
    (value: ReturnType<typeof input>) =>
      (value.layers.routes += 'image: forbidden\n'),
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => buildReleaseEvidence(value));
  }
});

test('CLI creates one fresh deterministic JSON file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pachigraph-release-'));
  const workloadPath = join(directory, 'workload.yaml');
  const routesPath = join(directory, 'routes.yaml');
  const output = join(directory, 'release.json');
  writeFileSync(workloadPath, workload);
  writeFileSync(routesPath, routes);
  const args = [
    '--source-commit',
    sourceCommit,
    '--previous-commit',
    previousCommit,
    '--run-id',
    '42',
    '--run-attempt',
    '1',
    '--image',
    image,
    '--workload-render',
    workloadPath,
    '--routes-render',
    routesPath,
    '--output',
    output,
  ];
  main(args);
  assert.deepEqual(
    JSON.parse(readFileSync(output, 'utf8')),
    buildReleaseEvidence(input()),
  );
  assert.throws(() => main(args));
});

test('image workflow restricts evidence to an explicit main dispatch', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/image.yml', import.meta.url),
    'utf8',
  );
  for (const required of [
    'previous_commit:',
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    'cluster-release-evidence',
    'tooling/create-release-evidence.mjs',
    '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]) {
    assert.ok(workflow.includes(required), required);
  }
  assert.ok(!workflow.includes('repository_dispatch'));
});
