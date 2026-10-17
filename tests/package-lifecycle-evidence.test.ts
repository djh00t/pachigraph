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
}) {
  if (record.started_at === null) {
    assert.equal(record.completed_at, null);
    assert.equal(record.duration_ms, null);
    return;
  }
  assert.notEqual(record.completed_at, null);
  assert.equal(
    Date.parse(record.completed_at as string) - Date.parse(record.started_at),
    record.duration_ms,
  );
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
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.private_data, false);
  assert.equal(fixture.shared_contract_conformance, 'unclaimed');
  for (const binding of Object.values(fixture.bindings) as Array<{
    value: string;
    digest: string;
  }>) {
    assert.equal(binding.digest, digest(binding.value));
  }

  const expectedRequires = new Map<string, string[]>([
    ['source', []],
    ['local-check', ['source']],
    ['feature-review', ['local-check']],
    ['release-merge', ['feature-review']],
    ['main-promotion', ['release-merge']],
  ]);
  const seen = new Set<string>();
  for (const step of fixture.journey.steps) {
    assert.equal(seen.has(step.id), false, `duplicate lifecycle step: ${step.id}`);
    assert.deepEqual(step.requires, expectedRequires.get(step.id));
    for (const dependency of step.requires) assert.ok(seen.has(dependency));
    seen.add(step.id);
    assertTiming(step);
    if (step.status === 'passed') {
      assert.deepEqual(Object.keys(step.artifact).sort(), [
        'object_id',
        'object_type',
        'project',
        'source_type',
      ]);
      assert.ok(Object.values(step.artifact).every(Boolean));
    }
  }
  assert.deepEqual([...seen], [
    'source',
    'local-check',
    'feature-review',
    'release-merge',
    'main-promotion',
  ]);
  const promotion = fixture.journey.steps.at(-1);
  assert.equal(promotion.status, 'blocked');
  assert.equal(promotion.artifact, null);
  assert.match(promotion.reason, /human-only/);
});

test('outcomes retain evidence boundaries and unresolved state selects broad checks', () => {
  const outcomes = Object.fromEntries(
    (fixture.outcome_examples as Outcome[]).map((value) => [value.id, value]),
  ) as Record<string, Outcome>;
  assert.deepEqual(
    new Set(Object.values(outcomes).map((value) => value.status)),
    new Set(['failed', 'skipped', 'unknown', 'stale']),
  );
  for (const value of Object.values(outcomes)) {
    assertTiming(value);
    if (['failed', 'stale'].includes(value.status)) assert.ok(value.artifact);
    if (['skipped', 'unknown'].includes(value.status))
      assert.equal(value.artifact, null);
  }

  assert.deepEqual(
    new Set(fixture.deterministic_selection.checks),
    new Set([
      'authorization',
      'contract',
      'migration',
      'persistence',
      'recovery',
      'tenant',
    ]),
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
