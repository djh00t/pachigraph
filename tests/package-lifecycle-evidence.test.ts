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
  const requiresTiming = ['passed', 'failed'].includes(record.status);
  if (record.started_at === null) {
    assert.equal(requiresTiming, false);
    assert.equal(record.completed_at, null);
    assert.equal(record.duration_ms, null);
    return;
  }
  assert.notEqual(record.completed_at, null);
  assert.notEqual(record.duration_ms, null);
  const startedAt = Date.parse(record.started_at);
  const completedAt = Date.parse(record.completed_at as string);
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
  for (const binding of Object.values(fixture.bindings) as Array<{
    value: string;
    digest: string;
  }>) {
    assert.equal(binding.digest, digest(binding.value));
  }

  assert.equal(fixture.journey.id, 'synthetic-package-lifecycle');
  const expectedSteps = new Map<
    string,
    { requires: string[]; status: string }
  >([
    ['source', { requires: [], status: 'passed' }],
    ['local-check', { requires: ['source'], status: 'passed' }],
    ['feature-review', { requires: ['local-check'], status: 'passed' }],
    ['release-merge', { requires: ['feature-review'], status: 'passed' }],
    ['main-promotion', { requires: ['release-merge'], status: 'blocked' }],
  ]);
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
    assert.equal(seen.has(step.id), false, `duplicate lifecycle step: ${step.id}`);
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
    fixture.outcome_examples.map(({ id, status }: Outcome) => [id, status]),
    [
      ['failed-check', 'failed'],
      ['skipped-provider', 'skipped'],
      ['unknown-contract', 'unknown'],
      ['stale-runtime', 'stale'],
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

  assert.deepEqual(
    [...fixture.deterministic_selection.checks].sort(),
    [
      'authorization',
      'contract',
      'migration',
      'persistence',
      'recovery',
      'tenant',
    ],
  );
  assert.match(fixture.deterministic_selection.reason, /stale/);
});

test('shadow model is fixture-only and cannot waive deterministic selection', () => {
  assert.equal(fixture.shadow_model.fixture_only, true);
  assert.equal(fixture.shadow_model.provider_called, false);
  assert.equal(fixture.shadow_model.private_upload, false);
  assert.equal(fixture.shadow_model.can_waive_deterministic_selection, false);
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
