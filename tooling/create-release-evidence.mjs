import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = 'ghcr.io/djh00t/pachigraph';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function buildReleaseEvidence(input) {
  if (!SHA.test(input.sourceCommit) || !SHA.test(input.previousCommit)) {
    throw new Error('source commits must be lowercase full SHAs');
  }
  const [name, digest] = input.image.split('@');
  if (name !== IMAGE || !DIGEST.test(digest ?? '')) {
    throw new Error('published image must be the immutable Pachigraph image');
  }
  for (const [layer, rendered] of Object.entries(input.layers)) {
    if (
      !['workload', 'routes'].includes(layer) ||
      typeof rendered !== 'string' ||
      !rendered.trim()
    ) {
      throw new Error('workload and routes renders are required');
    }
  }
  if (Object.keys(input.layers).sort().join(',') !== 'routes,workload') {
    throw new Error('publication must contain exactly workload and routes');
  }
  if (!input.layers.workload.includes(input.image)) {
    throw new Error('workload render must contain the published image');
  }
  if (/^\s*image\s*:/m.test(input.layers.routes)) {
    throw new Error('routes render must not contain container images');
  }
  const workload = {
    rendered: input.layers.workload,
    render_digest: sha256(input.layers.workload),
    images: [{ name, digest }],
  };
  const routes = {
    rendered: input.layers.routes,
    render_digest: sha256(input.layers.routes),
    images: [],
  };
  return {
    application: 'pachigraph',
    environment: 'cluster-current',
    repository: 'djh00t/pachigraph',
    manifest_path: 'infra/k8s/workload',
    source_commit: input.sourceCommit,
    previous_commit: input.previousCommit,
    render_digest: workload.render_digest,
    images: [input.image],
    ci_run_id: positiveInteger(input.runId, 'run ID'),
    ci_run_attempt: positiveInteger(input.runAttempt, 'run attempt'),
    layers: { workload, routes },
  };
}

function argumentsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('arguments must be named key-value pairs');
    }
    result[key.slice(2)] = value;
  }
  return result;
}

export function main(values = process.argv.slice(2)) {
  const args = argumentsFrom(values);
  const required = [
    'source-commit',
    'previous-commit',
    'run-id',
    'run-attempt',
    'image',
    'workload-render',
    'routes-render',
    'output',
  ];
  if (Object.keys(args).sort().join(',') !== required.sort().join(',')) {
    throw new Error('exact release evidence arguments are required');
  }
  const evidence = buildReleaseEvidence({
    sourceCommit: args['source-commit'],
    previousCommit: args['previous-commit'],
    runId: args['run-id'],
    runAttempt: args['run-attempt'],
    image: args.image,
    layers: {
      workload: readFileSync(args['workload-render'], 'utf8'),
      routes: readFileSync(args['routes-render'], 'utf8'),
    },
  });
  writeFileSync(args.output, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
