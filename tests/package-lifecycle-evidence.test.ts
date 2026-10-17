import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/package-lifecycle/shadow-model.json', import.meta.url),
    'utf8',
  ),
);

const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

function assertTiming(record: {
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
}) {
  const requiresTiming = ['passed', 'failed', 'stale'].includes(record.status);
  if (record.started_at === null) {
    assert.equal(requiresTiming, false);
    assert.equal(record.completed_at, null);
    assert.equal(record.duration_ms, null);
    return;
  }
  assert.equal(requiresTiming, true);
  assert.notEqual(record.completed_at, null);
  assert.notEqual(record.duration_ms, null);
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.match(record.started_at, utcTimestamp);
  assert.match(record.completed_at as string, utcTimestamp);
  const startedAt = Date.parse(record.started_at);
  const completedAt = Date.parse(record.completed_at as string);
  assert.equal(new Date(startedAt).toISOString(), record.started_at);
  assert.equal(
    new Date(completedAt).toISOString(),
    record.completed_at as string,
  );
  assert.ok(completedAt >= startedAt);
  assert.ok((record.duration_ms as number) >= 0);
  assert.equal(completedAt - startedAt, record.duration_ms);
}

type Outcome = {
  id: string;
  artifact: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
};

test('journal binds digests and a connected source-qualified lifecycle', () => {
  assert.equal(fixture.fixture_version, 1);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.private_data, false);
  assert.equal(fixture.shared_contract_conformance, 'unclaimed');
  assert.deepEqual(Object.keys(fixture.bindings).sort(), [
    'configuration',
    'fixtures',
    'inputs',
    'policy',
    'toolchain',
  ]);
  const expectedBindingValues: Record<string, string> = {
    inputs:
      'source=aa9839e0ddd54b3ff029c54d918befda3a944c28|release=af62264885bd5310cd4c070e9d50bb33ab67bc7b',
    toolchain: 'node@24|npm-ci|make-check',
    configuration: 'check-base=main|release=0.1.0',
    fixtures: 'synthetic-package-lifecycle-shadow-v1',
    policy: 'feature-actions=off|main-human-only|provider=shadow-only',
  };
  for (const [key, binding] of Object.entries(fixture.bindings) as Array<
    [
      string,
      {
        value: string;
        digest: string;
      },
    ]
  >) {
    assert.equal(binding.value, expectedBindingValues[key]);
    assert.equal(binding.digest, digest(binding.value));
  }

  assert.equal(fixture.journey.id, 'synthetic-package-lifecycle');
  const expectedSteps = new Map<string, { requires: string[]; status: string }>(
    [
      ['source', { requires: [], status: 'passed' }],
      ['local-check', { requires: ['source'], status: 'passed' }],
      ['feature-review', { requires: ['local-check'], status: 'passed' }],
      ['release-merge', { requires: ['feature-review'], status: 'passed' }],
      ['main-promotion', { requires: ['release-merge'], status: 'blocked' }],
    ],
  );
  const expectedArtifacts = new Map([
    [
      'source',
      {
        source_type: 'git',
        project: 'djh00t/pachigraph',
        object_type: 'commit',
        object_id: 'aa9839e0ddd54b3ff029c54d918befda3a944c28',
      },
    ],
    [
      'local-check',
      {
        source_type: 'local',
        project: 'djh00t/pachigraph',
        object_type: 'check-receipt',
        object_id: 'synthetic-make-check',
      },
    ],
    [
      'feature-review',
      {
        source_type: 'github',
        project: 'djh00t/pachigraph',
        object_type: 'pull-request',
        object_id: '18',
      },
    ],
    [
      'release-merge',
      {
        source_type: 'git',
        project: 'djh00t/pachigraph',
        object_type: 'commit',
        object_id: 'af62264885bd5310cd4c070e9d50bb33ab67bc7b',
      },
    ],
    ['main-promotion', null],
  ]);
  const seen = new Set<string>();
  for (const step of fixture.journey.steps) {
    assert.equal(
      seen.has(step.id),
      false,
      `duplicate lifecycle step: ${step.id}`,
    );
    const expected = expectedSteps.get(step.id);
    assert.ok(expected, `unexpected lifecycle step: ${step.id}`);
    assert.deepEqual(step.requires, expected.requires);
    assert.equal(step.status, expected.status);
    for (const dependency of step.requires) assert.ok(seen.has(dependency));
    seen.add(step.id);
    assertTiming(step);
    assert.deepEqual(step.artifact, expectedArtifacts.get(step.id));
  }
  assert.deepEqual([...seen], [...expectedSteps.keys()]);
  const promotion = fixture.journey.steps.at(-1);
  assert.equal(promotion.status, 'blocked');
  assert.equal(promotion.artifact, null);
  assert.match(promotion.reason, /human-only/);
});

test('outcomes retain evidence boundaries and unresolved state selects broad checks', () => {
  assert.deepEqual(
    fixture.outcome_examples.map(({ id, status, artifact }: Outcome) => [
      id,
      status,
      artifact,
    ]),
    [
      ['failed-check', 'failed', 'synthetic-failure-receipt'],
      ['skipped-provider', 'skipped', null],
      ['unknown-contract', 'unknown', null],
      ['stale-runtime', 'stale', 'synthetic-prior-runtime-receipt'],
    ],
  );
  const outcomes = Object.fromEntries(
    (fixture.outcome_examples as Outcome[]).map((value) => [value.id, value]),
  ) as Record<string, Outcome>;
  for (const value of Object.values(outcomes)) {
    assertTiming(value);
    if (['failed', 'stale'].includes(value.status)) assert.ok(value.artifact);
    if (['skipped', 'unknown'].includes(value.status))
      assert.equal(value.artifact, null);
  }

  assert.deepEqual([...fixture.deterministic_selection.checks].sort(), [
    'authorization',
    'contract',
    'migration',
    'persistence',
    'recovery',
    'tenant',
  ]);
  assert.equal(
    fixture.deterministic_selection.reason,
    'stale evidence selects the broad fallback',
  );
});

test('shadow model is fixture-only and cannot waive deterministic selection', () => {
  assert.equal(fixture.shadow_model.fixture_only, true);
  assert.equal(fixture.shadow_model.provider_called, false);
  assert.equal(fixture.shadow_model.private_upload, false);
  assert.equal(fixture.shadow_model.can_waive_deterministic_selection, false);
  assert.deepEqual(fixture.shadow_model.advice, ['contract']);
  assert.ok(
    fixture.shadow_model.advice.every((value: string) =>
      fixture.deterministic_selection.checks.includes(value),
    ),
  );
  assert.ok(
    fixture.deterministic_selection.checks.length >
      fixture.shadow_model.advice.length,
  );
});
